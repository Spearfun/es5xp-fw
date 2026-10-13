# t2.sh - a snapshot of the switch state, to compare boot path A (the vendor swconfig) with path B (swbatch).
# Read only; nothing is created or left on the switch.
# Run from the build host (the script goes through ssh, nothing is copied to the switch), after the boot has
# finished and es5xp-qos is done, with the web interface tab closed:
#     ssh ubnt@<switch-ip> 'sh -s' < t2.sh > B.txt          (and the same into A.txt for path A)
# Compare with:  diff <(grep -v '^##' A.txt) <(grep -v '^##' B.txt)
# The "##" lines are informational (time, dmesg) and stay out of the comparison.
# Note: no command here reads the ssh stdin (that is the text of this script) - swbatch gets its commands
# through a pipe.
# hx goes through two halves of 16 bits: printf %x in the busybox awk saturates at 0x80000000 (checked).
c() { printf '%s\037' "$@"; echo; }

echo "## version: $(cat /lib/version) / $(cat /usr/etc/es5xp-build)"
if [ -e /etc/persistent/es5xp-no-swbatch ]; then echo "## path: A (the es5xp-no-swbatch flag - the vendor swconfig)"; else echo "## path: B (swbatch)"; fi
echo "## uptime: $(cut -d' ' -f1 /proc/uptime) s"
ps | grep -q '[e]s5xp-qos' && echo "## WARNING: es5xp-qos is still running - the snapshot is not final"
dmesg | grep -E 'plugin switch start|plugin initdone start$|rc_start: (start|done)|swbatch' | sed 's/^/## dmesg /'

echo "# 1. swconfig dev <dev> show (the vendor swconfig; without arl_table, mib*, reg_addr/reg_val and acl - those change by themselves or when read)"
for d in switch1 switch0; do
    echo "# swconfig dev $d show"
    swconfig dev $d show 2>&1 < /dev/null | awk '
        /^\t[a-z_0-9]+: / { skip = ($0 ~ /^\t(arl_table|mib|mib_all_bin|mib_bin|reg_addr|reg_val|acl): /) }
        /^(Global attributes|Port [0-9]+|VLAN [0-9]+):$/ { skip = 0 }
        !skip'
done

echo "# 2. the ACL table: rule, selection (0 pattern, 1 mask, 2 result), the ACL_FUNC0 busy flag after the command, 5 words (hex)"
i=0
while [ $i -lt 96 ]; do
    for s in 0 1 2; do
        c dev switch1 set reg_addr 1024
        c dev switch1 set reg_val $(( 0x80000400 | (s << 8) | i ))
        c dev switch1 set reg_addr 1024
        c dev switch1 get reg_val
        for a in 1028 1032 1036 1040 1044; do c dev switch1 set reg_addr $a; c dev switch1 get reg_val; done
    done
    i=$((i + 1))
done | swbatch -v 2>&1 | awk -F': ' '
    function hx(v, h) { v += 0; if (v < 0) v += 4294967296; h = int(v / 65536); return sprintf("%04x%04x", h, v - h * 65536) }
    /^swbatch: / { print "ERROR " $0; next }
    { n = $1 - 1; e = int(n / 14); k = n % 14
      if (k == 3) { busy = int(hx($2) ~ /^[89a-f]/) }
      else if (k >= 5 && k % 2 == 1) { w[(k - 5) / 2] = hx($2) }
      if (k == 13) printf "acl %2d sel %d busy %d: %s %s %s %s %s\n", int(e / 3), e % 3, busy, w[0], w[1], w[2], w[3], w[4] }'

echo "# 3. registers (hex): 0x0000-0x00FC, 0x0400-0x047C, 0x0600-0x06FC, 0x0800-0x0BFC"
for r in "0 252" "1024 1148" "1536 1788" "2048 3068"; do
    set -- $r; a=$1
    while [ $a -le $2 ]; do c dev switch1 set reg_addr $a; c dev switch1 get reg_val; a=$((a + 4)); done
done | swbatch -v 2>&1 | awk -F': ' '
    function hx(v, h) { v += 0; if (v < 0) v += 4294967296; h = int(v / 65536); return sprintf("%04x%04x", h, v - h * 65536) }
    /^swbatch: / { print "ERROR " $0; next }
    /^[0-9]+: switch1/ { split($0, p, "= \""); a = p[2] + 0; next }
    { printf "reg %04x = %s\n", a, hx($2) }'
echo "## end of the snapshot, uptime $(cut -d' ' -f1 /proc/uptime) s"
