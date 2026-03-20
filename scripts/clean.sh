#!/bin/bash
# Clean Tauri/Rust build artifacts to reclaim disk space.
#
# Usage:
#   ./scripts/clean.sh          # clean Rust target dirs only (~12 GB)
#   ./scripts/clean.sh --all    # also remove node_modules, dist, .turbo
#   ./scripts/clean.sh --dry    # show what would be removed and sizes
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ALL=false
DRY=false

for arg in "$@"; do
  case "$arg" in
    --all) ALL=true ;;
    --dry) DRY=true ;;
    -h|--help)
      sed -n '2,6p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

cleaned=0

remove() {
  local path="$1"
  if [ -e "$path" ]; then
    local size
    size="$(du -sh "$path" 2>/dev/null | cut -f1)"
    if $DRY; then
      echo "[dry run] would remove $path ($size)"
    else
      echo "removing $path ($size)"
      rm -rf "$path"
    fi
    cleaned=1
  fi
}

# Rust build output (.cargo/config.toml sets target-dir = ".build")
remove "$ROOT/.build"

if $ALL; then
  # Frontend build output
  remove "$ROOT/apps/desktop/dist"

  # Node modules
  remove "$ROOT/node_modules"
  remove "$ROOT/apps/desktop/node_modules"
  remove "$ROOT/packages/core/node_modules"
  remove "$ROOT/packages/db/node_modules"

  # Turbo cache
  remove "$ROOT/.turbo"
fi

if [ "$cleaned" -eq 0 ]; then
  echo "nothing to clean"
elif $DRY; then
  echo ""
  echo "run without --dry to remove"
fi
