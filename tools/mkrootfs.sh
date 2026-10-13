#!/bin/bash
# mkrootfs.sh - root filesystem stage of build.sh; runs under fakeroot (files appear owned by root,
# /dev/console can be created), so no real root rights are needed.
#   fakeroot -- tools/mkrootfs.sh STOCK_SQSH TREE BUILD_DIR VERSION STAMP BDATE OUT_SQSH MANIFEST
# Unpacks the stock squashfs into TREE, applies rootfs/ (tools/rootfs.py), lists the result into MANIFEST
# and packs OUT_SQSH with the vendor options (64 KiB blocks). File times are set to SOURCE_DATE_EPOCH.
set -u
die() { echo "FATAL: $*" >&2; exit 1; }
[ $# -eq 8 ] || die "usage: mkrootfs.sh STOCK_SQSH TREE BUILD_DIR VERSION STAMP BDATE OUT_SQSH MANIFEST"
SQ=$1 TREE=$2 BUILD=$3 VERSION=$4 STAMP=$5 BDATE=$6 OUTSQ=$7 MAN=$8
HERE=$(cd "$(dirname "$0")" && pwd)
UNSQ=${UNSQUASHFS:-unsquashfs}
MKSQ=${MKSQUASHFS:-mksquashfs}
: "${SOURCE_DATE_EPOCH:?set SOURCE_DATE_EPOCH}"

rm -rf "$TREE" "$OUTSQ"
"$UNSQ" -d "$TREE" "$SQ" > "$TREE.unsquashfs.log" 2>&1 || { tail -n 5 "$TREE.unsquashfs.log"; die "unsquashfs"; }
python3 -I "$HERE/rootfs.py" "$TREE" "$BUILD" "$VERSION" "$STAMP" "$BDATE" || die "rootfs changes"
find "$TREE" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} + || die "touch"
python3 -I "$HERE/manifest.py" list "$TREE" > "$MAN" || die "manifest"
rm -f "$TREE/dev/console"     # made again by the -p pseudo definition, as in the vendor build

# vendor options; the xz tuning and reader threads exist only in the OpenWrt build of squashfs-tools
opts=(-nopad -noappend -root-owned -comp xz)
help=$("$MKSQ" -help-all 2>&1; "$MKSQ" -help 2>&1)
if echo "$help" | grep -q -- '-Xpreset'; then
    opts+=(-Xpreset 9 -Xe -Xlc 0 -Xlp 2 -Xpb 2)
else
    echo "-- $MKSQ has no -Xpreset/-Xe/-Xlc/-Xlp/-Xpb: plain xz options (the image is a little larger)"
fi
opts+=(-p '/dev d 755 0 0' -p '/dev/console c 600 0 0 5 1' -no-xattrs)
echo "$help" | grep -q -- '-block-readers' && opts+=(-block-readers 4 -small-readers 4)
opts+=(-quiet -b 64k)
"$MKSQ" "$TREE" "$OUTSQ" "${opts[@]}" > "$TREE.mksquashfs.log" 2>&1 || { tail -n 5 "$TREE.mksquashfs.log"; die "mksquashfs"; }
echo "OK: squashfs $(stat -c%s "$OUTSQ") bytes ($MKSQ: $("$MKSQ" -version 2>&1 | head -n 1))"
