/*
 * swbatch - batch client of the kernel "switch" netlink interface (swconfig) for ES-5XP (AR8327).
 * One process runs, in order, many commands of the form
 *     dev <dev> [port <N>|vlan <N>] set <key> [<value>]
 *     dev <dev> [port <N>|vlan <N>] get <key>
 * with the same value parsing as the vendor swconfig (OpenWrt swlib/cli) and with the attribute
 * numbers of the vendor kernel (found with swprobe, see diag/).
 * Only libc and kernel headers (no libnl, libuci, libubox).
 *
 * Input (stdin): one command per line; every argument ends with byte 0x1F, a line ends with '\n'
 * (as the ash builtin writes it:  printf '%s\037' "$@"; echo).
 *
 * link values as the vendor swconfig sends them (taken from captures of its requests): the LINK nest
 * starts with the LINK flag ("port enabled") when the value string is not empty; an empty string
 * ('' - port disabled) has no flag. Without the flag the vendor kernel disables the port.
 * Attribute order as the vendor: LINK, DUPLEX, ANEG, SPEED.
 *
 * Difference from swconfig: integers (int values, port/vlan numbers, speed in link) must be a whole
 * signed decimal number, -2147483648..4294967295; anything else is a line error (swconfig uses atoi:
 * "0x30" -> 0, i.e. a write to register/port 0).
 *
 * Options:  -n  dry run (set is not sent, get is done)
 *           -v  print every command that is run
 * Exit code: 0 - all lines succeeded; 1 - some lines failed; 2 - no netlink / no "switch" family
 * or no device list (nothing written).
 *
 * Derived from the OpenWrt swconfig package (value parsing and output):
 *   src/cli.c   Copyright (C) 2008 Felix Fietkau <nbd@nbd.name>, (C) 2010 Martin Mares <mj@ucw.cz>; GPL-2.0-only
 *   src/swlib.c Copyright (C) 2008 Felix Fietkau <nbd@nbd.name>; LGPL-2.1-only
 * and distributed, as the combined work, under the GNU General Public License version 2 (see LICENSE).
 *
 * SPDX-License-Identifier: GPL-2.0-only
 */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <unistd.h>
#include <sys/socket.h>
#include <linux/netlink.h>
#include <linux/genetlink.h>

/* ---- vendor kernel ABI (found with swprobe) ---- */
enum { CMD_GET_SWITCH = 1, CMD_LIST_GLOBAL = 3, CMD_GET_GLOBAL = 4, CMD_SET_GLOBAL = 5,
       CMD_LIST_PORT = 6, CMD_GET_PORT = 7, CMD_SET_PORT = 8,
       CMD_LIST_VLAN = 9, CMD_GET_VLAN = 10, CMD_SET_VLAN = 11 };
enum { A_ID = 2, A_DEV_NAME = 3, A_ALIAS = 4, A_NAME = 5, A_VLANS = 6, A_PORTS = 7, A_CPU_PORT = 9,
       A_OP_ID = 10, A_OP_TYPE = 11, A_OP_NAME = 12, A_OP_PORT = 13, A_OP_VLAN = 14,
       A_VAL_INT = 15, A_VAL_STR = 16, A_VAL_PORTS = 17, A_VAL_LINK = 18, A_VAL_BLOB = 19,
       A_PORT = 22 };                        /* vendor: description 21, port list element 22 */
enum { T_INT = 1, T_STRING = 2, T_PORTS = 3, T_LINK = 4, T_NOVAL = 5, T_BLOB = 6 };
enum { P_ID = 1, P_TAGGED = 2 };
enum { L_LINK = 1, L_DUPLEX = 2, L_ANEG = 3, L_TXFLOW = 4, L_RXFLOW = 5, L_SPEED = 6,
       L_EEE100 = 7, L_EEE1000 = 8 };
enum { G_GLOBAL, G_PORT, G_VLAN };

