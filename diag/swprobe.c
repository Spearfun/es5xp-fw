/*
 * swprobe - probe of the "switch" netlink interface of the vendor kernel (ES-5XP, AR8327), read only.
 * Purpose: find out the attribute numbers and types the vendor kernel actually uses (the vendor swconfig
 * prints the type "blob" and attribute descriptions, the OpenWrt v25.12 one prints "unknown" and "(null)").
 * Only read requests are made: GETFAMILY, GETPOLICY (nlctrl), GET_SWITCH, LIST_*, four GETs.
 * Nothing is ever written to the switch. libc and the kernel headers only, no libnl.
 *
 * Build:              mips-openwrt-linux-musl-gcc -Os -Wall -Wextra -o swprobe swprobe.c
 * Run on the switch:   ./swprobe [switch_name]              (switch1 by default)
 * Check on a PC:       ./swprobe -f nlctrl                  (GETFAMILY/GETPOLICY only)
 */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <linux/netlink.h>
#include <linux/genetlink.h>

/* the numbers of OpenWrt v25.12 (uapi/linux/switch.h); this probe checks them */
enum { SW_CMD_GET_SWITCH = 1, SW_CMD_LIST_GLOBAL = 3, SW_CMD_GET_GLOBAL = 4, SW_CMD_LIST_PORT = 6,
       SW_CMD_GET_PORT = 7, SW_CMD_LIST_VLAN = 9, SW_CMD_GET_VLAN = 10 };
enum { SW_ATTR_ID = 2, SW_ATTR_OP_ID = 10, SW_ATTR_OP_TYPE = 11, SW_ATTR_OP_NAME = 12,
       SW_ATTR_OP_PORT = 13, SW_ATTR_OP_VLAN = 14 };

static int sk = -1;
static uint32_t seq = 1;

struct msgbuf { unsigned char b[1024]; size_t len; };

static void put_hdr(struct msgbuf *m, uint16_t type, uint16_t flags, uint8_t cmd, uint8_t ver)
{
    struct nlmsghdr *h = (struct nlmsghdr *)m->b;
    struct genlmsghdr *g;
    memset(m, 0, sizeof(*m));
    h->nlmsg_type = type;
    h->nlmsg_flags = NLM_F_REQUEST | flags;
    h->nlmsg_seq = seq++;
    g = (struct genlmsghdr *)NLMSG_DATA(h);
    g->cmd = cmd;
    g->version = ver;
    m->len = NLMSG_LENGTH(GENL_HDRLEN);
}

static void put_attr(struct msgbuf *m, uint16_t type, const void *data, size_t len)
{
    struct nlattr *a = (struct nlattr *)(m->b + m->len);
    a->nla_type = type;
    a->nla_len = NLA_HDRLEN + len;
    memcpy((unsigned char *)a + NLA_HDRLEN, data, len);
    m->len += NLA_ALIGN(a->nla_len);
}

static void put_u32(struct msgbuf *m, uint16_t type, uint32_t v) { put_attr(m, type, &v, 4); }
static void put_str(struct msgbuf *m, uint16_t type, const char *s) { put_attr(m, type, s, strlen(s) + 1); }

typedef void (*msg_cb)(struct nlmsghdr *h, void *arg);

/* send, then read the replies until NLMSG_DONE (dump) or until the ack (doit); return 0 or -errno */
static int talk(struct msgbuf *m, int dump, msg_cb cb, void *arg)
{
    static unsigned char rb[65536];
    struct nlmsghdr *h = (struct nlmsghdr *)m->b;
    uint32_t myseq = h->nlmsg_seq;
    h->nlmsg_len = m->len;
    if (send(sk, m->b, m->len, 0) < 0) return -errno;
    for (;;) {
        ssize_t n = recv(sk, rb, sizeof(rb), 0);
        if (n < 0) { if (errno == EINTR) continue; return -errno; }
        for (struct nlmsghdr *r = (struct nlmsghdr *)rb; NLMSG_OK(r, (size_t)n); r = NLMSG_NEXT(r, n)) {
            if (r->nlmsg_seq != myseq) continue;
            if (r->nlmsg_type == NLMSG_DONE) return 0;
            if (r->nlmsg_type == NLMSG_ERROR) {
                struct nlmsgerr *e = (struct nlmsgerr *)NLMSG_DATA(r);
                return e->error;            /* 0 = ack */
            }
            if (cb) cb(r, arg);
            if (!dump && !(r->nlmsg_flags & NLM_F_MULTI) && !(h->nlmsg_flags & NLM_F_ACK)) return 0;
        }
    }
}

