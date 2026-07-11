#!/usr/bin/env bash
# Generate the TypeScript mirrors of crates/kanna-agent-protocol. The Rust
# crate is the schema source of truth; run this after changing any #[ts(export)]
# type. The Firebase functions source keeps a generated, type-only provider
# mirror because its deployment package must not depend on workspace packages.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_OUT_DIR="$REPO_ROOT/packages/agent-protocol/src/generated"
OUT_DIR="${1:-$DEFAULT_OUT_DIR}"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.ts

TS_RS_EXPORT_DIR="$OUT_DIR" cargo test \
  --manifest-path "$REPO_ROOT/Cargo.toml" \
  -p kanna-agent-protocol \
  --features typescript \
  export_bindings \
  --quiet

if [[ "$OUT_DIR" == "$DEFAULT_OUT_DIR" ]]; then
  CLOUD_GENERATED_DIR="$REPO_ROOT/services/firebase-functions/src/generated"
  mkdir -p "$CLOUD_GENERATED_DIR"
  cp "$OUT_DIR/AgentProvider.ts" "$CLOUD_GENERATED_DIR/AgentProvider.ts"
fi

echo "Generated $(ls "$OUT_DIR" | wc -l | tr -d ' ') type files in $OUT_DIR"
