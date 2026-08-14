# Public Repo Config Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a stable public JSON Schema for `.kanna/config.json`, reference it from the repo config, and deploy the checked-in schema file to `https://schemas.kanna.build/config.schema.json` via GitHub Pages.

**Architecture:** Keep `.kanna/config.schema.json` as the single maintained schema artifact in the repo. Add a small build script that stages that exact file plus a `CNAME` into a Pages artifact directory, then deploy that artifact with a dedicated GitHub Pages workflow. Runtime parsing stays unchanged; the schema exists for agents, editors, and deterministic config generation.

**Tech Stack:** JSON Schema, JSON config files, Bash, Node.js, GitHub Actions Pages

---

### File Structure

- Create: `.kanna/config.schema.json`
  Purpose: canonical checked-in schema source for repo config instances
- Modify: `.kanna/config.json`
  Purpose: reference the public schema URL from the repo’s own config instance
- Create: `scripts/build-pages-schema.sh`
  Purpose: stage the checked-in schema and `CNAME` into a Pages artifact directory without creating a second maintained schema copy
- Create: `scripts/config-schema.test.sh`
  Purpose: verify the schema file shape, public URL, and config reference using deterministic JSON assertions
- Create: `.github/workflows/config-schema-pages.yml`
  Purpose: publish the staged Pages artifact to GitHub Pages on `main` and manual runs
- Modify: `scripts/repo-config.test.sh`
  Purpose: keep the existing repo config fixture checks aware of the new `"$schema"` entry

### Task 1: Add the checked-in schema artifact

**Files:**
- Create: `.kanna/config.schema.json`
- Test: `scripts/config-schema.test.sh`

- [ ] **Step 1: Write the failing test**

Create `scripts/config-schema.test.sh` with JSON assertions for the schema file and public URL contract:

```bash
#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_PATH="$ROOT_DIR/.kanna/config.schema.json"

node <<'NODE'
const fs = require("fs");
const schema = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

if (schema.$id !== "https://schemas.kanna.build/config.schema.json") {
  throw new Error(`unexpected $id: ${schema.$id}`);
}

if (schema.type !== "object") {
  throw new Error(`expected object schema, got ${schema.type}`);
}

for (const key of ["$schema", "workflow", "setup", "teardown", "test", "ports", "stage_order", "workspace"]) {
  if (!schema.properties || !(key in schema.properties)) {
    throw new Error(`missing top-level schema property: ${key}`);
  }
}

if (schema.additionalProperties !== false) {
  throw new Error("expected top-level additionalProperties=false");
}
NODE
"$SCHEMA_PATH"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/config-schema.test.sh`
Expected: FAIL because `.kanna/config.schema.json` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `.kanna/config.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.kanna.build/config.schema.json",
  "title": "Kanna Repo Config",
  "description": "Schema for .kanna/config.json used by Kanna agents and editors.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string", "format": "uri" },
    "workflow": { "type": "string" },
    "setup": { "type": "array", "items": { "type": "string" } },
    "teardown": { "type": "array", "items": { "type": "string" } },
    "test": { "type": "array", "items": { "type": "string" } },
    "ports": {
      "type": "object",
      "additionalProperties": { "type": "integer" }
    },
    "stage_order": { "type": "array", "items": { "type": "string" } },
    "workspace": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "env": {
          "type": "object",
          "additionalProperties": { "type": "string" }
        },
        "path": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "prepend": { "type": "array", "items": { "type": "string" } },
            "append": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    }
  },
  "examples": [
    {
      "setup": ["pnpm install"],
      "ports": { "KANNA_DEV_PORT": 1420 }
    },
    {
      "workspace": {
        "path": { "prepend": ["./node_modules/.bin"] }
      }
    },
    {
      "workspace": {
        "env": { "FOO": "bar" }
      }
    }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/config-schema.test.sh`
Expected: PASS.

### Task 2: Wire the schema URL into the repo config instance

**Files:**
- Modify: `.kanna/config.json`
- Modify: `scripts/repo-config.test.sh`
- Test: `scripts/config-schema.test.sh`

- [ ] **Step 1: Write the failing test**

Extend `scripts/config-schema.test.sh` to assert the repo config points at the public schema URL:

```bash
CONFIG_PATH="$ROOT_DIR/.kanna/config.json"

node <<'NODE'
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

if (config.$schema !== "https://schemas.kanna.build/config.schema.json") {
  throw new Error(`unexpected config $schema: ${config.$schema}`);
}
NODE
"$CONFIG_PATH"
```

Also extend `scripts/repo-config.test.sh` with:

