#!/bin/bash
# Generate VERSION from git state, sync to tauri.conf.json.
#
# Clean main at tag:     1.2.3
# Clean main after tag:  1.2.3-dev.abc1234
# Feature branch:        1.2.3-dev.my-branch.abc1234
# No tags:               0.0.0-dev.abc1234
set -e
ROOT="$(git rev-parse --show-toplevel)"

COMMIT="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DIRTY="$(git status --porcelain 2>/dev/null | head -1)"

# Latest tag (strip leading 'v')
TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
BASE="${TAG#v}"
BASE="${BASE:-0.0.0}"

TAG_COMMIT="$([ -n "$TAG" ] && git rev-list -n1 "$TAG" || echo "")"
HEAD_COMMIT="$(git rev-parse HEAD)"

if [ "$TAG_COMMIT" = "$HEAD_COMMIT" ] && [ -z "$DIRTY" ]; then
  # Exactly on a tag, clean working dir
  VERSION="$BASE"
elif [ "$BRANCH" = "main" ]; then
  VERSION="${BASE}-dev.${COMMIT}"
else
  VERSION="${BASE}-dev.${BRANCH}.${COMMIT}"
fi

# Only write if changed
VERSION_FILE="$ROOT/VERSION"
if [ -f "$VERSION_FILE" ] && [ "$(cat "$VERSION_FILE")" = "$VERSION" ]; then
  exit 0
fi

echo "$VERSION" > "$VERSION_FILE"

# Sync to tauri.conf.json (semver only — Tauri rejects prerelease strings)
SEMVER="$(echo "$VERSION" | cut -d- -f1)"
TAURI_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.json"
if [ -f "$TAURI_CONF" ]; then
  CURRENT="$(grep '"version"' "$TAURI_CONF" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')"
  if [ "$CURRENT" != "$SEMVER" ]; then
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$SEMVER\"/" "$TAURI_CONF"
  fi

  # Sync devUrl port from env var (set by Kanna when spawning worktree agents)
  if [ -n "$KANNA_DEV_PORT" ]; then
    sed -i '' "s|http://localhost:[0-9]*|http://localhost:$KANNA_DEV_PORT|" "$TAURI_CONF"
  fi
fi
