#!/bin/bash
# build.sh - swbatch, batch client of the kernel "switch" netlink interface (see swbatch.c).
#   src/swbatch/build.sh TOOLCHAIN_DIR OUT_DIR [SOURCE]
# Result: OUT_DIR/swbatch. SOURCE defaults to src/swbatch/swbatch.c.
set -u
. "$(dirname "$0")/../common.sh"

[ $# -ge 2 ] || die "usage: build.sh TOOLCHAIN_DIR OUT_DIR [SOURCE]"
use_toolchain "$1"
mkdir -p "$2" || die "cannot create $2"
OUT=$(cd "$2" && pwd)
SRC=${3:-$ROOT/src/swbatch/swbatch.c}
[ -f "$SRC" ] || die "no $SRC"

( cd "$(dirname "$SRC")" && "${CROSS}gcc" -Os -mips32r2 -mtune=24kc -msoft-float -Wall -Wextra -Werror \
    -o "$OUT/swbatch" "$(basename "$SRC")" ) > "$OUT/swbatch-build.log" 2>&1 || {
    cat "$OUT/swbatch-build.log"; die "swbatch build"; }
"${CROSS}strip" "$OUT/swbatch" || die "strip"
needed=$("${CROSS}readelf" -d "$OUT/swbatch" | awk -F'[][]' '/\(NEEDED\)/{print $2}' | LC_ALL=C sort | tr '\n' ' ')
[ "$needed" = "libc.so libgcc_s.so.1 " ] || die "swbatch NEEDED: $needed"
ok "swbatch: $(stat -c%s "$OUT/swbatch") bytes"
