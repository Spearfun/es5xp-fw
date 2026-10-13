# common.sh - helpers shared by the component build scripts (sourced, not executed).
# Variables after sourcing:
#   ROOT  repository root
#   DL    download cache (default $ROOT/dl, override with env DL)

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DL=${DL:-$ROOT/dl}

die()  { echo "FATAL: $*" >&2; exit 1; }
note() { echo "-- $*"; }
ok()   { echo "OK: $*"; }

# fetch FILE SHA256 URL...
# Make sure $DL/FILE exists and has the given sha256. A file already in $DL is reused;
# otherwise the URLs are tried in order. A file can also be placed into $DL by hand.
fetch() {
    local f=$1 sum=$2 u
    shift 2
    mkdir -p "$DL" || die "cannot create $DL"
    if [ -f "$DL/$f" ]; then
        echo "$sum  $DL/$f" | sha256sum -c --quiet - >/dev/null 2>&1 && return 0
        die "$DL/$f exists but its sha256 is not $sum (remove it)"
    fi
    for u in "$@"; do
        note "download $u"
        rm -f "$DL/$f.part"
        if curl -fL --retry 2 --connect-timeout 20 -o "$DL/$f.part" "$u"; then
            if echo "$sum  $DL/$f.part" | sha256sum -c --quiet - >/dev/null 2>&1; then
                mv "$DL/$f.part" "$DL/$f"
                return 0
            fi
            echo "sha256 mismatch: $u" >&2
        fi
    done
    rm -f "$DL/$f.part"
    die "cannot get $f (sha256 $sum); download it by hand into $DL/"
}

# use_toolchain DIR
# DIR is the OpenWrt toolchain directory toolchain-mips_24kc_gcc-14.3.0_musl.
# Sets TC (absolute path) and CROSS (tool prefix), puts the tools on PATH.
# STAGING_DIR is read by the OpenWrt gcc specs; it points to an empty target staging directory.
use_toolchain() {
    [ -n "${1:-}" ] || die "toolchain directory not given"
    TC=$(cd "$1" 2>/dev/null && pwd) || die "no toolchain directory $1"
    [ -x "$TC/bin/mips-openwrt-linux-musl-gcc" ] || die "$TC: no bin/mips-openwrt-linux-musl-gcc"
    CROSS=mips-openwrt-linux-musl-
    export PATH="$TC/bin:$PATH"
    export STAGING_DIR="${STAGING_DIR:-$ROOT/out/staging}"
    mkdir -p "$STAGING_DIR/usr/lib" || die "cannot create $STAGING_DIR"
}

# OpenWrt 25.12 target flags for ath79 (mips_24kc), as in its build logs
OWRT_CFLAGS="-Os -pipe -mno-branch-likely -mips32r2 -mtune=24kc -fno-caller-saves -fno-plt -fhonour-copts -msoft-float"
