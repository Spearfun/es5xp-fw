# t-bpdu.sh - the BPDU leak when the rstp plugin starts: the vendor order (A) against the candidate
# "stp-br held down while the plugin starts" (B). Files on the switch: /tmp/bpdu/{bpdumon,t-bpdu.sh}.
# EXAMPLE SCRIPT: it changes STP and the state of the ports, so run it on a test bench only.
# Precondition: bridge STP is enabled in the web interface (switch.rstp.status=enabled) and mstpd is running.
# The run is detached from ssh (the ssh session goes through port 1, whose state the test changes):
#     setsid sh /tmp/bpdu/t-bpdu.sh <grandmaster-ip> <client-ip> > /tmp/bpdu/out.txt 2>&1 < /dev/null &
# The end is the file /tmp/bpdu/done. The rounds go B1, A1, B2, A2 - the vendor order comes last, so after
# the test the state is the one left by an ordinary STP enable; stp-br is brought up on every exit.
# What is watched: bpdumon - every BPDU (DA 01:80:C2:00:00:00) sent (out) or received (in), per interface;
# a ping from the switch to the grandmaster (port 2) and to the client (port 5) - every line carries a time
# stamp from /proc/uptime, and gaps in seq mean an interruption of traffic; the ASIC stp_state of ports 1-5
# and the stp-br flags - once a second for 35 s after the round, printed when they change; and the per-port
# mstpd counters after the round.
D=/tmp/bpdu
PL=/usr/etc/init.d/plugin
GM=$1; CL=$2
trap '' HUP
up() { cut -d' ' -f1 /proc/uptime; }
mark() { echo "$(up) ## $*"; }
fin() { [ -n "$MON" ] && kill $MON 2>/dev/null; killall ping 2>/dev/null; ip link set stp-br up; sleep 1; touch $D/done; }
stop() { echo "stop: $*"; touch $D/done; exit 1; }
c() { printf '%s\037' "$@"; echo; }
st() { for p in 1 2 3 4 5; do c dev switch1 port $p get stp_state; done | swbatch 2>&1 | tr '\n' ' '; }
br() { ip -o link show stp-br | sed -n 's/.*\(<[^>]*>\).*/\1/p'; }
watch() {
    l=; i=0
    while [ $i -lt 35 ]; do
        s="stp_state 1-5: $(st)| stp-br $(br)"
        [ "$s" = "$l" ] || echo "$(up)    $s"
        l=$s; i=$((i + 1)); sleep 1
    done
}
cnt() {
    for p in 1 2 3 4 5; do
        echo "    lan$p: $(mstpctl showportdetail stp-br lan$p 2>&1 | grep -E 'state|Num TX BPDU|Num RX BPDU|edge port|filter port' | tr -s ' ' | tr '\n' ';')"
    done
}
pg() { ping $1 2>&1 | while IFS= read -r l; do echo "$(up) $l"; done; }
run() { $PL "$1" rstp 2>&1 | sed "s/^/    $1: /"; }
A() {
    mark "A$1: plugin stop rstp"; run stop
    mark "A$1: plugin start rstp"; run start
    mark "A$1: start done"; watch; cnt
}
B() {
    mark "B$1: plugin stop rstp"; run stop
    ip link set stp-br down; mark "B$1: stp-br down, rc=$? $(br)"
    mark "B$1: plugin start rstp"; run start
    mark "B$1: start done"
    ip link set stp-br up; mark "B$1: stp-br up, rc=$? $(br)"
    watch; cnt
}

case "$GM.$CL" in *[!0-9.]*|.*|*.) stop "two addresses are needed: t-bpdu.sh <grandmaster-ip> <client-ip>" ;; esac
[ -x $D/bpdumon ] || stop "no $D/bpdumon"
grep -q '^switch\.rstp\.status=enabled$' /tmp/system.cfg || stop "bridge STP is not enabled (switch.rstp.status)"
grep -q 'mstpctl addbridge' /etc/sysinit/rstp.conf || stop "rstp.conf is not in the \"STP on\" form"
pidof mstpd > /dev/null || stop "mstpd is not running"
trap fin EXIT
echo "## version: $(cat /lib/version) / $(cat /usr/etc/es5xp-build); grandmaster $GM, client $CL"
echo "## rstp.conf:"; sed 's/^/##   /' /etc/sysinit/rstp.conf
$D/bpdumon > $D/mon.txt 2>&1 & MON=$!
pg $GM > $D/ping-gm.txt & pg $CL > $D/ping-cl.txt &
sleep 3
mark "0: initial state (after STP was enabled in the web interface)"; echo "    stp_state 1-5: $(st)| stp-br $(br)"; cnt
B 1; A 1; B 2; A 2
sleep 3
mark "end"
kill $MON 2>/dev/null; killall ping 2>/dev/null; sleep 1
echo "#### bpdumon"; cat $D/mon.txt
echo "#### ping GM $GM"; cat $D/ping-gm.txt
echo "#### ping client $CL"; cat $D/ping-cl.txt