static const int LISTCMD[3] = { CMD_LIST_GLOBAL, CMD_LIST_PORT, CMD_LIST_VLAN };
static const int GETCMD[3]  = { CMD_GET_GLOBAL, CMD_GET_PORT, CMD_GET_VLAN };
static const int SETCMD[3]  = { CMD_SET_GLOBAL, CMD_SET_PORT, CMD_SET_VLAN };

struct attr { char *name; uint32_t id, type; };
struct dev {
    char *devname, *alias, *name;
    uint32_t id, ports, vlans, cpu;
    int scanned;
    int n[3];
    struct attr *a[3];
    struct dev *next;
};

static int sk = -1;
static uint16_t famid;
static uint32_t seq = 1;
static struct dev *devs;
static int dry, verbose;
static long lineno;

/* ---- netlink messages ---- */
struct msg { uint32_t w[1024]; size_t len; };          /* 4 KiB, aligned to 4 */
#define MB(m) ((unsigned char *)(m)->w)

static void m_init(struct msg *m, uint16_t type, uint16_t flags, uint8_t cmd, uint8_t ver)
{
    struct nlmsghdr *h = (struct nlmsghdr *)MB(m);
    struct genlmsghdr *g = (struct genlmsghdr *)NLMSG_DATA(h);
    memset(MB(m), 0, NLMSG_LENGTH(GENL_HDRLEN));
    h->nlmsg_type = type;
    h->nlmsg_flags = NLM_F_REQUEST | flags;
    h->nlmsg_seq = seq++;
    g->cmd = cmd;
    g->version = ver;
    m->len = NLMSG_LENGTH(GENL_HDRLEN);
}

static int m_put(struct msg *m, uint16_t type, const void *data, size_t len)
{
    struct nlattr *a;
    if (m->len + NLA_ALIGN(NLA_HDRLEN + len) > sizeof(m->w)) return -1;
    a = (struct nlattr *)(MB(m) + m->len);
    a->nla_type = type;
    a->nla_len = NLA_HDRLEN + len;
    if (len) memcpy((unsigned char *)a + NLA_HDRLEN, data, len);
    memset((unsigned char *)a + NLA_HDRLEN + len, 0, NLA_ALIGN(a->nla_len) - a->nla_len);
    m->len += NLA_ALIGN(a->nla_len);
    return 0;
}
static int m_u32(struct msg *m, uint16_t type, uint32_t v) { return m_put(m, type, &v, 4); }
static int m_str(struct msg *m, uint16_t type, const char *s) { return m_put(m, type, s, strlen(s) + 1); }
static int m_nest(struct msg *m, uint16_t type)          /* offset of the nest start or -1 */
{
    size_t off = m->len;
    if (m_put(m, type | NLA_F_NESTED, NULL, 0) < 0) return -1;
    return (int)off;
}
static void m_nest_end(struct msg *m, int off)
{
    struct nlattr *a = (struct nlattr *)(MB(m) + off);
    a->nla_len = m->len - off;
}

/* ---- attribute parsing ---- */
#define TBMAX 32
static void parse(const unsigned char *p, int len, const struct nlattr **tb)
{
    memset(tb, 0, sizeof(*tb) * TBMAX);
    while (len >= NLA_HDRLEN) {
        const struct nlattr *a = (const struct nlattr *)p;
        int t = a->nla_type & NLA_TYPE_MASK;
        if (a->nla_len < NLA_HDRLEN || a->nla_len > len) break;
        if (t < TBMAX) tb[t] = a;
        len -= NLA_ALIGN(a->nla_len);
        p += NLA_ALIGN(a->nla_len);
    }
}
static const unsigned char *pl(const struct nlattr *a) { return (const unsigned char *)a + NLA_HDRLEN; }
static int plen(const struct nlattr *a) { return a->nla_len - NLA_HDRLEN; }
static uint32_t u32(const struct nlattr *a) { uint32_t v = 0; if (a && plen(a) >= 4) memcpy(&v, pl(a), 4); return v; }
static const char *str(const struct nlattr *a) { return (a && plen(a) > 0 && pl(a)[plen(a) - 1] == 0) ? (const char *)pl(a) : NULL; }

