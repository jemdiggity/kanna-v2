#!/bin/bash
# Stage kanna-daemon and kanna-hook binaries for Tauri's externalBin bundling.
# Tauri expects binaries named with a target triple suffix, e.g.:
#   binaries/kanna-daemon-aarch64-apple-darwin
#
# Usage:
#   ./scripts/stage-sidecars.sh                           # debug build, host target
#   ./scripts/stage-sidecars.sh --release --target aarch64-apple-darwin
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARIES_DIR="$ROOT/apps/desktop/src-tauri/binaries"
BUILD_DIR="$ROOT/.build"

# Parse arguments
PROFILE="debug"
TARGET=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --release) PROFILE="release"; shift ;;
        --target) TARGET="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Default to host target triple
if [[ -z "$TARGET" ]]; then
    TARGET=$(rustc -vV | grep '^host:' | awk '{print $2}')
fi

# Determine source directory
if [[ "$PROFILE" = "release" ]]; then
    SRC_DIR="$BUILD_DIR/$TARGET/release"
else
    SRC_DIR="$BUILD_DIR/debug"
fi

mkdir -p "$BINARIES_DIR"

for BIN in kanna-daemon kanna-hook; do
    SRC="$SRC_DIR/$BIN"
    DEST="$BINARIES_DIR/${BIN}-${TARGET}"
    if [[ ! -f "$SRC" ]]; then
        echo "Error: $SRC not found. Build it first." >&2
        exit 1
    fi
    cp "$SRC" "$DEST"
    chmod +x "$DEST"
done

echo "    Staged sidecars for $TARGET ($PROFILE) → $BINARIES_DIR"