static const char *nltype(uint32_t t)
{
    static const char *n[] = { "invalid", "flag", "u8", "u16", "u32", "u64", "s8", "s16", "s32", "s64",
                               "binary", "string", "nul-string", "nested", "nested-array", "bitfield32",
                               "sint", "uint" };
    return t < sizeof(n) / sizeof(n[0]) ? n[t] : "?";
}

/* print the attributes: number, length, value (u32 / string / nested / bytes) */
static void dump_attrs(const unsigned char *p, int len, int depth)
{
    while (len >= NLA_HDRLEN) {
        const struct nlattr *a = (const struct nlattr *)p;
        int alen = a->nla_len, plen = alen - NLA_HDRLEN, t = a->nla_type & NLA_TYPE_MASK;
        const unsigned char *d = p + NLA_HDRLEN;
        if (alen < NLA_HDRLEN || alen > len) break;
        printf("%*s[%d] len=%d", depth * 2, "", t, plen);
        if (a->nla_type & NLA_F_NESTED) {
            printf(" nested\n");
            dump_attrs(d, plen, depth + 1);
        } else if (plen == 0) {
            printf(" flag\n");
        } else {
            int str = d[plen - 1] == 0 && plen > 1;
            for (int i = 0; str && i < plen - 1; i++) if (d[i] < 0x20 || d[i] > 0x7e) str = 0;
            if (str) printf(" \"%s\"", (const char *)d);
            if (plen == 4) { uint32_t v; memcpy(&v, d, 4); printf(" u32=%u (0x%x)", v, v); }
            if (plen == 2) { uint16_t v; memcpy(&v, d, 2); printf(" u16=%u", v); }
            if (plen == 1) printf(" u8=%u", d[0]);
            if (!str && plen != 4 && plen != 2 && plen != 1) { printf(" hex="); for (int i = 0; i < plen && i < 24; i++) printf("%02x", d[i]); if (plen > 24) printf("..."); }
            printf("\n");
        }
        len -= NLA_ALIGN(alen); p += NLA_ALIGN(alen);
    }
}

static const unsigned char *gattrs(struct nlmsghdr *h, int *len)
{
    *len = h->nlmsg_len - NLMSG_LENGTH(GENL_HDRLEN);
    return (const unsigned char *)NLMSG_DATA(h) + GENL_HDRLEN;
}

static const struct nlattr *find(const unsigned char *p, int len, int type)
{
    while (len >= NLA_HDRLEN) {
        const struct nlattr *a = (const struct nlattr *)p;
        if (a->nla_len < NLA_HDRLEN || a->nla_len > len) return NULL;
        if ((a->nla_type & NLA_TYPE_MASK) == type) return a;
        len -= NLA_ALIGN(a->nla_len); p += NLA_ALIGN(a->nla_len);
    }
    return NULL;
}

/* ---- nlctrl ---- */
struct fam { uint16_t id; uint32_t ver, hdr, maxattr; };

static void fam_cb(struct nlmsghdr *h, void *arg)
{
    struct fam *f = arg;
    int len; const unsigned char *p = gattrs(h, &len);
    const struct nlattr *a;
    printf("GETFAMILY:\n");
    dump_attrs(p, len, 1);
    if ((a = find(p, len, CTRL_ATTR_FAMILY_ID))) memcpy(&f->id, (const char *)a + NLA_HDRLEN, 2);
    if ((a = find(p, len, CTRL_ATTR_VERSION))) memcpy(&f->ver, (const char *)a + NLA_HDRLEN, 4);
    if ((a = find(p, len, CTRL_ATTR_HDRSIZE))) memcpy(&f->hdr, (const char *)a + NLA_HDRLEN, 4);
    if ((a = find(p, len, CTRL_ATTR_MAXATTR))) memcpy(&f->maxattr, (const char *)a + NLA_HDRLEN, 4);
}

