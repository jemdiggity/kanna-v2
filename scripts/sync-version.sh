#!/bin/bash
# Generate VERSION from git tag + branch + commit, then sync to build configs.
#
# Version format:
#   Tagged commit:  1.2.3
#   Untagged:       0.0.0-dev.main.abc1234
#
# The generated VERSION file is read by:
#   - Daemon build.rs (compile-time env var)
#   - tauri.conf.json (app version)
set -e
ROOT="$(git rev-parse --show-toplevel)"

COMMIT="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Get version from latest tag (strip leading 'v')
TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
if [ -n "$TAG" ] && [ "$(git rev-list -n1 "$TAG")" = "$(git rev-parse HEAD)" ]; then
  # HEAD is the tagged commit — use the tag as-is
  VERSION="${TAG#v}"
else
  # Not on a tag — dev version
  BASE="${TAG#v}"
  BASE="${BASE:-0.0.0}"
  VERSION="${BASE}-dev.${BRANCH}.${COMMIT}"
fi

echo "$VERSION" > "$ROOT/VERSION"

# Sync to tauri.conf.json (only the semver part — Tauri rejects prerelease strings)
SEMVER="$(echo "$VERSION" | cut -d- -f1)"
TAURI_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.json"
if [ -f "$TAURI_CONF" ]; then
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$SEMVER\"/" "$TAURI_CONF"
fi