typedef void (*cb_t)(const struct nlattr **tb, void *arg);

/* send a request; replies (except control ones) go to cb; dump - until NLMSG_DONE, otherwise until the ack.
 * Returns 0 or -errno. */
static int talk(struct msg *m, int dump, cb_t cb, void *arg)
{
    static uint32_t rb[16384];                           /* 64 KiB */
    struct nlmsghdr *h = (struct nlmsghdr *)MB(m);
    uint32_t myseq = h->nlmsg_seq;
    if (!dump) h->nlmsg_flags |= NLM_F_ACK;
    h->nlmsg_len = m->len;
    if (send(sk, MB(m), m->len, 0) < 0) return -errno;
    for (;;) {
        ssize_t n = recv(sk, rb, sizeof(rb), 0);
        if (n < 0) { if (errno == EINTR) continue; return -errno; }
        for (struct nlmsghdr *r = (struct nlmsghdr *)rb; NLMSG_OK(r, (size_t)n); r = NLMSG_NEXT(r, n)) {
            if (r->nlmsg_seq != myseq) continue;         /* leftovers of earlier requests */
            if (r->nlmsg_type == NLMSG_DONE) return 0;
            if (r->nlmsg_type == NLMSG_ERROR) return ((struct nlmsgerr *)NLMSG_DATA(r))->error;
            if (cb && r->nlmsg_len >= NLMSG_LENGTH(GENL_HDRLEN)) {
                const struct nlattr *tb[TBMAX];
                parse((const unsigned char *)NLMSG_DATA(r) + GENL_HDRLEN,
                      r->nlmsg_len - NLMSG_LENGTH(GENL_HDRLEN), tb);
                cb(tb, arg);
            }
        }
    }
}

/* ---- family, devices, attributes ---- */
static void fam_cb(const struct nlattr **tb, void *arg)
{
    (void)arg;
    if (tb[CTRL_ATTR_FAMILY_ID] && plen(tb[CTRL_ATTR_FAMILY_ID]) >= 2) memcpy(&famid, pl(tb[CTRL_ATTR_FAMILY_ID]), 2);
}

static char *dupstr(const char *s) { return strdup(s ? s : ""); }

static void sw_cb(const struct nlattr **tb, void *arg)
{
    struct dev *d, ***tail = arg;                         /* *tail - where the next one goes */
    if (!str(tb[A_DEV_NAME])) return;
    d = calloc(1, sizeof(*d));
    if (!d) return;
    d->devname = dupstr(str(tb[A_DEV_NAME]));
    d->alias = dupstr(str(tb[A_ALIAS]));
    d->name = dupstr(str(tb[A_NAME]));
    d->id = u32(tb[A_ID]);
    d->ports = u32(tb[A_PORTS]);
    d->vlans = u32(tb[A_VLANS]);
    d->cpu = u32(tb[A_CPU_PORT]);
    **tail = d;
    *tail = &d->next;
}

static int init(void)
{
    struct sockaddr_nl sa = { .nl_family = AF_NETLINK };
    struct msg m;
    struct dev **tail = &devs;
    int rc;

    sk = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_GENERIC);
    if (sk < 0 || bind(sk, (struct sockaddr *)&sa, sizeof(sa)) < 0) {
        fprintf(stderr, "swbatch: netlink: %s\n", strerror(errno));
        return -1;
    }
    m_init(&m, GENL_ID_CTRL, 0, CTRL_CMD_GETFAMILY, 1);
    m_str(&m, CTRL_ATTR_FAMILY_NAME, "switch");
    rc = talk(&m, 0, fam_cb, NULL);
    if (rc || !famid) {
        fprintf(stderr, "swbatch: netlink family \"switch\" not found (%s)\n", rc ? strerror(-rc) : "no id");
        return -1;
    }
    m_init(&m, famid, NLM_F_DUMP, CMD_GET_SWITCH, 0);
    rc = talk(&m, 1, sw_cb, &tail);
    if (rc || !devs) {
        fprintf(stderr, "swbatch: no device list (%s)\n", rc ? strerror(-rc) : "empty");
        return -1;
    }
    return 0;
}

