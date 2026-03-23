#!/bin/bash
set -e

# iOS build + deploy script for Kanna Mobile
# Usage: ./scripts/ios-deploy.sh [--release]
#
# Uses `tauri ios build` which handles:
#   1. Frontend build (vite)
#   2. Rust cross-compilation (aarch64-apple-ios)
#   3. Xcode build + codesign
#   4. IPA export

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVICE_ID="00008130-001015CA1091401C"

export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

TAURI_FLAGS="--debug"
if [[ "$1" == "--release" ]]; then
  TAURI_FLAGS=""
fi

echo "=== Building iOS app ==="
cd "$MOBILE_DIR"
bunx tauri ios build $TAURI_FLAGS 2>&1 | tail -10

IPA_PATH="$MOBILE_DIR/src-tauri/gen/apple/build/arm64/Kanna Mobile.ipa"
if [[ ! -f "$IPA_PATH" ]]; then
  echo "ERROR: IPA not found at $IPA_PATH"
  exit 1
fi

echo "=== Installing on device ==="
xcrun devicectl device install app --device "$DEVICE_ID" "$IPA_PATH"

echo "=== Launching ==="
xcrun devicectl device process launch --device "$DEVICE_ID" com.kanna.mobile

echo "=== Done ==="
