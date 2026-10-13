#!/bin/bash
# build.sh - build the es5xp firmware image for the Ubiquiti EdgeSwitch ES-5XP from the stock image.
#   ./build.sh                 as a normal user; the root filesystem stage runs under fakeroot
# Input:  vendor/SW.v2.4.1.7.260715.1150.bin - the stock firmware from Ubiquiti (not in this repository)
# Output: out/release/SW.v2.4.1.30.<date>.<time>+es5xp-1.0.bin, its .sha256 and rootfs.manifest
#         (every file of the new root filesystem: type, mode, owner, size, sha256)
# Optional environment:
#   TOOLCHAIN=DIR          OpenWrt toolchain directory to use instead of downloading the official one
#   MKSQUASHFS, UNSQUASHFS squashfs tools to use instead of the mksquashfs4/unsquashfs4 built here
#   RELEASE_EPOCH=N        build time, seconds since 1970 UTC; fixed per release, so builds are identical
#   DL=DIR                 download cache (default dl/)
# Host tools: curl tar zstd patch make gcc python3 fakeroot sha256sum, and the zlib and liblzma headers
# (Debian/Ubuntu: zlib1g-dev liblzma-dev) for the squashfs tools built in stage 2.
set -u
ROOT=$(cd "$(dirname "$0")" && pwd)
. "$ROOT/src/common.sh"

RELEASE=1.0
BUILD_NO=30
RELEASE_EPOCH=${RELEASE_EPOCH:-1791806400}        # 2026-10-12 12:00:00 UTC
STOCK=$ROOT/vendor/SW.v2.4.1.7.260715.1150.bin
STOCK_SHA=bd78be6d67569f0d2f4b3076e6bc895350009966fec400a28f261fc48fedf48d
OUT=$ROOT/out
W=$OUT/build                                      # work directory, made again on every run

[[ "$RELEASE_EPOCH" =~ ^[0-9]+$ ]] || die "RELEASE_EPOCH must be a number"
D=$(date -u -d "@$RELEASE_EPOCH" +%y%m%d.%H%M)
VERSION=SW.ar7240.v2.4.1.$BUILD_NO.$D
STAMP="es5xp-$RELEASE $(date -u -d "@$RELEASE_EPOCH" +%Y%m%dT%H%M%SZ)"
BDATE=$(date -u -d "@$RELEASE_EPOCH" +%Y%m%d%H%M)
IMAGE=$OUT/release/SW.v2.4.1.$BUILD_NO.$D+es5xp-$RELEASE.bin
export SOURCE_DATE_EPOCH=$RELEASE_EPOCH

[ "$(id -u)" -ne 0 ] || die "run as a normal user"
for t in curl tar zstd patch make gcc python3 fakeroot sha256sum; do
    command -v $t > /dev/null || die "missing host tool: $t"
done
[ -f "$STOCK" ] || die "put the stock firmware into vendor/: $(basename "$STOCK")"
echo "$STOCK_SHA  $STOCK" | sha256sum -c --quiet - 2> /dev/null || die "$(basename "$STOCK"): sha256 is not $STOCK_SHA"
note "es5xp $RELEASE: $VERSION"

note "1/5 toolchain"
if [ -n "${TOOLCHAIN:-}" ]; then
    TC=$TOOLCHAIN
    echo "$TC"
else
    TC=$(bash "$ROOT/src/toolchain/fetch.sh" "$OUT/toolchain" | tee /dev/stderr | tail -n 1)   # its log stays visible
    [ -d "$TC" ] || die "toolchain"
fi

note "2/5 programs"
rm -rf "$W"
mkdir -p "$W/prog" || die "cannot create $W"
bash "$ROOT/src/sstrip/build.sh" "$W/prog" || die "sstrip"
# squashfs tools: the ones built here by default, so the image does not depend on the host's version
if [ -n "${MKSQUASHFS:-}" ] || [ -n "${UNSQUASHFS:-}" ]; then
    MKSQ=${MKSQUASHFS:-mksquashfs}
    UNSQ=${UNSQUASHFS:-unsquashfs}
    command -v "$MKSQ" > /dev/null && command -v "$UNSQ" > /dev/null || die "missing squashfs tools ($MKSQ, $UNSQ)"
    note "squashfs tools from the environment: $MKSQ, $UNSQ"
else
    bash "$ROOT/src/squashfs-tools/build.sh" "$W/prog" || die "squashfs-tools"
    MKSQ=$W/prog/mksquashfs4
    UNSQ=$W/prog/unsquashfs4
fi
bash "$ROOT/src/busybox/build.sh" "$TC" "$W/prog" || die "busybox"
bash "$ROOT/src/dropbear/build.sh" "$TC" "$W/prog" || die "dropbear"
bash "$ROOT/src/swbatch/build.sh" "$TC" "$W/prog" || die "swbatch"

note "3/5 stock image"
python3 -I "$ROOT/tools/fwimage.py" extract "$STOCK" "$W/stock" > /dev/null || die "stock image"

note "4/5 root filesystem"
mkdir -p "$OUT/release"
rm -f "$OUT"/release/*
MKSQUASHFS=$MKSQ UNSQUASHFS=$UNSQ fakeroot -- bash "$ROOT/tools/mkrootfs.sh" "$W/stock/rootfs.sqsh" "$W/rootfs" \
    "$W/prog" "$VERSION" "$STAMP" "$BDATE" "$W/rootfs.sqsh" "$OUT/release/rootfs.manifest" || die "root filesystem"

note "5/5 image"
python3 -I "$ROOT/tools/fwimage.py" build "$STOCK" "$W/rootfs.sqsh" "$VERSION" "$IMAGE" || die "image"
(cd "$OUT/release" && sha256sum "$(basename "$IMAGE")" > "$(basename "$IMAGE").sha256") || die "sha256"
ok "$(cat "$IMAGE.sha256")"