struct listarg { struct dev *d; int g; int cap; };

static void list_cb(const struct nlattr **tb, void *arg)
{
    struct listarg *la = arg;
    struct dev *d = la->d;
    int g = la->g;
    if (!str(tb[A_OP_NAME]) || !tb[A_OP_ID]) return;
    if (d->n[g] == la->cap) {
        int cap = la->cap ? la->cap * 2 : 32;
        struct attr *na = realloc(d->a[g], cap * sizeof(*na));
        if (!na) return;
        d->a[g] = na;
        la->cap = cap;
    }
    d->a[g][d->n[g]].name = dupstr(str(tb[A_OP_NAME]));
    d->a[g][d->n[g]].id = u32(tb[A_OP_ID]);
    d->a[g][d->n[g]].type = u32(tb[A_OP_TYPE]);
    d->n[g]++;
}

static struct dev *find_dev(const char *name)
{
    for (struct dev *d = devs; d; d = d->next) {
        if (strcmp(name, d->devname) && strcmp(name, d->alias)) continue;
        if (!d->scanned) {                           /* as swlib_scan: the three lists once */
            for (int g = 0; g < 3; g++) {
                struct msg m;
                struct listarg la = { d, g, 0 };
                int rc;
                m_init(&m, famid, 0, LISTCMD[g], 0);
                m_u32(&m, A_ID, d->id);
                rc = talk(&m, 0, list_cb, &la);
                if (rc) fprintf(stderr, "swbatch: line %ld: attribute list of %s: %s\n", lineno, d->devname, strerror(-rc));
            }
            d->scanned = 1;
        }
        return d;
    }
    return NULL;
}

static const struct attr *find_attr(struct dev *d, int g, const char *key)
{
    for (int i = 0; i < d->n[g]; i++) if (!strcmp(d->a[g][i].name, key)) return &d->a[g][i];
    return NULL;
}

/* ---- integers: a whole signed decimal number, -2147483648..4294967295 -> 32-bit pattern ---- */
static int parse_int(const char *s, int32_t *out)
{
    const char *p = s;
    int neg = 0;
    uint64_t v = 0;
    if (!s || !*s) return -1;
    if (*p == '+' || *p == '-') neg = (*p++ == '-');
    if (!*p) return -1;
    for (; *p; p++) {
        if (*p < '0' || *p > '9') return -1;
        v = v * 10 + (uint64_t)(*p - '0');
        if (v > 4294967295ULL) return -1;
    }
    if (neg) {
        if (v > 2147483648ULL) return -1;
        *out = (int32_t)(uint32_t)(0u - (uint32_t)v);
    } else {
        *out = (int32_t)(uint32_t)v;
    }
    return 0;
}

static int parse_index(const char *s, int32_t *out)   /* port/VLAN number: integer >= 0 */
{
    return (parse_int(s, out) < 0 || *out < 0) ? -1 : 0;
}

/* ---- set values ---- */
static const char *type_name(uint32_t t)
{
    switch (t) { case T_INT: return "int"; case T_STRING: return "string"; case T_PORTS: return "ports";
                 case T_LINK: return "link"; case T_NOVAL: return "none"; case T_BLOB: return "blob"; }
    return "unknown";
}

