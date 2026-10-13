# t-loop.sh - a 3<->4 loop with STP enabled: does STP break the loop through ar8216_vport (vendor behaviour,
# with none of our changes)? Files on the switch: /tmp/loop/{bpdumon,t-loop.sh}.
# EXAMPLE SCRIPT: it changes STP and the state of the ports, so run it on a test bench only.
# Preconditions: bridge STP is enabled, port STP is enabled on ports 3 and 4 (in the web interface), mstpd is
# running, and the patch cord is NOT plugged in yet.
# The run is detached from ssh:
#     setsid sh /tmp/loop/t-loop.sh <grandmaster-ip> <client-ip> > /tmp/loop/out.txt 2>&1 < /dev/null &
# Course of the test: (1) wait for a link on both ports 3 and 4 - you plug the patch cord in - up to 180 s;
# (2) watch for 60 s; (3) wait until the patch cord is unplugged (both links gone), up to 180 s. Every second:
# the links of ports 3/4, the ASIC stp_state of ports 1-5, and the role/state of lan3 and lan4 in mstpd,
# printed when they change. In the background: bpdumon and a ping to the grandmaster and to the client.
# SAFETY FUSE: if, with a link on both ports, both are in forwarding (stp_state 4) for two readings in a row
# (about a second), the loop has not been broken, and port 4 is switched off (swconfig ... port 4 set link '');
# at the end it is switched back on (link 'autoneg on', the value from switch.conf).
# The end is the file /tmp/loop/done.
D=/tmp/loop
GM=$1; CL=$2
trap '' HUP
FUSE=0
up() { cut -d' ' -f1 /proc/uptime; }
mark() { echo "$(up) ## $*"; }
stop() { echo "stop: $*"; touch $D/done; exit 1; }
fin() {
    [ -n "$MON" ] && kill $MON 2>/dev/null; killall ping 2>/dev/null
    [ $FUSE = 1 ] && swconfig dev switch1 port 4 set link 'autoneg on' < /dev/null
    sleep 1; touch $D/done
}
c() { printf '%s\037' "$@"; echo; }
# "l3 l4 s1 s2 s3 s4 s5": the links of ports 3/4 (up|down) and stp_state 1-5
sw() {
    { c dev switch1 port 3 get link; c dev switch1 port 4 get link
      for p in 1 2 3 4 5; do c dev switch1 port $p get stp_state; done; } | swbatch 2>&1 |
    awk '/link:/ { sub(/.*link:/, ""); sub(/ .*/, ""); } { printf "%s ", $0 }'
}
rs() { mstpctl showportdetail stp-br $1 2>&1 | awk '{ for (i = 1; i < NF; i++) { if ($i == "role" && r == "") r = $(i + 1); if ($i == "state" && s == "") s = $(i + 1) } } END { printf "%s/%s", r, s }'; }
cnt() {
    for p in 3 4; do
        echo "    lan$p: $(mstpctl showportdetail stp-br lan$p 2>&1 | grep -E 'role|state|Num TX BPDU|Num RX BPDU|edge port|filter port|Transition' | tr -s ' ' | tr '\n' ';')"
    done
}
pg() { ping $1 2>&1 | while IFS= read -r l; do echo "$(up) $l"; done; }
L=
# phase <name> <max seconds> <exit condition: both-up|both-down|none>
phase() {
    n=0; HOT=0                                  # two readings in a row, one second apart, inside one phase
    while [ $n -lt $2 ]; do
        set -- "$1" "$2" "$3" $(sw)
        l3=$4; l4=$5; s3=$8; s4=$9
        cur="ports 3/4 $l3/$l4 | stp_state 1-5: $6 $7 $8 $9 ${10} | lan3 $(rs lan3) lan4 $(rs lan4)"
        [ "$cur" = "$L" ] || echo "$(up)    $cur"
        L=$cur
        if [ "$l3" = up ] && [ "$l4" = up ] && [ "$s3" = 4 ] && [ "$s4" = 4 ]; then HOT=$((HOT + 1)); else HOT=0; fi
        if [ $HOT -ge 2 ] && [ $FUSE = 0 ]; then
            swconfig dev switch1 port 4 set link '' < /dev/null
            FUSE=1; mark "SAFETY FUSE: both ports in forwarding for two readings in a row - the loop was not broken, port 4 switched off"
        fi
        case "$3" in
            both-up) [ "$l3" = up ] && [ "$l4" = up ] && return 0 ;;
            both-down) [ "$l3" = down ] && [ "$l4" = down ] && return 0 ;;
        esac
        n=$((n + 1)); sleep 1
    done
    return 1
}

case "$GM.$CL" in *[!0-9.]*|.*|*.) stop "two addresses are needed: t-loop.sh <grandmaster-ip> <client-ip>" ;; esac
[ -x $D/bpdumon ] || stop "no $D/bpdumon"
grep -q '^switch\.rstp\.status=enabled$' /tmp/system.cfg || stop "bridge STP is not enabled (switch.rstp.status)"
for p in 3 4; do
    grep -q "^switch\.rstp\.port\.$p\.status=enabled\$" /tmp/system.cfg || stop "port STP is not enabled on port $p"
    grep -q "setportbpdufilter stp-br lan$p no" /etc/sysinit/rstp.conf || stop "lan$p in rstp.conf does not have bpdufilter no"
done
pidof mstpd > /dev/null || stop "mstpd is not running"
set -- $(sw)
[ "$1" = down ] && [ "$2" = down ] || stop "port 3 or 4 already has a link - plug the patch cord in only after the start"
trap fin EXIT
echo "## version: $(cat /lib/version) / $(cat /usr/etc/es5xp-build); grandmaster $GM, client $CL"
echo "## rstp.conf (lan3, lan4):"; grep -E 'lan[34] ' /etc/sysinit/rstp.conf | sed 's/^/##   /'
$D/bpdumon > $D/mon.txt 2>&1 & MON=$!
pg $GM > $D/ping-gm.txt & pg $CL > $D/ping-cl.txt &
sleep 2
mark "initial state"; cnt
mark "1: plug the patch cord into 3<->4 (waiting for a link on both, up to 180 s)"
phase wait-up 180 both-up || mark "1: no link on both ports within 180 s"
mark "2: watching for 60 s"
phase observe 60 none
cnt
mark "3: unplug the patch cord (waiting, up to 180 s)"
phase wait-down 180 both-down || mark "3: the links did not go away within 180 s"
sleep 3
cnt
mark "end"
kill $MON 2>/dev/null; killall ping 2>/dev/null; sleep 1
echo "#### bpdumon (lan3/lan4/eth0; incoming BPDUs of the network on lan1 are counted, not listed)"
grep -v ' in lan1 ' $D/mon.txt; echo "in lan1: $(grep -c ' in lan1 ' $D/mon.txt)"
echo "#### ping GM $GM"; cat $D/ping-gm.txt
echo "#### ping client $CL"; cat $D/ping-cl.txt
