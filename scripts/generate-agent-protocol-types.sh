#!/usr/bin/env bash
# Generate the TypeScript mirrors of crates/kanna-agent-protocol into
# packages/agent-protocol/src/generated. The Rust crate is the schema source
# of truth; run this after changing any #[ts(export)] type.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/packages/agent-protocol/src/generated}"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.ts

TS_RS_EXPORT_DIR="$OUT_DIR" cargo test \
  --manifest-path "$REPO_ROOT/Cargo.toml" \
  -p kanna-agent-protocol \
  --features typescript \
  export_bindings \
  --quiet

echo "Generated $(ls "$OUT_DIR" | wc -l | tr -d ' ') type files in $OUT_DIR"