/* builds the value in m; 1 - send nothing (noval "0"), 0 - ready, -1 - line error */
static int put_value(struct msg *m, const struct dev *d, const struct attr *a, const char *val)
{
    int32_t iv;
    switch (a->type) {
    case T_NOVAL:
        if (val && !strcmp(val, "0")) return 1;           /* as swlib: "set <noval> 0" does nothing */
        return 0;
    case T_INT:
        if (parse_int(val, &iv) < 0) {
            fprintf(stderr, "swbatch: line %ld: bad integer \"%s\" for %s\n", lineno, val, a->name);
            return -1;
        }
        return m_u32(m, A_VAL_INT, (uint32_t)iv);
    case T_STRING:
        return m_str(m, A_VAL_STR, val);
    case T_PORTS: {                                       /* as swlib_set_attr_string */
        const char *p = val;
        uint32_t cnt = 0;
        int nest = -1;
        while (p && *p) {
            char *e;
            unsigned long id;
            int tagged = 0, pn;
            while (*p && isspace((unsigned char)*p)) p++;
            if (!*p) break;
            if (!isdigit((unsigned char)*p) || cnt >= d->ports) goto bad_ports;
            id = strtoul(p, &e, 10);
            p = e;
            while (*p && !isspace((unsigned char)*p)) {
                if (*p != 't') goto bad_ports;
                tagged = 1;
                p++;
            }
            if (*p) p++;
            if (nest < 0 && (nest = m_nest(m, A_VAL_PORTS)) < 0) return -1;
            if ((pn = m_nest(m, A_PORT)) < 0 || m_u32(m, P_ID, (uint32_t)id) < 0) return -1;
            if (tagged && m_put(m, P_TAGGED, NULL, 0) < 0) return -1;
            m_nest_end(m, pn);
            cnt++;
        }
        if (nest >= 0) m_nest_end(m, nest);               /* empty list - no value attribute */
        return 0;
bad_ports:
        fprintf(stderr, "swbatch: line %ld: Failed to set attribute (ports \"%s\")\n", lineno, val);
        return -1;
    }
    case T_LINK: {                                        /* as swlib: strtok on spaces */
        enum { C_NONE, C_DUPLEX, C_ANEG, C_SPEED } cmd = C_NONE;
        int duplex = 0, aneg = 0, nest;
        int32_t speed = 0;
        char *buf = strdup(val), *save = NULL;
        if (!buf) return -1;
        for (char *t = strtok_r(buf, " ", &save); t; t = strtok_r(NULL, " ", &save)) {
            switch (cmd) {
            case C_NONE:
                if (!strcmp(t, "duplex")) cmd = C_DUPLEX;
                else if (!strcmp(t, "autoneg")) cmd = C_ANEG;
                else if (!strcmp(t, "speed")) cmd = C_SPEED;
                else fprintf(stderr, "swbatch: line %ld: Unsupported option %s\n", lineno, t);
                break;
            case C_DUPLEX:
                if (!strcmp(t, "half")) duplex = 0;
                else if (!strcmp(t, "full")) duplex = 1;
                else fprintf(stderr, "swbatch: line %ld: Unsupported value %s\n", lineno, t);
                cmd = C_NONE;
                break;
            case C_ANEG:
                if (!strcmp(t, "on")) aneg = 1;
                else if (!strcmp(t, "off")) aneg = 0;
                else fprintf(stderr, "swbatch: line %ld: Unsupported value %s\n", lineno, t);
                cmd = C_NONE;
                break;
            case C_SPEED:
                if (parse_int(t, &speed) < 0) {
                    fprintf(stderr, "swbatch: line %ld: bad integer \"%s\" for speed\n", lineno, t);
                    free(buf);
                    return -1;
                }
                cmd = C_NONE;
                break;
            }
        }
        free(buf);
        if ((nest = m_nest(m, A_VAL_LINK)) < 0) return -1;
        if (*val && m_put(m, L_LINK, NULL, 0) < 0) return -1;      /* as the vendor: a non-empty string - port enabled */
        if (duplex && m_put(m, L_DUPLEX, NULL, 0) < 0) return -1;
        if (aneg && m_put(m, L_ANEG, NULL, 0) < 0) return -1;
        if (m_u32(m, L_SPEED, (uint32_t)speed) < 0) return -1;   /* always: the kernel reads it unchecked */
        m_nest_end(m, nest);
        return 0;
    }
    default:
        fprintf(stderr, "swbatch: line %ld: Failed to set attribute (type %s not supported)\n", lineno, type_name(a->type));
        return -1;
    }
}

