# spy.sh - compare the netlink "set link" requests of the vendor swconfig and of swbatch.
# Port 3 (no cable): the link is not renegotiated, so the test bench is not disturbed. All the forms of the
# value the vendor generates are tried: 'autoneg on', 'speed 100 duplex full autoneg on',
# 'speed 10 duplex half autoneg off', '' (port disabled). At the end port 3 is set back with the vendor
# 'autoneg on', the value from switch.conf (checked beforehand).
# The spy /tmp/nlspy.so (LD_PRELOAD) prints every message sent to netlink as hex; it is removed at the end.
# Run from the build host, in the directory that holds nlspy.so and spy.sh:
#     scp -O nlspy.so ubnt@<switch-ip>:/tmp/ && ssh ubnt@<switch-ip> 'sh -s' < spy.sh > spy.txt
# No command here reads the ssh stdin (that is the text of this script).
exec 2>&1
L=/tmp/nlspy.so
P=3
c() { printf '%s\037' "$@"; echo; }
stop() { echo "stop: $*"; rm -f $L; exit 1; }
[ -f $L ] || stop "no $L"
s=$(swconfig dev switch1 port $P get link < /dev/null)
case "$s" in *link:down*) ;; *) stop "port $P has a link ($s): a port without a cable is needed" ;; esac
grep -Eq "^[[:space:]]*swconfig dev switch1 port $P set link 'autoneg on'\$" /etc/sysinit/switch.conf ||
    stop "port $P in /etc/sysinit/switch.conf is not link 'autoneg on'"
echo "## version: $(cat /lib/version) / $(cat /usr/etc/es5xp-build); port $P: $s"
for v in 'autoneg on' 'speed 100 duplex full autoneg on' 'speed 10 duplex half autoneg off' ''; do
    echo "### swbatch: link '$v'"
    c dev switch1 port $P set link "$v" | LD_PRELOAD=$L swbatch
    echo "rc=$?"
    echo "### vendor: link '$v'"
    LD_PRELOAD=$L swconfig dev switch1 port $P set link "$v" < /dev/null
    echo "rc=$?"
done
rm -f $L
echo "### restore (no spy): vendor link 'autoneg on'"
swconfig dev switch1 port $P set link 'autoneg on' < /dev/null
echo "rc=$?"
echo "### result: $(swconfig dev switch1 port $P get link < /dev/null); $L: $([ -e $L ] && echo left || echo removed)"
