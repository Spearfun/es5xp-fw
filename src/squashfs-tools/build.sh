#!/bin/bash
# build.sh - mksquashfs4 and unsquashfs4 (squashfs-tools 4.7.4), host tools built the way OpenWrt builds them.
#   src/squashfs-tools/build.sh OUT_DIR
# Result: OUT_DIR/mksquashfs4 and OUT_DIR/unsquashfs4.
# Source and options are those of the OpenWrt 25.12.0 package tools/squashfs4: its source mirror tarball of
# the upstream commit 53e5a67aac42e0bc9ad4a249156d7d549ce7436c (release 4.7.4; it differs from the 4.7.4 tag
# in documentation only), the sha256 below being that package's PKG_MIRROR_HASH, plus the single patch OpenWrt
# carries. XZ_EXTENDED_OPTIONS=1 is what gives mksquashfs the -Xpreset/-Xe/-Xlc/-Xlp/-Xpb options; without
# them the image is a little larger (see README).
# Needs the zlib and liblzma headers (Debian/Ubuntu: zlib1g-dev liblzma-dev).
set -u
. "$(dirname "$0")/../common.sh"

VER=4.7.4
TARBALL=squashfs4-$VER.tar.zst
SHA=7ce390d95af4b7b4ce768cec18aeb9ac61b8ca413d0ced2c42a81446d9dd8690
HERE=$ROOT/src/squashfs-tools

[ $# -ge 1 ] || die "usage: build.sh OUT_DIR"
for h in zlib.h lzma.h; do
    echo "#include <$h>" | gcc -E -xc - > /dev/null 2>&1 || die "missing header $h (Debian/Ubuntu: zlib1g-dev liblzma-dev)"
done
mkdir -p "$1" || die "cannot create $1"
OUT=$(cd "$1" && pwd)
W=$OUT/squashfs4-$VER

fetch "$TARBALL" "$SHA" "https://sources.openwrt.org/$TARBALL"
rm -rf "$W"
tar --zstd -xf "$DL/$TARBALL" -C "$OUT" || die "unpack $TARBALL"
[ -f "$W/squashfs-tools/Makefile" ] || die "no squashfs4-$VER/squashfs-tools in $TARBALL"

for p in "$HERE"/patches/*.patch; do
    patch -d "$W" -p1 -s --no-backup-if-mismatch < "$p" || die "patch $(basename "$p")"
done

# the variables below are those of OpenWrt's tools/squashfs4 Makefile, Host/Compile
make -C "$W/squashfs-tools" -j"$(nproc)" \
    LZ4_SUPPORT=0 LZO_SUPPORT=0 ZSTD_SUPPORT=0 GZIP_SUPPORT=1 XZ_SUPPORT=1 \
    LZMA_XZ_SUPPORT=1 XZ_EXTENDED_OPTIONS=1 \
    mksquashfs unsquashfs > "$OUT/squashfs-tools-build.log" 2>&1 ||
    { tail -n 20 "$OUT/squashfs-tools-build.log"; die "squashfs-tools build"; }

install -m 0755 "$W/squashfs-tools/mksquashfs" "$OUT/mksquashfs4" || die "install mksquashfs4"
install -m 0755 "$W/squashfs-tools/unsquashfs" "$OUT/unsquashfs4" || die "install unsquashfs4"
h=$("$OUT/mksquashfs4" -help-all 2>&1)
for o in -Xpreset -Xe -Xlc -Xlp -Xpb -block-readers; do
    echo "$h" | grep -q -- "$o" || die "mksquashfs4 has no $o (XZ_EXTENDED_OPTIONS)"
done
ok "mksquashfs4: $("$OUT/mksquashfs4" -version 2>&1 | head -n 1)"