/* ---- get values (output as swconfig cli.c) ---- */
struct getarg { const struct attr *a; int32_t pv; int got; };

static const char *speed_str(uint32_t s)
{
    return s == 10 ? "10baseT" : s == 100 ? "100baseT" : s == 1000 ? "1000baseT" : "unknown";
}

static void get_cb(const struct nlattr **tb, void *arg)
{
    struct getarg *ga = arg;
    if (tb[A_VAL_INT]) { printf("%d", (int32_t)u32(tb[A_VAL_INT])); ga->got = 1; }
    else if (tb[A_VAL_STR]) { printf("%s", str(tb[A_VAL_STR]) ? str(tb[A_VAL_STR]) : ""); ga->got = 1; }
    else if (tb[A_VAL_PORTS]) {
        const unsigned char *p = pl(tb[A_VAL_PORTS]);
        int len = plen(tb[A_VAL_PORTS]);
        while (len >= NLA_HDRLEN) {
            const struct nlattr *e = (const struct nlattr *)p, *pt[TBMAX];
            if (e->nla_len < NLA_HDRLEN || e->nla_len > len) break;
            parse(pl(e), plen(e), pt);
            if (pt[P_ID]) printf("%u%s ", u32(pt[P_ID]), pt[P_TAGGED] ? "t" : "");
            len -= NLA_ALIGN(e->nla_len);
            p += NLA_ALIGN(e->nla_len);
        }
        ga->got = 1;
    } else if (tb[A_VAL_LINK]) {
        const struct nlattr *lt[TBMAX];
        parse(pl(tb[A_VAL_LINK]), plen(tb[A_VAL_LINK]), lt);
        if (lt[L_LINK])
            printf("port:%d link:up speed:%s %s-duplex %s%s%s%s%s", ga->pv, speed_str(u32(lt[L_SPEED])),
                   lt[L_DUPLEX] ? "full" : "half", lt[L_TXFLOW] ? "txflow " : "", lt[L_RXFLOW] ? "rxflow " : "",
                   lt[L_EEE100] ? "eee100 " : "", lt[L_EEE1000] ? "eee1000 " : "", lt[L_ANEG] ? "auto" : "");
        else
            printf("port:%d link:down", ga->pv);
        ga->got = 1;
    } else if (tb[A_VAL_BLOB]) { printf("(%d bytes binary data)", plen(tb[A_VAL_BLOB])); ga->got = 1; }
}

