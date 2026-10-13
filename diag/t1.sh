#!/bin/sh
# t1.sh - check swbatch on a running switch: no reboot, the configuration is not changed.
#   1  switch.conf: every line is matched against the kernel attributes without writing (swbatch -n)
#   2  reads: the same attributes through the vendor swconfig and through swbatch - the output must match
#      line by line; timing is printed as well
#   3  a write on the free port 4: its own lines from switch.conf (the same values) and a reversible
#      write of vlan_prio
#   4  the new dmesg lines (kernel warnings)
# Needs /tmp/swbatch and /tmp/t1.sh; both are removed at the end together with the temporary directory.
# Run on the switch:  sh /tmp/t1.sh 2>&1
B=${B:-/tmp/swbatch}
SC=${SC:-swconfig}
CONF=${CONF:-/etc/sysinit/switch.conf}
T=/tmp/t1.$$
mkdir -p $T || exit 1
c() { printf '%s\037' "$@"; echo; }
k0=$(dmesg | wc -l)

echo "== 1. switch.conf without writing (swbatch -n)"
sed -n 's/^[[:space:]]*swconfig //p' $CONF | while IFS= read -r l; do eval "set -- $l"; c "$@"; done > $T/conf.in
$B -n < $T/conf.in > $T/conf.out 2> $T/conf.err; rc=$?
echo "rc=$rc lines: $(wc -l < $T/conf.in), matched: $(wc -l < $T/conf.out), errors: $(wc -l < $T/conf.err)"
head -2 $T/conf.out; tail -1 $T/conf.out; cat $T/conf.err

echo "== 2. reads: $SC and swbatch"
GK="enable_vlan ar8xxx_mib_poll_interval ar8xxx_mib_type enable_mirror_rx enable_mirror_tx mirror_monitor_port mirror_source_port arl_age_time igmp_snooping igmp_v3 enable_stp max_frame_size"
PK="pvid link enable_eee igmp_snooping vlan_prio stp_state flow_control mirror_ingress mirror_egress protected rate_in rate_in_type rate_in_2 rate_in_type_2 rate_out rate_bucket"
{
    for k in $GK; do c dev switch1 get $k; done
    for p in 0 1 2 3 4 5 6; do for k in $PK; do c dev switch1 port $p get $k; done; done
    c dev switch1 vlan 1 get vid; c dev switch1 vlan 1 get ports
    c dev switch0 port 1 get pvid; c dev switch0 port 1 get link; c dev switch0 vlan 1 get ports
} > $T/get.in
read t0 x < /proc/uptime
$B -v < $T/get.in > $T/b.out 2> $T/b.err; rc=$?
read t1 x < /proc/uptime
i=0
tr '\037' ' ' < $T/get.in | while read -r a; do i=$((i+1)); v=$($SC $a 2>/dev/null) || v=""; echo "$i: $v"; done > $T/v.out
read t2 x < /proc/uptime
echo "reads: $(wc -l < $T/get.in); swbatch: rc=$rc, $t0 -> $t1 s; $SC one by one: $t1 -> $t2 s"
if cmp -s $T/v.out $T/b.out; then echo "OK: the swbatch output equals the $SC output line by line"; else echo "DIFFERENCES ($SC / swbatch):"; diff $T/v.out $T/b.out | head -20; fi
echo "reads that failed in swbatch: $(wc -l < $T/b.err) (in $SC such lines are empty)"; head -3 $T/b.err

echo "== 3. a write on port 4 (free)"
grep "^$(printf 'dev\037switch1\037port\0374\037')" $T/conf.in > $T/w.in
for k in $PK; do echo "$k: $($SC dev switch1 port 4 get $k 2>/dev/null)"; done > $T/w.before
$B -v < $T/w.in; rc=$?; echo "port 4 lines from switch.conf: $(wc -l < $T/w.in), rc=$rc"
for k in $PK; do echo "$k: $($SC dev switch1 port 4 get $k 2>/dev/null)"; done > $T/w.after
if cmp -s $T/w.before $T/w.after; then echo "OK: the state of port 4 did not change after writing the same values"; else echo "CHANGED:"; diff $T/w.before $T/w.after; fi
o=$($SC dev switch1 port 4 get vlan_prio)
c dev switch1 port 4 set vlan_prio 5 | $B; rc=$?; echo "vlan_prio: was $o; write 5 rc=$rc -> $($SC dev switch1 port 4 get vlan_prio)"
c dev switch1 port 4 set vlan_prio "$o" | $B; rc=$?; echo "back to $o rc=$rc -> $($SC dev switch1 port 4 get vlan_prio)"

k1=$(dmesg | wc -l)
echo "== 4. new dmesg lines: $((k1 - k0))"
[ "$k1" -gt "$k0" ] && dmesg | tail -n $((k1 - k0))
rm -rf $T /tmp/swbatch /tmp/t1.sh
echo "== removed: $T, /tmp/swbatch, /tmp/t1.sh"
