# diag - research and diagnostic tools

These are the tools the vendor firmware was studied with. They are kept here because they are useful for
anyone who wants to look at the switch instead of taking this firmware's word for it. None of them is part
of the firmware image.

Unless stated otherwise, a tool only reads. Two of them change the state of the switch and are marked.

| Tool | What it does |
|---|---|
| `swprobe.c` | Probes the "switch" netlink interface of the vendor kernel: which attribute numbers and types it really uses. Read only. |
| `nlspy.c` | `LD_PRELOAD` library that prints every message sent to a netlink socket as hex. Watch only - the message reaches the kernel unchanged. |
| `spy.sh` | Uses `nlspy.so` to compare the netlink "set link" requests of the vendor `swconfig` with those of `swbatch`. Works on the free port 3 and puts it back the way it was. |
| `bpdumon.c` | Watches BPDUs (DA 01:80:C2:00:00:00) on every interface, one line per frame, in or out. Sends nothing. |
| `t1.sh` | Checks `swbatch` on a running switch: dry run of `switch.conf`, the same reads through both tools compared line by line, and a reversible write on the free port 4. |
| `t2.sh` | A full snapshot of the switch state (`swconfig show`, the ACL table, three register ranges), for comparing two boot paths with `diff`. Read only. |
| `stp-st.sh` | The STP state in one command: the configuration, `rstp.conf`, `mstpd`, the ASIC `stp_state` of every port. Read only. |
| `ntp-st.sh` | The time and NTP state in one command: the configuration, the address and routes, the `ntpclient` process and its sockets, the log. Read only. |
| `t-bpdu.sh` | **Changes STP.** Example script: measures the BPDU leak when the rstp plugin starts, the vendor order against a candidate fix. |
| `t-loop.sh` | **Changes STP and port state.** Example script: makes a 3<->4 loop with STP enabled and watches whether STP breaks it. Has a safety fuse that switches port 4 off. |

`t-bpdu.sh` and `t-loop.sh` are examples of how such a test is written, not tools to run on a switch that
anything depends on. They interrupt traffic by design. Run them on a test bench.

## Building the three C tools

They are built with the same toolchain as the firmware itself (`./build.sh` puts it under
`out/toolchain/`), and `STAGING_DIR` has to be set because the OpenWrt gcc specs read it:

```
export PATH=$PWD/out/toolchain/openwrt-toolchain-25.12.0-ath79-generic_gcc-14.3.0_musl.Linux-x86_64/toolchain-mips_24kc_gcc-14.3.0_musl/bin:$PATH
export STAGING_DIR=$PWD/out/staging
cd diag
mips-openwrt-linux-musl-gcc -Os -Wall -Wextra -o swprobe swprobe.c
mips-openwrt-linux-musl-gcc -Os -mips32r2 -mtune=24kc -msoft-float -Wall -Wextra -Werror -o bpdumon bpdumon.c
mips-openwrt-linux-musl-gcc -Os -mips32r2 -mtune=24kc -msoft-float -fPIC -shared -Wall -Wextra -Werror -o nlspy.so nlspy.c
```

## Running them

The shell scripts are fed to the switch through ssh and are not copied to it:

```
ssh ubnt@<switch-ip> 'sh -s' < stp-st.sh
```

A compiled tool has to be copied over. Put it in `/tmp`, which is a tmpfs and is empty again after a
reboot, and remove it when you are done - `/tmp` holds 9 MiB in total and the firmware image is uploaded
there during an upgrade:

```
scp -O bpdumon ubnt@<switch-ip>:/tmp/ && ssh ubnt@<switch-ip> '/tmp/bpdumon; rm -f /tmp/bpdumon'
```

Every script expects the `<switch-ip>` of its own switch; nothing is auto-discovered.
