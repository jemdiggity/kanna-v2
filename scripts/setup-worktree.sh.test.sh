#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

MAIN_REPO="$TMPDIR_ROOT/repo"
WORKTREE="$MAIN_REPO/.kanna-worktrees/task-123"

mkdir -p "$MAIN_REPO/scripts" "$MAIN_REPO/.build"
cp "$ROOT_DIR/scripts/setup-worktree.sh" "$MAIN_REPO/scripts/setup-worktree.sh"
chmod +x "$MAIN_REPO/scripts/setup-worktree.sh"
printf 'cached build artifact\n' > "$MAIN_REPO/.build/artifact.txt"

(
  cd "$MAIN_REPO"
  git init -q
  git config user.name "Kanna Test"
  git config user.email "kanna@example.com"
  git add scripts/setup-worktree.sh
  git commit -q -m "add setup script"
  git worktree add -q -b task-123 "$WORKTREE"
)

(
  cd "$WORKTREE"
  /bin/sh ./scripts/setup-worktree.sh
)

if [ ! -f "$WORKTREE/.cargo/config.toml" ]; then
  printf 'expected worktree cargo config to be created\n' >&2
  exit 1
fi

if ! grep -Fq 'target-dir = ".build"' "$WORKTREE/.cargo/config.toml"; then
  printf 'expected worktree cargo config to target .build, got:\n' >&2
  cat "$WORKTREE/.cargo/config.toml" >&2
  exit 1
fi

if grep -Fq 'build-dir' "$WORKTREE/.cargo/config.toml"; then
  printf 'expected worktree cargo config to avoid machine-specific build-dir, got:\n' >&2
  cat "$WORKTREE/.cargo/config.toml" >&2
  exit 1
fi

if [ -e "$WORKTREE/.build" ]; then
  printf 'expected setup-worktree.sh to avoid copying .build into the worktree\n' >&2
  find "$WORKTREE/.build" -maxdepth 2 -print >&2 || true
  exit 1
fi
