#!/bin/bash
# build.sh - dropbear 2026.94 for ES-5XP, built the way the OpenWrt 25.12 package builds it.
#   src/dropbear/build.sh TOOLCHAIN_DIR OUT_DIR [prepare|build|all]
# Result: OUT_DIR/dropbear (multi-call binary: dropbear, dbclient, dropbearkey, scp), stripped with sstrip -z.
# Needs OUT_DIR/sstrip (src/sstrip/build.sh).
#
# Differences from the OpenWrt package build, same result:
#  - patches 900 and 901 edit configure.ac; OpenWrt regenerates configure (autoreconf). Here the upstream
#    configure is used and given what those edits change: --disable-harden (900 removes the hardening flags
#    that OpenWrt sets itself) and an empty LTM_CFLAGS (901 removes the -O3 default for libtommath);
#  - OpenWrt's autoconf 2.72 adds -std=gnu23 to CC for the configure tests; it is passed here explicitly.
#    The compiler is then called without it, as OpenWrt does (CC is overridden on the make command line);
#  - localoptions.h is the file OpenWrt generated from its configuration (kept as is), and
#    DROPBEAR_CLI_MULTIHOP is set to 0 in src/sysoptions.h, as OpenWrt does.
# OpenWrt configuration used: PIE, LTO, gc-sections, no MIPS16. OpenWrt also passes --disable-ipv6
# (its global IPv6 option is off); dropbear's configure does not know it and ignores it, so it is left out.
set -u
. "$(dirname "$0")/../common.sh"

VER=2026.94
TARBALL=dropbear-$VER.tar.bz2
SHA=e098034a843699200c8c977a991fff73159735bf795d5f72ef672c41a6b1ae81
HERE=$ROOT/src/dropbear

[ $# -ge 2 ] || die "usage: build.sh TOOLCHAIN_DIR OUT_DIR [prepare|build|all]"
use_toolchain "$1"
mkdir -p "$2" || die "cannot create $2"
OUT=$(cd "$2" && pwd)
STAGE=${3:-all}
W=$OUT/dropbear-$VER

prepare() {
    fetch "$TARBALL" "$SHA" "https://matt.ucc.asn.au/dropbear/releases/$TARBALL" "https://dropbear.nl/mirror/releases/$TARBALL" \
        "https://sources.openwrt.org/$TARBALL"
    rm -rf "$W"
    tar -xjf "$DL/$TARBALL" -C "$OUT" || die "unpack $TARBALL"
    for p in "$HERE"/patches/*.patch; do
        patch -d "$W" -p1 -s --no-backup-if-mismatch < "$p" || die "patch $(basename "$p")"
    done
    sed -i 's/^#define DROPBEAR_CLI_MULTIHOP .*$/#define DROPBEAR_CLI_MULTIHOP 0/' "$W/src/sysoptions.h" || die "sysoptions.h"
    grep -qx '#define DROPBEAR_CLI_MULTIHOP 0' "$W/src/sysoptions.h" || die "DROPBEAR_CLI_MULTIHOP not set"
    ok "dropbear $VER prepared in $W"
}

build() {
    [ -f "$W/configure" ] || die "not prepared: $W"
    [ -x "$OUT/sstrip" ] || die "no $OUT/sstrip (build it with src/sstrip/build.sh)"
    local cflags cppflags ldflags tools
    cflags="$OWRT_CFLAGS -fmacro-prefix-map=$W=dropbear-$VER -ffunction-sections -fdata-sections"
    cflags="$cflags -flto=auto -fno-fat-lto-objects -Wformat -Werror=format-security -DPIC -fpic"
    cflags="$cflags -fstack-protector -D_FORTIFY_SOURCE=1 -Wl,-z,now -Wl,-z,relro -DARGTYPE=3"
    cppflags="-I$TC/usr/include -I$TC/include -I$TC/include/fortify"
    ldflags="-L$TC/usr/lib -L$TC/lib -fuse-ld=bfd -Wl,--gc-sections -flto=auto -fuse-linker-plugin"
    ldflags="$ldflags -DPIC -fpic -specs=$HERE/hardened-ld-pie.specs -znow -zrelro"
    tools=(AR="${CROSS}gcc-ar" AS="${CROSS}gcc -c" LD="${CROSS}ld" NM="${CROSS}gcc-nm" CC="${CROSS}gcc"
           GCC="${CROSS}gcc" CXX="${CROSS}g++" RANLIB="${CROSS}gcc-ranlib" STRIP="${CROSS}strip"
           OBJCOPY="${CROSS}objcopy" OBJDUMP="${CROSS}objdump" SIZE="${CROSS}size")
    cd "$W" || die "cd $W"
    rm -f localoptions.h
    env "${tools[@]}" CC="${CROSS}gcc -std=gnu23" CFLAGS="$cflags" CPPFLAGS="$cppflags" LDFLAGS="$ldflags" \
        ./configure --target=mips-openwrt-linux --host=mips-openwrt-linux --build=x86_64-pc-linux-gnu \
        --disable-dependency-tracking --program-prefix= --program-suffix= --prefix=/usr --exec-prefix=/usr \
        --bindir=/usr/bin --sbindir=/usr/sbin --libexecdir=/usr/lib --sysconfdir=/etc --datadir=/usr/share \
        --localstatedir=/var --mandir=/usr/man --infodir=/usr/info --disable-nls \
        --disable-pam --disable-pututxline --disable-utmpx --disable-wtmpx --disable-lastlog \
        --disable-loginfunc --disable-pututline --disable-static --disable-utmp --disable-wtmp \
        --disable-zlib --enable-bundled-libtom --disable-harden LTM_CFLAGS=' ' \
        > "$OUT/dropbear-configure.log" 2>&1 || die "configure (see $OUT/dropbear-configure.log)"
    cp "$HERE/localoptions.h" localoptions.h || die "localoptions.h"
    make -j"$(nproc)" "${tools[@]}" IGNORE_SPEED=1 PROGRAMS="dropbear dbclient dropbearkey scp" \
        MULTI=1 SCPPROGRESS=1 > "$OUT/dropbear-build.log" 2>&1 || {
        tail -n 30 "$OUT/dropbear-build.log"; die "dropbear build (see $OUT/dropbear-build.log)"; }
    install -m 0755 dropbearmulti "$OUT/dropbear" || die "install"
    "$OUT/sstrip" -z "$OUT/dropbear" || die "sstrip"
    ok "dropbear: $(stat -c%s dropbearmulti) bytes, after sstrip -z $(stat -c%s "$OUT/dropbear")"
}

case "$STAGE" in
prepare) prepare ;;
build) build ;;
all) prepare; build ;;
*) die "unknown stage $STAGE" ;;
esac
