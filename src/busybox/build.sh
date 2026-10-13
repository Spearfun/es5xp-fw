#!/bin/bash
# build.sh - busybox 1.38.0 for ES-5XP: upstream source + OpenWrt patches + our config.
#   src/busybox/build.sh TOOLCHAIN_DIR OUT_DIR [prepare|build|all]
# Result: OUT_DIR/busybox (stripped) and OUT_DIR/busybox.links (applet list).
# Needs SOURCE_DATE_EPOCH: busybox prints the build time in its banner, taken from it.
# TZ is fixed to UTC, otherwise the banner depends on the time zone of the build host.
# Flags are those of the OpenWrt 25.12 busybox package; MIPS16 is not used. Serial make, as for 4d.
set -u
. "$(dirname "$0")/../common.sh"

VER=1.38.0
TARBALL=busybox-$VER.tar.bz2
SHA=34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2
HERE=$ROOT/src/busybox

[ $# -ge 2 ] || die "usage: build.sh TOOLCHAIN_DIR OUT_DIR [prepare|build|all]"
use_toolchain "$1"
mkdir -p "$2" || die "cannot create $2"
OUT=$(cd "$2" && pwd)
STAGE=${3:-all}
W=$OUT/busybox-$VER

# .config without the time stamp line written by every oldconfig
cfg() { grep -Ev '^# [A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$' "$1"; }

prepare() {
    fetch "$TARBALL" "$SHA" "https://www.busybox.net/downloads/$TARBALL" "https://sources.buildroot.net/busybox/$TARBALL" \
        "https://sources.openwrt.org/$TARBALL"
    rm -rf "$W"
    tar -xjf "$DL/$TARBALL" -C "$OUT" || die "unpack $TARBALL"
    for p in "$HERE"/patches/*.patch; do
        patch -d "$W" -p1 -s --no-backup-if-mismatch < "$p" || die "patch $(basename "$p")"
    done
    cp "$HERE/busybox.config" "$W/.config" || die "copy config"
    ok "busybox $VER prepared in $W"
}

build() {
    [ -f "$W/.config" ] || die "not prepared: $W"
    : "${SOURCE_DATE_EPOCH:?set SOURCE_DATE_EPOCH}"
    export SOURCE_DATE_EPOCH TZ=UTC
    local fl hard inc
    fl="$OWRT_CFLAGS -fmacro-prefix-map=$W=busybox-$VER"
    hard="-flto=auto -fno-fat-lto-objects -fstack-protector -D_FORTIFY_SOURCE=1 -Wl,-z,now -Wl,-z,relro"
    inc="-I$TC/usr/include -I$TC/include -I$TC/include/fortify"
    local v=(
        AR="${CROSS}gcc-ar" AS="${CROSS}gcc -c $fl $hard" NM="${CROSS}gcc-nm"
        CC="${CROSS}gcc" GCC="${CROSS}gcc" CXX="${CROSS}g++" RANLIB="${CROSS}gcc-ranlib"
        STRIP="${CROSS}strip" OBJCOPY="${CROSS}objcopy" OBJDUMP="${CROSS}objdump" SIZE="${CROSS}size"
        CROSS="$CROSS" ARCH=mips
        EXTRA_CFLAGS="$fl $hard $inc"
        EXTRA_LDFLAGS="-L$TC/usr/lib -L$TC/lib -fuse-ld=bfd -flto=auto -fuse-linker-plugin -znow -zrelro $fl $hard"
        LDLIBS="" LD="${CROSS}gcc" SKIP_STRIP=y
    )
    cd "$W" || die "cd $W"
    yes n | make "${v[@]}" oldconfig > "$OUT/busybox-oldconfig.log" 2>&1 || die "oldconfig (see $OUT/busybox-oldconfig.log)"
    diff <(cfg "$HERE/busybox.config") <(cfg .config) > /dev/null || die "oldconfig changed .config: the config is incomplete"
    make "${v[@]}" all busybox.links > "$OUT/busybox-build.log" 2>&1 || {
        tail -n 30 "$OUT/busybox-build.log"; die "busybox build (see $OUT/busybox-build.log)"; }
    "${CROSS}strip" --strip-all -o "$OUT/busybox" busybox || die "strip"
    cp busybox.links "$OUT/busybox.links" || die "busybox.links"
    local needed
    needed=$("${CROSS}readelf" -d "$OUT/busybox" | awk -F'[][]' '/\(NEEDED\)/{print $2}' | LC_ALL=C sort | tr '\n' ' ')
    [ "$needed" = "libc.so libgcc_s.so.1 " ] || die "busybox NEEDED: $needed"
    ok "busybox: $(stat -c%s "$OUT/busybox") bytes, $(wc -l < "$OUT/busybox.links") applets"
}

case "$STAGE" in
prepare) prepare ;;
build) build ;;
all) prepare; build ;;
*) die "unknown stage $STAGE" ;;
esac
