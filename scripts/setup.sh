#!/bin/bash
# Verify (and optionally install) all prerequisites for developing Kanna.
#
# Usage:
#   ./scripts/setup.sh           # check prereqs + install dependencies
#   ./scripts/setup.sh --check   # check prereqs only (no install)
set -e

CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
  esac
done

PASS=0
WARN=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { WARN=$((WARN + 1)); printf "  \033[33m!\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

section() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# ── Required tools ──────────────────────────────────────────────────

section "Required tools"

# Xcode Command Line Tools (macOS — provides clang, WebKit, macOS SDK)
if xcode-select -p &>/dev/null; then
  pass "Xcode Command Line Tools"
else
  fail "Xcode Command Line Tools — install with: xcode-select --install"
fi

# Rust / Cargo
if command -v rustc &>/dev/null; then
  rust_ver="$(rustc --version | awk '{print $2}')"
  pass "Rust $rust_ver"
else
  fail "Rust — install from https://rustup.rs"
fi

if command -v cargo &>/dev/null; then
  pass "Cargo"
else
  fail "Cargo — comes with Rust, install from https://rustup.rs"
fi

# Bun
BUN_REQUIRED="1.3.9"
if command -v bun &>/dev/null; then
  bun_ver="$(bun --version)"
  if printf '%s\n%s\n' "$BUN_REQUIRED" "$bun_ver" | sort -V | head -n1 | grep -qx "$BUN_REQUIRED"; then
    pass "Bun $bun_ver (>= $BUN_REQUIRED)"
  else
    fail "Bun $bun_ver is too old — need >= $BUN_REQUIRED. Update with: bun upgrade"
  fi
else
  fail "Bun — install from https://bun.sh"
fi

# Git
if command -v git &>/dev/null; then
  git_ver="$(git --version | awk '{print $3}')"
  pass "Git $git_ver"
else
  fail "Git — install with: brew install git"
fi

# tmux (used by dev.sh)
if command -v tmux &>/dev/null; then
  tmux_ver="$(tmux -V | awk '{print $2}')"
  pass "tmux $tmux_ver"
else
  fail "tmux — install with: brew install tmux"
fi

# ── Optional tools ──────────────────────────────────────────────────

section "Optional tools"

# Claude CLI (needed for integration tests and agent tasks)
if command -v claude &>/dev/null; then
  pass "Claude CLI"
else
  warn "Claude CLI not found — needed for integration tests and agent tasks"
fi

# ── Dependencies ────────────────────────────────────────────────────

section "Dependencies"

if [ "$CHECK_ONLY" = true ]; then
  if [ -d "node_modules" ]; then
    pass "node_modules present (skipping install — --check mode)"
  else
    warn "node_modules missing — run without --check to install"
  fi
else
  if [ "$FAIL" -gt 0 ]; then
    printf "\n\033[31mFix the issues above before installing dependencies.\033[0m\n"
  else
    printf "  Installing dependencies with bun...\n"
    bun install
    pass "bun install (includes Tauri CLI via @tauri-apps/cli)"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────

section "Summary"
printf "  %s passed, %s warnings, %s failed\n" "$PASS" "$WARN" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf "\n\033[31mSome required tools are missing. See above for install instructions.\033[0m\n"
  exit 1
fi

if [ "$CHECK_ONLY" = false ] && [ "$FAIL" -eq 0 ]; then
  printf "\n\033[32mReady! Start the dev server with: ./scripts/dev.sh\033[0m\n"
fi
