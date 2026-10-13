/* nlspy.c - LD_PRELOAD: every message sent to an AF_NETLINK socket (send/sendto/sendmsg) is printed to
 * stderr as hex (groups of 4 bytes, byte order as in memory). Watch only: the message reaches the kernel
 * unchanged. Used to compare the requests of the vendor swconfig with those of swbatch.
 *
 * Build:  mips-openwrt-linux-musl-gcc -Os -mips32r2 -mtune=24kc -msoft-float -fPIC -shared
 *                     -Wall -Wextra -Werror -o nlspy.so nlspy.c */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>

static int is_nl(int fd)
{
    struct sockaddr_storage ss;
    socklen_t l = sizeof(ss);
    return getsockname(fd, (struct sockaddr *)&ss, &l) == 0 && ss.ss_family == AF_NETLINK;
}

static void dump(const char *how, const unsigned char *p, size_t n)
{
    fprintf(stderr, "nlspy %s %u:", how, (unsigned)n);
    for (size_t i = 0; i < n; i++) fprintf(stderr, "%s%02x", i % 4 ? "" : " ", p[i]);
    fputc('\n', stderr);
}

ssize_t send(int fd, const void *b, size_t n, int fl)
{
    static ssize_t (*r)(int, const void *, size_t, int);
    if (!r) r = (ssize_t (*)(int, const void *, size_t, int))dlsym(RTLD_NEXT, "send");
    if (is_nl(fd)) dump("send", b, n);
    return r(fd, b, n, fl);
}

ssize_t sendto(int fd, const void *b, size_t n, int fl, const struct sockaddr *a, socklen_t al)
{
    static ssize_t (*r)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
    if (!r) r = (ssize_t (*)(int, const void *, size_t, int, const struct sockaddr *, socklen_t))dlsym(RTLD_NEXT, "sendto");
    if (is_nl(fd)) dump("sendto", b, n);
    return r(fd, b, n, fl, a, al);
}

ssize_t sendmsg(int fd, const struct msghdr *m, int fl)
{
    static ssize_t (*r)(int, const struct msghdr *, int);
    static unsigned char buf[65536];
    if (!r) r = (ssize_t (*)(int, const struct msghdr *, int))dlsym(RTLD_NEXT, "sendmsg");
    if (is_nl(fd)) {
        size_t n = 0;
        for (size_t i = 0; i < (size_t)m->msg_iovlen; i++) {
            size_t l = m->msg_iov[i].iov_len;
            if (l > sizeof(buf) - n) l = sizeof(buf) - n;
            memcpy(buf + n, m->msg_iov[i].iov_base, l);
            n += l;
        }
        dump("sendmsg", buf, n);
    }
    return r(fd, m, fl);
}