/* policy: CTRL_ATTR_POLICY { [policy] { [attr] { NL_POLICY_TYPE_ATTR_TYPE, ... } } }, one line per attribute */
static void pol_cb(struct nlmsghdr *h, void *arg)
{
    (void)arg;
    int len; const unsigned char *p = gattrs(h, &len);
    const struct nlattr *pol = find(p, len, CTRL_ATTR_POLICY);
    const struct nlattr *op = find(p, len, CTRL_ATTR_OP_POLICY);
    if (pol) {
        const unsigned char *q = (const unsigned char *)pol + NLA_HDRLEN; int ql = pol->nla_len - NLA_HDRLEN;
        while (ql >= NLA_HDRLEN) {                         /* [policy index] */
            const struct nlattr *pi = (const struct nlattr *)q;
            const unsigned char *r = q + NLA_HDRLEN; int rl = pi->nla_len - NLA_HDRLEN;
            while (rl >= NLA_HDRLEN) {                     /* [attr index] */
                const struct nlattr *ai = (const struct nlattr *)r;
                const struct nlattr *ty = find(r + NLA_HDRLEN, ai->nla_len - NLA_HDRLEN, NL_POLICY_TYPE_ATTR_TYPE);
                uint32_t t = 0;
                if (ty) memcpy(&t, (const char *)ty + NLA_HDRLEN, 4);
                printf("  policy %d attr %2d: %s\n", pi->nla_type & NLA_TYPE_MASK, ai->nla_type & NLA_TYPE_MASK, nltype(t));
                rl -= NLA_ALIGN(ai->nla_len); r += NLA_ALIGN(ai->nla_len);
            }
            ql -= NLA_ALIGN(pi->nla_len); q += NLA_ALIGN(pi->nla_len);
        }
    }
    if (op) { printf("  op-policy:\n"); dump_attrs((const unsigned char *)op + NLA_HDRLEN, op->nla_len - NLA_HDRLEN, 2); }
}

/* ---- switch ---- */
struct swfind { const char *name; int found; uint32_t id; };

static void sw_cb(struct nlmsghdr *h, void *arg)
{
    struct swfind *s = arg;
    int len; const unsigned char *p = gattrs(h, &len);
    printf("GET_SWITCH (cmd %u):\n", ((struct genlmsghdr *)NLMSG_DATA(h))->cmd);
    dump_attrs(p, len, 1);
    /* id = attribute 2 (as in OpenWrt) of the message whose strings contain the device name */
    for (const unsigned char *q = p; len >= NLA_HDRLEN; ) {
        const struct nlattr *a = (const struct nlattr *)q;
        if (a->nla_len < NLA_HDRLEN || a->nla_len > len) break;
        if (a->nla_len - NLA_HDRLEN == (int)strlen(s->name) + 1 && !strcmp((const char *)a + NLA_HDRLEN, s->name)) {
            const struct nlattr *id = find(p, h->nlmsg_len - NLMSG_LENGTH(GENL_HDRLEN), SW_ATTR_ID);
            if (id) { memcpy(&s->id, (const char *)id + NLA_HDRLEN, 4); s->found = 1; }
        }
        len -= NLA_ALIGN(a->nla_len); q += NLA_ALIGN(a->nla_len);
    }
}

struct opent { char name[40]; uint32_t id, type; };
struct oplist { int n; struct opent e[64]; };

static void list_cb(struct nlmsghdr *h, void *arg)
{
    struct oplist *l = arg;
    int len; const unsigned char *p = gattrs(h, &len);
    const struct nlattr *a;
    printf(" (cmd %u)", ((struct genlmsghdr *)NLMSG_DATA(h))->cmd);
    for (const unsigned char *q = p; len >= NLA_HDRLEN; ) {
        const struct nlattr *x = (const struct nlattr *)q;
        int pl = x->nla_len - NLA_HDRLEN;
        if (x->nla_len < NLA_HDRLEN || x->nla_len > len) break;
        if (pl == 4) { uint32_t v; memcpy(&v, (const char *)x + NLA_HDRLEN, 4); printf(" %d=%u", x->nla_type & NLA_TYPE_MASK, v); }
        else printf(" %d='%.*s'", x->nla_type & NLA_TYPE_MASK, pl > 0 ? pl - 1 : 0, (const char *)x + NLA_HDRLEN);
        len -= NLA_ALIGN(x->nla_len); q += NLA_ALIGN(x->nla_len);
    }
    printf("\n");
    p = gattrs(h, &len);
    if (l->n < 64 && (a = find(p, len, SW_ATTR_OP_NAME))) {
        struct opent *e = &l->e[l->n++];
        snprintf(e->name, sizeof(e->name), "%s", (const char *)a + NLA_HDRLEN);
        if ((a = find(p, len, SW_ATTR_OP_ID))) memcpy(&e->id, (const char *)a + NLA_HDRLEN, 4);
        if ((a = find(p, len, SW_ATTR_OP_TYPE))) memcpy(&e->type, (const char *)a + NLA_HDRLEN, 4);
    }
}

static void get_cb(struct nlmsghdr *h, void *arg)
{
    (void)arg;
    int len; const unsigned char *p = gattrs(h, &len);
    printf("  reply (cmd %u):\n", ((struct genlmsghdr *)NLMSG_DATA(h))->cmd);
    dump_attrs(p, len, 2);
}