/* ---- one command (argv as for swconfig, without the program name) ---- */
static int run(int argc, char **argv)
{
    struct dev *d;
    const struct attr *a;
    struct msg m;
    int g = G_GLOBAL, i = 2, set, rc;
    int32_t pv = 0;
    const char *key, *val = NULL;

    if (argc < 4 || strcmp(argv[0], "dev")) goto usage;
    if (i + 1 < argc && (!strcmp(argv[i], "port") || !strcmp(argv[i], "vlan"))) {
        g = !strcmp(argv[i], "port") ? G_PORT : G_VLAN;
        if (parse_index(argv[i + 1], &pv) < 0) {
            fprintf(stderr, "swbatch: line %ld: bad number %s \"%s\"\n", lineno, argv[i], argv[i + 1]);
            return -1;
        }
        i += 2;
    }
    if (i + 1 >= argc) goto usage;
    if (!strcmp(argv[i], "set")) set = 1;
    else if (!strcmp(argv[i], "get")) set = 0;
    else goto usage;
    key = argv[i + 1];
    if (set && i + 2 < argc) val = argv[i + 2];
    if (i + 2 + set < argc) goto usage;                  /* extra arguments */

    d = find_dev(argv[1]);
    if (!d) {
        fprintf(stderr, "swbatch: line %ld: Failed to connect to the switch \"%s\"\n", lineno, argv[1]);
        return -1;
    }
    a = find_attr(d, g, key);
    if (!a) {
        fprintf(stderr, "swbatch: line %ld: Unknown attribute \"%s\"\n", lineno, key);
        return -1;
    }
    if (set && a->type != T_NOVAL && !val) goto usage;

    m_init(&m, famid, 0, set ? SETCMD[g] : GETCMD[g], 0);
    m_u32(&m, A_ID, d->id);
    m_u32(&m, A_OP_ID, a->id);
    if (g == G_PORT) m_u32(&m, A_OP_PORT, (uint32_t)pv);
    if (g == G_VLAN) m_u32(&m, A_OP_VLAN, (uint32_t)pv);

    if (set) {
        rc = put_value(&m, d, a, val);
        if (rc < 0) return -1;
        if (verbose || dry) {
            char where[24] = "";
            if (g != G_GLOBAL) snprintf(where, sizeof(where), " %s %d", g == G_PORT ? "port" : "vlan", pv);
            printf("%ld: %s(id %u)%s set %s (op %u, %s)%s%s%s%s\n", lineno, d->devname, d->id, where, a->name, a->id,
                   type_name(a->type), val ? " = \"" : "", val ? val : "", val ? "\"" : "", rc == 1 ? " - not sent" : "");
        }
        if (rc == 1 || dry) return 0;
        rc = talk(&m, 0, NULL, NULL);
        if (rc) {
            fprintf(stderr, "swbatch: line %ld: Failed to set attribute (%s)\n", lineno, strerror(-rc));
            return -1;
        }
        return 0;
    } else {
        struct getarg ga = { a, pv, 0 };
        if (verbose) printf("%ld: ", lineno);
        rc = talk(&m, 0, get_cb, &ga);
        if (rc || !ga.got) {
            if (ga.got || verbose) putchar('\n');           /* the numbered line is closed on error too */
            fprintf(stderr, "swbatch: line %ld: Failed to get attribute (%s)\n", lineno, rc ? strerror(-rc) : "no value");
            return -1;
        }
        putchar('\n');
        return 0;
    }
usage:
    fprintf(stderr, "swbatch: line %ld: bad command (expected: dev <dev> [port <N>|vlan <N>] set <key> [<value>] | get <key>)\n", lineno);
    return -1;
}

int main(int argc, char **argv)
{
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    long errs = 0;
    int opt;

    while ((opt = getopt(argc, argv, "nv")) != -1) {
        if (opt == 'n') dry = 1;
        else if (opt == 'v') verbose = 1;
        else { fprintf(stderr, "usage: swbatch [-n] [-v] < commands (arguments end with 0x1F, a line with \\n)\n"); return 2; }
    }
    if (init() < 0) return 2;

    while ((n = getline(&line, &cap, stdin)) > 0) {
        char *av[32];
        int ac = 0;
        char *p = line;
        lineno++;
        if (line[n - 1] == '\n') line[--n] = 0;
        if (!n) continue;
        while (*p && ac < 32) {                       /* an argument ends at 0x1F (the last one at the end of the line) */
            char *e = strchr(p, 0x1f);
            av[ac++] = p;
            if (!e) break;
            *e = 0;
            p = e + 1;
        }
        if (*p && ac == 32) { fprintf(stderr, "swbatch: line %ld: more than 32 arguments\n", lineno); errs++; continue; }
        if (run(ac, av) < 0) errs++;
        fflush(stdout);
    }
    free(line);
    if (sk >= 0) close(sk);
    return errs ? 1 : 0;
}
