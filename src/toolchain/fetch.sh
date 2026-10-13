#!/bin/bash
# fetch.sh - get the OpenWrt 25.12.0 toolchain for ath79 (mips_24kc, GCC 14.3.0, musl) and unpack it.
#   src/toolchain/fetch.sh OUT_DIR
# Result: OUT_DIR/openwrt-toolchain-.../toolchain-mips_24kc_gcc-14.3.0_musl (path printed on the last line);
# an archive already unpacked there is reused.
# This is the toolchain OpenWrt publishes with its 25.12.0 release (revision r32713-f919e7899d,
# the same revision the vendor firmware 2.4.1 was built from). Needs zstd. About 300 MB unpacked.
set -u
. "$(dirname "$0")/../common.sh"

NAME=openwrt-toolchain-25.12.0-ath79-generic_gcc-14.3.0_musl.Linux-x86_64
TARBALL=$NAME.tar.zst
SHA=63ed967c34497bedfaee6ecca5ce88fcb5634955d613a5687fabae2427abdd32
URL=https://downloads.openwrt.org/releases/25.12.0/targets/ath79/generic/$TARBALL

[ $# -ge 1 ] || die "usage: fetch.sh OUT_DIR"
command -v zstd >/dev/null || die "zstd is needed to unpack $TARBALL"
mkdir -p "$1" || die "cannot create $1"
OUT=$(cd "$1" && pwd)

TCDIR=$OUT/$NAME/toolchain-mips_24kc_gcc-14.3.0_musl
if [ "$(cat "$OUT/$NAME/.unpacked" 2>/dev/null)" = "$SHA" ] && [ -x "$TCDIR/bin/mips-openwrt-linux-musl-gcc" ]; then
    ok "toolchain already unpacked"      # same archive as last time
    echo "$TCDIR"
    exit 0
fi
fetch "$TARBALL" "$SHA" "$URL"
rm -rf "$OUT/$NAME"
tar --zstd -xf "$DL/$TARBALL" -C "$OUT" || die "unpack $TARBALL"
[ -x "$TCDIR/bin/mips-openwrt-linux-musl-gcc" ] || die "no $NAME/toolchain-mips_24kc_gcc-14.3.0_musl in $TARBALL"
echo "$SHA" > "$OUT/$NAME/.unpacked"
ok "toolchain unpacked: $(du -sh "$TCDIR" | cut -f1)"
echo "$TCDIR"