static int lookup(struct oplist *l, const char *name, uint32_t *id)
{
    for (int i = 0; i < l->n; i++) if (!strcmp(l->e[i].name, name)) { *id = l->e[i].id; return 1; }
    return 0;
}

static void do_get(uint16_t fid, uint32_t swid, int cmd, int pv_attr, uint32_t pv, struct oplist *l, const char *name)
{
    struct msgbuf m; uint32_t opid; int rc;
    if (!lookup(l, name, &opid)) { printf("GET %s: not in the list\n", name); return; }
    put_hdr(&m, fid, NLM_F_ACK, cmd, 0);
    put_u32(&m, SW_ATTR_ID, swid);
    put_u32(&m, SW_ATTR_OP_ID, opid);
    if (pv_attr) put_u32(&m, pv_attr, pv);
    printf("GET cmd %d %s (op %u)%s%u:\n", cmd, name, opid, pv_attr == SW_ATTR_OP_PORT ? " port " : pv_attr ? " vlan " : "", pv_attr ? pv : 0);
    rc = talk(&m, 0, get_cb, NULL);
    printf("  rc=%d%s%s\n", rc, rc ? " " : "", rc ? strerror(-rc) : "");
}

int main(int argc, char **argv)
{
    const char *famname = "switch", *dev = "switch1";
    struct sockaddr_nl sa = { .nl_family = AF_NETLINK };
    struct msgbuf m;
    struct fam f = { 0, 0, 0, 0 };
    int rc;

    if (argc > 2 && !strcmp(argv[1], "-f")) famname = argv[2];
    else if (argc > 1) dev = argv[1];

    sk = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_GENERIC);
    if (sk < 0 || bind(sk, (struct sockaddr *)&sa, sizeof(sa)) < 0) { perror("netlink"); return 1; }

    put_hdr(&m, GENL_ID_CTRL, NLM_F_ACK, CTRL_CMD_GETFAMILY, 1);
    put_str(&m, CTRL_ATTR_FAMILY_NAME, famname);
    rc = talk(&m, 0, fam_cb, &f);
    printf("GETFAMILY %s: rc=%d id=%u version=%u hdrsize=%u maxattr=%u\n", famname, rc, f.id, f.ver, f.hdr, f.maxattr);
    if (rc || !f.id) return 1;

    put_hdr(&m, GENL_ID_CTRL, NLM_F_DUMP, CTRL_CMD_GETPOLICY, 1);
    put_attr(&m, CTRL_ATTR_FAMILY_ID, &f.id, 2);
    printf("GETPOLICY:\n");
    rc = talk(&m, 1, pol_cb, NULL);
    printf("GETPOLICY rc=%d%s%s\n", rc, rc ? " " : "", rc ? strerror(-rc) : "");

    if (strcmp(famname, "switch")) return 0;

    struct swfind s = { dev, 0, 0 };
    put_hdr(&m, f.id, NLM_F_DUMP, SW_CMD_GET_SWITCH, 0);
    rc = talk(&m, 1, sw_cb, &s);
    printf("GET_SWITCH rc=%d; %s: %s id=%u\n", rc, dev, s.found ? "found," : "NOT found", s.id);
    if (!s.found) return 1;

    static struct oplist lg, lp, lv;
    const struct { int cmd; const char *nm; struct oplist *l; } L[] = {
        { SW_CMD_LIST_GLOBAL, "LIST_GLOBAL", &lg }, { SW_CMD_LIST_PORT, "LIST_PORT", &lp }, { SW_CMD_LIST_VLAN, "LIST_VLAN", &lv } };
    for (int i = 0; i < 3; i++) {
        printf("%s:\n", L[i].nm);
        put_hdr(&m, f.id, NLM_F_ACK, L[i].cmd, 0);
        put_u32(&m, SW_ATTR_ID, s.id);
        rc = talk(&m, 0, list_cb, L[i].l);
        printf("%s rc=%d, %d entries\n", L[i].nm, rc, L[i].l->n);
    }

    do_get(f.id, s.id, SW_CMD_GET_GLOBAL, 0, 0, &lg, "enable_vlan");
    do_get(f.id, s.id, SW_CMD_GET_PORT, SW_ATTR_OP_PORT, 1, &lp, "pvid");
    do_get(f.id, s.id, SW_CMD_GET_PORT, SW_ATTR_OP_PORT, 1, &lp, "link");
    do_get(f.id, s.id, SW_CMD_GET_VLAN, SW_ATTR_OP_VLAN, 1, &lv, "ports");
    close(sk);
    return 0;
}
