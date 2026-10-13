# ntp-st.sh - the time and NTP state of the switch in one command, read only. Written to find out why the
# clock was running from the build time (date -s BDATE in /init) and ntpclient had not corrected it.
# Run from the build host (nothing is copied to the switch, nothing is written):
#     ssh ubnt@<switch-ip> 'sh -s' < ntp-st.sh; date -u '+build host: %H:%M:%S UTC'
# Prints: the time and uptime of the switch; the ntpclient/dhcpc/route/resolv configuration keys; the address,
# routes and DNS as they actually are; the ntpclient lines of inittab and the process; the ntpclient plugin;
# where the program lives; the ntpclient process in detail (state, start moment, wchan, its sockets in
# /proc/net/udp and udp6); link messages in the kernel log; log entries about time and NTP.
# No command reads the ssh stdin.
echo "switch time: $(date -u '+%Y-%m-%d %H:%M:%S') UTC, uptime $(cut -d' ' -f1 /proc/uptime) s"
echo "--- configuration (ntpclient, dhcpc, route, resolv)"
grep -E '^(ntpclient|dhcpc|route|resolv)\.' /tmp/system.cfg 2>&1 < /dev/null
echo "--- address, routes, DNS"
ip -4 -o addr show 2>&1 < /dev/null | awk '{ print $2, $4 }'
ip route 2>&1 < /dev/null
cat /etc/resolv.conf 2>&1
echo "--- inittab: ntp"
grep -n ntp /etc/inittab 2>&1
echo "--- process"
ps 2>&1 < /dev/null | grep '[n]tp[cd]' || echo "(none)"
echo "--- /etc/sysinit/ntpclient.conf"
cat /etc/sysinit/ntpclient.conf 2>&1
echo "--- program"
ls -l /sbin/ntpclient /bin/ntpclient /usr/bin/ntpclient /usr/sbin/ntpclient 2>&1 | grep -v 'No such file'
echo "--- the ntpclient process in detail (HZ = 100)"
n4=$({ wc -l < /proc/net/udp; } 2>/dev/null || echo 1); n6=$({ wc -l < /proc/net/udp6; } 2>/dev/null || echo 1)
echo "UDP sockets: IPv4 $((n4 - 1)), IPv6 $((n6 - 1))"
for p in $(pidof ntpclient); do
    [ -r /proc/$p/stat ] || continue
    set -- $(cut -d' ' -f3,14,15,22 /proc/$p/stat)
    echo "pid $p: state $1, utime $2, stime $3 ticks, started $(($4 / 100)).$(($4 % 100 / 10))$(($4 % 10)) s after boot, wchan $(cat /proc/$p/wchan)"
    for f in /proc/$p/fd/*; do
        l=$(readlink $f)
        case $l in socket:*) i=$(echo "$l" | tr -cd 0-9)
            echo "  fd ${f##*/} -> socket $i:"
            awk -v i=$i '$10 == i { print "    " FILENAME ": local " $2 ", remote " $3 ", st " $4 ", tx:rx " $5 ", drops " $NF }' /proc/net/udp /proc/net/udp6 2>/dev/null ;;
        esac
    done
done
echo "--- kernel log: link (last 12)"
dmesg 2>&1 < /dev/null | grep -i -E 'link (is )?(up|down)|port [1-5]' | tail -n 12
echo "--- log: ntp/time (last 20)"
logread 2>&1 < /dev/null | grep -i -E 'ntp|time' | tail -n 20
