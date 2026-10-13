#!/bin/bash
# build.sh - sstrip (ELFkickers 3.2), a host tool: removes everything not loaded at run time from an ELF file.
#   src/sstrip/build.sh OUT_DIR
# Result: OUT_DIR/sstrip. OpenWrt strips its packages with "sstrip -z"; dropbear is stripped the same way.
set -u
. "$(dirname "$0")/../common.sh"

VER=3.2
TARBALL=ELFkickers-$VER.tar.gz
SHA=9b81e6c53e0c94fc198d9882eb737156f36d565152dc32118897c77b06a2687c

[ $# -ge 1 ] || die "usage: build.sh OUT_DIR"
mkdir -p "$1" || die "cannot create $1"
OUT=$(cd "$1" && pwd)
W=$OUT/ELFkickers-$VER

fetch "$TARBALL" "$SHA" "https://www.muppetlabs.com/~breadbox/pub/software/$TARBALL" "https://sources.openwrt.org/$TARBALL"
rm -rf "$W"
tar -xzf "$DL/$TARBALL" -C "$OUT" || die "unpack $TARBALL"
make -C "$W" sstrip > "$OUT/sstrip-build.log" 2>&1 || { tail -n 20 "$OUT/sstrip-build.log"; die "sstrip build"; }
install -m 0755 "$W/bin/sstrip" "$OUT/sstrip" || die "install sstrip"
ok "sstrip: $(stat -c%s "$OUT/sstrip") bytes"
