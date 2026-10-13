# stp-st.sh - the STP state of the switch in one command, read only.
# Run from the build host (the script goes through ssh, nothing is copied to the switch):
#     ssh ubnt@<switch-ip> 'sh -s' < stp-st.sh
# Prints: the time; bridge STP from the configuration and from rstp.conf, the time of the last STP Apply
# (the mtime of rstp.conf), mstpd; the form of rstp.conf (full / changes only) and the per-port BPDU filter
# in it; port STP from the configuration; the link and the ASIC stp_state of ports 1-5; and, while mstpd is
# running, the role/state, BPDU filter and oper edge of every lanN.
# No command reads the ssh stdin.
c() { printf '%s\037' "$@"; echo; }
echo "time: $(date -u '+%H:%M:%S') UTC, uptime $(cut -d' ' -f1 /proc/uptime) s"
grep -q '^switch\.rstp\.status=enabled$' /tmp/system.cfg && b=on || b=off
echo "bridge STP: config $b; rstp.conf - addbridge: $(grep -c 'mstpctl addbridge' /etc/sysinit/rstp.conf), changed $(date -u -r /etc/sysinit/rstp.conf '+%H:%M:%S') UTC; mstpd: $(pidof mstpd || echo none)"
f=/etc/sysinit/rstp.conf
if ! grep -q 'mstpctl addbridge' $f; then k='the "STP off" form'
elif grep -q 'mstpctl setforcevers' $f; then k=full
else k='changes only (after an Apply of port STP)'; fi
printf 'rstp.conf - %s; BPDU filter in the file:' "$k"
for p in 1 2 3 4 5; do
    v=$(sed -n "s/.*setportbpdufilter stp-br lan$p \([a-z]*\)\$/\1/p" $f)
    printf ' %s:%s' $p "${v:--}"
done
echo
printf 'port STP (config):'
for p in 1 2 3 4 5; do
    grep -q "^switch\.rstp\.port\.$p\.status=enabled\$" /tmp/system.cfg && printf ' %s:on' $p || printf ' %s:off' $p
done
echo
{ for p in 1 2 3 4 5; do c dev switch1 port $p get link; done
  for p in 1 2 3 4 5; do c dev switch1 port $p get stp_state; done; } < /dev/null | swbatch |
awk 'NR <= 5 { sub(/.*link:/, ""); sub(/ .*/, ""); l[NR] = $0; next } { s[NR - 5] = $0 }
     END { for (i = 1; i <= 5; i++) printf "port %d: link %s, stp_state %s\n", i, l[i], s[i] }'
if pidof mstpd > /dev/null; then
    for p in 1 2 3 4 5; do
        mstpctl showportdetail stp-br lan$p 2> /dev/null < /dev/null | awk -v p=$p '
            { for (i = 1; i < NF; i++) {
                if ($i == "role" && r == "") r = $(i + 1)
                if ($i == "state" && s == "") s = $(i + 1)
                if ($i == "filter" && $(i + 1) == "port") f = $(i + 2)
                if ($i == "oper" && $(i + 1) == "edge") e = $(i + 3) } }
            END { printf "  lan%d: %s/%s, bpdu filter %s, oper edge %s\n", p, r, s, f, e }'
    done
fi
