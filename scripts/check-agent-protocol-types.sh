#!/usr/bin/env bash
# Fail when the committed TypeScript mirrors in packages/agent-protocol are
# stale relative to crates/kanna-agent-protocol. Intended for CI and
# pre-merge checks.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMITTED_DIR="$REPO_ROOT/packages/agent-protocol/src/generated"
CLOUD_PROVIDER_TYPE="$REPO_ROOT/services/firebase-functions/src/generated/AgentProvider.ts"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

"$REPO_ROOT/scripts/generate-agent-protocol-types.sh" "$TMP_DIR" > /dev/null

if ! diff -ru "$COMMITTED_DIR" "$TMP_DIR"; then
  echo ""
  echo "packages/agent-protocol/src/generated is stale."
  echo "Run scripts/generate-agent-protocol-types.sh and commit the result."
  exit 1
fi

if ! cmp -s "$CLOUD_PROVIDER_TYPE" "$TMP_DIR/AgentProvider.ts"; then
  diff -u "$CLOUD_PROVIDER_TYPE" "$TMP_DIR/AgentProvider.ts" || true
  echo ""
  echo "services/firebase-functions/src/generated/AgentProvider.ts is stale."
  echo "Run scripts/generate-agent-protocol-types.sh and commit the result."
  exit 1
fi

echo "agent-protocol TypeScript types are up to date"