```bash
assert_contains '"$schema": "https://schemas.kanna.build/config.schema.json"'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/config-schema.test.sh && bash scripts/repo-config.test.sh`
Expected: FAIL because `.kanna/config.json` does not yet include `"$schema"`.

- [ ] **Step 3: Write minimal implementation**

Add the schema reference to the checked-in config:

```json
{
  "$schema": "https://schemas.kanna.build/config.schema.json",
  "setup": [
    "/bin/sh ./scripts/setup-worktree.sh",
    "pnpm install"
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/config-schema.test.sh && bash scripts/repo-config.test.sh`
Expected: PASS.

### Task 3: Stage the GitHub Pages artifact from the checked-in schema

**Files:**
- Create: `scripts/build-pages-schema.sh`
- Test: `scripts/config-schema.test.sh`

- [ ] **Step 1: Write the failing test**

Extend `scripts/config-schema.test.sh` to run the staging script into a temp directory and verify the output:

```bash
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

"$ROOT_DIR/scripts/build-pages-schema.sh" "$TMP_DIR"

test -f "$TMP_DIR/config.schema.json"
test -f "$TMP_DIR/CNAME"

cmp "$ROOT_DIR/.kanna/config.schema.json" "$TMP_DIR/config.schema.json"

if [ "$(cat "$TMP_DIR/CNAME")" != "schemas.kanna.build" ]; then
  echo "unexpected CNAME contents" >&2
  exit 1
fi
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/config-schema.test.sh`
Expected: FAIL because `scripts/build-pages-schema.sh` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/build-pages-schema.sh`:

```bash
#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:?usage: build-pages-schema.sh <out-dir>}"

mkdir -p "$OUT_DIR"
cp "$ROOT_DIR/.kanna/config.schema.json" "$OUT_DIR/config.schema.json"
printf 'schemas.kanna.build\n' > "$OUT_DIR/CNAME"
```

Mark it executable:

```bash
chmod +x scripts/build-pages-schema.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/config-schema.test.sh`
Expected: PASS, including the staged artifact checks.

### Task 4: Add GitHub Pages deployment workflow

**Files:**
- Create: `.github/workflows/config-schema-pages.yml`
- Test: `scripts/config-schema.test.sh`

- [ ] **Step 1: Write the failing test**

Extend `scripts/config-schema.test.sh` to assert the workflow file exists and contains the expected Pages actions and custom domain string:

```bash
WORKFLOW_PATH="$ROOT_DIR/.github/workflows/config-schema-pages.yml"

grep -Fq 'actions/configure-pages@v5' "$WORKFLOW_PATH"
grep -Fq 'actions/upload-pages-artifact@v3' "$WORKFLOW_PATH"
grep -Fq 'actions/deploy-pages@v4' "$WORKFLOW_PATH"
grep -Fq 'schemas.kanna.build' "$WORKFLOW_PATH"
grep -Fq 'scripts/build-pages-schema.sh' "$WORKFLOW_PATH"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/config-schema.test.sh`
Expected: FAIL because the workflow does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `.github/workflows/config-schema-pages.yml`:

```yaml
name: Config Schema Pages

on:
  push:
    branches: [main]
    paths:
      - ".kanna/config.schema.json"
      - ".github/workflows/config-schema-pages.yml"
      - "scripts/build-pages-schema.sh"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: config-schema-pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - run: scripts/build-pages-schema.sh .build/pages-schema
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .build/pages-schema
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/config-schema.test.sh`
Expected: PASS, including workflow assertions.

### Task 5: Final verification

**Files:**
- Verify only: `.kanna/config.schema.json`, `.kanna/config.json`, `scripts/build-pages-schema.sh`, `scripts/config-schema.test.sh`, `.github/workflows/config-schema-pages.yml`, `scripts/repo-config.test.sh`

- [ ] **Step 1: Run focused verification**

Run: `bash scripts/config-schema.test.sh`
Expected: PASS.

- [ ] **Step 2: Re-run existing repo config verification**

Run: `bash scripts/repo-config.test.sh`
Expected: PASS.

- [ ] **Step 3: Re-run parser regression coverage**

Run: `pnpm test -- repo-config.test.ts`
Expected: PASS from `packages/core`.

- [ ] **Step 4: Commit**

```bash
git add .kanna/config.json .kanna/config.schema.json scripts/build-pages-schema.sh scripts/config-schema.test.sh scripts/repo-config.test.sh .github/workflows/config-schema-pages.yml docs/superpowers/specs/2026-04-24-config-schema-design.md docs/superpowers/plans/2026-04-24-config-schema.md
git commit -m "feat: publish kanna config schema"
```
