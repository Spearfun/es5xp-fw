/* bpdumon.c - watch BPDUs on the switch: an AF_PACKET socket on every interface, with a BPF filter in the
 * kernel that passes only frames with DA 01:80:C2:00:00:00. One line per frame:
 *     <time from /proc/uptime> <out|in> <interface> src=<MAC> len=<N> b12=<bytes 12-13>
 * out - a frame sent by this switch (mstpd -> lanN -> the ar8216_vport driver -> eth0), in - a received one.
 * Bytes 12-13 are the frame type/length or the Atheros header (on eth0), printed as they are.
 * Watch only, nothing is ever sent. Stops on SIGTERM/SIGINT. libc only.
 *
 * Build:  mips-openwrt-linux-musl-gcc -Os -mips32r2 -mtune=24kc -msoft-float
 *                     -Wall -Wextra -Werror -o bpdumon bpdumon.c */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/filter.h>
#include <linux/if_ether.h>
#include <linux/if_packet.h>
#include <net/if.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stop;
static void on_sig(int s) { (void)s; stop = 1; }

int main(void)
{
    struct sock_filter code[] = {                      /* DA == 01:80:C2:00:00:00 */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x0180C200, 0, 3),
        BPF_STMT(BPF_LD | BPF_H | BPF_ABS, 4),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x0000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, 256),
        BPF_STMT(BPF_RET | BPF_K, 0),
    };
    struct sock_fprog prog = { sizeof(code) / sizeof(code[0]), code };
    struct sigaction sa;
    unsigned char buf[256];
    int sk;

    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_sig;                            /* no SA_RESTART: recvfrom is interrupted */
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    setvbuf(stdout, NULL, _IOLBF, 0);

    sk = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (sk < 0) { fprintf(stderr, "bpdumon: socket: %s\n", strerror(errno)); return 2; }
    if (setsockopt(sk, SOL_SOCKET, SO_ATTACH_FILTER, &prog, sizeof(prog)) < 0) {
        fprintf(stderr, "bpdumon: SO_ATTACH_FILTER: %s\n", strerror(errno)); return 2;
    }
    printf("bpdumon: start\n");
    while (!stop) {
        struct sockaddr_ll ll;
        socklen_t al = sizeof(ll);
        char ifn[IF_NAMESIZE] = "?";
        struct timespec ts;
        ssize_t n = recvfrom(sk, buf, sizeof(buf), MSG_TRUNC, (struct sockaddr *)&ll, &al);
        if (n < 0) {
            if (errno == EINTR) continue;
            fprintf(stderr, "bpdumon: recvfrom: %s\n", strerror(errno)); return 2;
        }
        clock_gettime(CLOCK_BOOTTIME, &ts);               /* the same scale as /proc/uptime */
        if_indextoname(ll.sll_ifindex, ifn);
        printf("%lu.%03lu %s %-6s src=%02x:%02x:%02x:%02x:%02x:%02x len=%ld b12=%02x%02x\n",
               (unsigned long)ts.tv_sec, (unsigned long)(ts.tv_nsec / 1000000),
               ll.sll_pkttype == PACKET_OUTGOING ? "out" : "in", ifn,
               buf[6], buf[7], buf[8], buf[9], buf[10], buf[11], (long)n, buf[12], buf[13]);
    }
    printf("bpdumon: stop\n");
    return 0;
}
