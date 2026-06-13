# PNPM Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Bun with pnpm and Node-based tooling for package management, script execution, test execution, and Bun runtime APIs without breaking the desktop app, worktree dev flow, or release builds.

**Architecture:** The migration is split into two phases. First, switch workspace metadata, package scripts, shell scripts, and Tauri hooks from Bun commands to pnpm/Node equivalents while preserving current behavior. Second, replace Bun-specific test/runtime APIs (`bun:test`, `Bun.spawn`, `Bun.Glob`, `Bun.file`, `Bun.sleep`) with Vitest and Node-compatible utilities so the repo runs without Bun installed.

**Tech Stack:** pnpm workspaces, Node 22, Turbo, Vitest, tsx, fast-glob, execa, Tauri v2, Vue 3, Rust, tmux

---

### Task 1: Add pnpm workspace metadata and root package-manager config

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json`

- [ ] **Step 1: Write the failing workspace bootstrap check**

```bash
pnpm install --frozen-lockfile
```

Expected: FAIL because `pnpm-workspace.yaml` does not exist and the repo still declares `"packageManager": "bun@1.3.9"`.

- [ ] **Step 2: Add pnpm workspace metadata**

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "services/*"
  - "tests/*"
```

Save as `pnpm-workspace.yaml`.

- [ ] **Step 3: Update root package-manager metadata**

Replace the root `package.json` header with:

```json
{
  "name": "kanna",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "build": "turbo build",
    "dev": "./scripts/dev.sh",
    "test": "turbo test",
    "lint": "turbo lint"
  },
  "devDependencies": {
    "happy-dom": "^20.8.4",
    "turbo": "^2",
    "typescript": "^5.7"
  },
  "packageManager": "pnpm@10.8.1"
}
```

- [ ] **Step 4: Run install to generate the lockfile**

Run: `pnpm install`

Expected: PASS and generate `pnpm-lock.yaml`. The install may still surface follow-on failures from Bun-specific scripts; that is acceptable at this stage as long as dependency resolution works.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "build: add pnpm workspace metadata"
```

### Task 2: Convert package scripts from Bun commands to pnpm/Node equivalents

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/mobile/package.json`
- Modify: `tests/cli-contract/package.json`

- [ ] **Step 1: Write the failing script-audit check**

Run: `rg -n '"(test|test:e2e|test:e2e:real|test:e2e:all|tauri|tauri:dev|tauri:build)"\\s*:\\s*".*bun' apps/desktop/package.json apps/mobile/package.json tests/cli-contract/package.json`

Expected: FAIL with matches showing Bun-backed scripts.

- [ ] **Step 2: Update `apps/desktop/package.json` scripts**

Replace the scripts block with:

```json
"scripts": {
  "dev": "vite",
  "build:sidecars": "cargo build --manifest-path ../../crates/daemon/Cargo.toml && cargo build --manifest-path ../../crates/kanna-cli/Cargo.toml && cargo build --manifest-path ../../packages/terminal-recovery/Cargo.toml && ../../scripts/stage-sidecars.sh",
  "build": "vue-tsc --noEmit && vite build",
  "preview": "vite preview",
  "tauri": "tauri",
  "tauri:dev": "tauri dev",
  "tauri:build": "tauri build",
  "test": "vitest run",
  "test:e2e": "tsx tests/e2e/run.ts mock/",
  "test:e2e:real": "tsx tests/e2e/run.ts real/",
  "test:e2e:all": "tsx tests/e2e/run.ts"
}
```

- [ ] **Step 3: Ensure `apps/desktop` has the runtime tools it now uses**

Add these dev dependencies in `apps/desktop/package.json` if missing:

```json
"devDependencies": {
  "@tauri-apps/cli": "^2",
  "@types/markdown-it": "^14.1.1",
  "@vitejs/plugin-vue": "^5.2.1",
  "@vue/test-utils": "^2.4.6",
  "fast-glob": "^3.3.3",
  "happy-dom": "^20.8.9",
  "tsx": "^4.19.0",
  "typescript": "~5.6.2",
  "vite": "^6.0.3",
  "vitest": "^4.1.2",
  "vue-tsc": "^2.1.10"
}
```

- [ ] **Step 4: Update `tests/cli-contract/package.json`**

Replace it with:

```json
{
  "name": "@kanna/cli-contract",
  "private": true,
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "execa": "^9.6.0",
    "tsx": "^4.19.0",
    "vitest": "^4.1.2"
  }
}
```

- [ ] **Step 5: Update `apps/mobile/package.json` only if any Bun-backed commands remain**

The scripts should remain:

```json
"scripts": {
  "dev": "vite",
  "build": "vue-tsc --noEmit && vite build",
  "tauri": "tauri",
  "tauri:dev": "tauri dev",
  "tauri:build": "tauri build"
}
```
```
No Bun command should remain in this file.
```

- [ ] **Step 6: Run the package-script verification**

Run: `rg -n '"(test|test:e2e|test:e2e:real|test:e2e:all|tauri|tauri:dev|tauri:build)"\\s*:\\s*".*bun' apps/desktop/package.json apps/mobile/package.json tests/cli-contract/package.json`

Expected: PASS with no matches.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json apps/mobile/package.json tests/cli-contract/package.json pnpm-lock.yaml
git commit -m "build: switch package scripts off bun"
```

### Task 3: Replace Bun command usage in shell scripts and Tauri hooks

**Files:**
- Modify: `scripts/dev.sh`
- Modify: `scripts/mobile-dev.sh`
- Modify: `scripts/setup.sh`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

- [ ] **Step 1: Write the failing command scan**

Run: `rg -n '\\bbun\\b|\\bbunx\\b' scripts/dev.sh scripts/mobile-dev.sh scripts/setup.sh apps/desktop/src-tauri/tauri.conf.json`

Expected: FAIL with matches in all four files.

- [ ] **Step 2: Update `scripts/dev.sh` Bun commands**

Make these exact replacements:

```diff
-    (cd "$ROOT/services/relay" && bun install)
+    (cd "$ROOT/services/relay" && pnpm install)

-    "PORT=${RELAY_PORT} FIREBASE_PROJECT_ID=kanna-local FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:${AUTH_PORT} FIRESTORE_EMULATOR_HOST=127.0.0.1:${FIRESTORE_PORT} bun run dev" Enter
+    "PORT=${RELAY_PORT} FIREBASE_PROJECT_ID=kanna-local FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:${AUTH_PORT} FIRESTORE_EMULATOR_HOST=127.0.0.1:${FIRESTORE_PORT} pnpm run dev" Enter

-    "KANNA_DEV_PORT=${MOBILE_PORT} KANNA_RELAY_PORT=${RELAY_PORT} bunx tauri ios dev" Enter
+    "KANNA_DEV_PORT=${MOBILE_PORT} KANNA_RELAY_PORT=${RELAY_PORT} pnpm exec tauri ios dev" Enter

-  DEV_CMD="bun run build:sidecars && bun tauri dev"
+  DEV_CMD="pnpm run build:sidecars && pnpm exec tauri dev"

-    DEV_CMD="bun run build:sidecars && bun tauri dev --config $LOCAL_CONF"
+    DEV_CMD="pnpm run build:sidecars && pnpm exec tauri dev --config $LOCAL_CONF"
```

- [ ] **Step 3: Update `scripts/mobile-dev.sh` Bun commands**

Make these exact replacements:

```diff
-    (cd "$RELAY_DIR" && bun install)
+    (cd "$RELAY_DIR" && pnpm install)

-    "PORT=${RELAY_PORT} FIREBASE_PROJECT_ID=kanna-local FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:${AUTH_PORT} FIRESTORE_EMULATOR_HOST=127.0.0.1:${FIRESTORE_PORT} bun run dev" Enter
+    "PORT=${RELAY_PORT} FIREBASE_PROJECT_ID=kanna-local FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:${AUTH_PORT} FIRESTORE_EMULATOR_HOST=127.0.0.1:${FIRESTORE_PORT} pnpm run dev" Enter

-    "KANNA_DEV_PORT=${MOBILE_PORT} KANNA_RELAY_PORT=${RELAY_PORT} bunx tauri ios dev --host ${LAN_IP}" Enter
+    "KANNA_DEV_PORT=${MOBILE_PORT} KANNA_RELAY_PORT=${RELAY_PORT} pnpm exec tauri ios dev --host ${LAN_IP}" Enter
```

- [ ] **Step 4: Update `scripts/setup.sh` Bun prerequisite and install flow**

Replace the Bun-specific checks with Node and pnpm checks:

```bash
NODE_REQUIRED="22.0.0"
PNPM_REQUIRED="10.8.1"

if command -v node &>/dev/null; then
  node_ver="$(node --version | sed 's/^v//')"
else
  fail "Node.js — install from https://nodejs.org/"
fi

if command -v pnpm &>/dev/null; then
  pnpm_ver="$(pnpm --version)"
else
  fail "pnpm — install with: corepack enable && corepack prepare pnpm@${PNPM_REQUIRED} --activate"
fi
```

And replace dependency installation text/command with:

```bash
printf "  Installing dependencies with pnpm...\n"
pnpm install
pass "pnpm install (includes Tauri CLI via @tauri-apps/cli)"
```

- [ ] **Step 5: Update Tauri prebuild commands**

Replace the build section in `apps/desktop/src-tauri/tauri.conf.json` with:

```json
"build": {
  "beforeDevCommand": "pnpm run dev",
  "beforeBuildCommand": "pnpm run build",
  "devUrl": "http://localhost:1420",
  "frontendDist": "../dist"
}
```

- [ ] **Step 6: Re-run the command scan**

Run: `rg -n '\\bbun\\b|\\bbunx\\b' scripts/dev.sh scripts/mobile-dev.sh scripts/setup.sh apps/desktop/src-tauri/tauri.conf.json`

Expected: PASS with no matches.

- [ ] **Step 7: Commit**

```bash
git add scripts/dev.sh scripts/mobile-dev.sh scripts/setup.sh apps/desktop/src-tauri/tauri.conf.json
git commit -m "build: switch dev and tauri hooks to pnpm"
```

### Task 4: Replace Bun test configuration with Vitest configuration

**Files:**
- Delete: `apps/desktop/bunfig.toml`
- Delete: `apps/desktop/tests/e2e/bunfig.toml`
- Delete: `tests/cli-contract/bunfig.toml`
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/tests/e2e/vitest.config.ts`
- Create: `tests/cli-contract/vitest.config.ts`

- [ ] **Step 1: Write the failing config parity check**

Run: `rg --files apps/desktop tests/cli-contract | rg 'bunfig\\.toml$|vitest\\.config\\.ts$'`

Expected: FAIL because only Bun config exists.

- [ ] **Step 2: Add desktop Vitest config**

Save this file as `apps/desktop/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/composables/test-setup.ts"],
  },
});
```

- [ ] **Step 3: Add desktop E2E Vitest config**

Save this file as `apps/desktop/tests/e2e/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./preload.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 4: Add CLI contract Vitest config**

Save this file as `tests/cli-contract/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 5: Remove Bun config files**

Delete:

```text
apps/desktop/bunfig.toml
apps/desktop/tests/e2e/bunfig.toml
tests/cli-contract/bunfig.toml
```

- [ ] **Step 6: Re-run the config parity check**

Run: `rg --files apps/desktop tests/cli-contract | rg 'bunfig\\.toml$|vitest\\.config\\.ts$'`

Expected: PASS with only `vitest.config.ts` matches.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/vitest.config.ts apps/desktop/tests/e2e/vitest.config.ts tests/cli-contract/vitest.config.ts
git rm apps/desktop/bunfig.toml apps/desktop/tests/e2e/bunfig.toml tests/cli-contract/bunfig.toml
git commit -m "test: replace bunfig with vitest config"
```

### Task 5: Migrate `bun:test` imports to Vitest

**Files:**
- Modify: `services/relay/test/integration.test.ts`
- Modify: `tests/cli-contract/**/*.test.ts`
- Modify: `apps/desktop/src/**/*.test.ts`
- Modify: `apps/desktop/tests/e2e/**/*.test.ts`

- [ ] **Step 1: Write the failing import scan**

Run: `rg -n 'from "bun:test"' services/relay tests/cli-contract apps/desktop/src apps/desktop/tests/e2e`

Expected: FAIL with matches across relay, CLI contract, desktop unit tests, and E2E tests.

- [ ] **Step 2: Replace all `bun:test` imports with `vitest` imports**

Use this exact import shape:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, mock, spyOn, setDefaultTimeout } from "vitest";
```

Each file should import only the names it uses. Example replacement for `services/relay/test/integration.test.ts`:

```diff
-import { describe, it, expect, beforeAll, afterAll } from "bun:test";
+import { describe, it, expect, beforeAll, afterAll } from "vitest";
```

- [ ] **Step 3: Fix any Bun-only test helper API usage**

When a file dynamically imports Bun helpers, convert it to Node/Vitest-compatible code. Example replacement:

```diff
-const { spawn } = await import("bun");
+const { spawn } = await import("node:child_process");
```

Only keep changes required to remove Bun dependencies; do not refactor test logic.

- [ ] **Step 4: Re-run the import scan**

Run: `rg -n 'from "bun:test"|await import\\("bun"\\)' services/relay tests/cli-contract apps/desktop/src apps/desktop/tests/e2e`

Expected: PASS with no matches.

- [ ] **Step 5: Run the focused test smoke checks**

Run:

```bash
cd apps/desktop && pnpm test -- src/composables/useInlineSearch.test.ts src/composables/useNavigationHistory.test.ts
cd /Users/jeremyhale/Documents/work/jemdiggity/kanna-tauri/.kanna-worktrees/task-50defc0b/tests/cli-contract && pnpm test -- tests/flags.test.ts
```

Expected: PASS for both commands.

- [ ] **Step 6: Commit**

```bash
git add services/relay/test/integration.test.ts tests/cli-contract apps/desktop/src apps/desktop/tests/e2e
git commit -m "test: migrate bun test imports to vitest"
```

### Task 6: Replace Bun runtime APIs in CLI contract helpers

**Files:**
- Modify: `tests/cli-contract/helpers/claude.ts`
- Modify: `tests/cli-contract/helpers/copilot.ts`

- [ ] **Step 1: Write the failing Bun runtime scan**

Run: `rg -n 'from "bun"|Bun\\.' tests/cli-contract/helpers/claude.ts tests/cli-contract/helpers/copilot.ts`

Expected: FAIL with `spawn` imports and `Bun.file(...)`.

- [ ] **Step 2: Replace Bun file checks with Node filesystem checks**

Use this implementation pattern:

```ts
import { access } from "node:fs/promises";
import { constants } from "node:fs";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
```

Update binary lookup to await `pathExists(...)` rather than `Bun.file(path).size > 0`.

- [ ] **Step 3: Replace Bun spawn with `execa`**

Use this implementation pattern:

```ts
import { execa } from "execa";

const subprocess = execa(binary, args, {
  cwd: opts.cwd ?? "/tmp",
  env: { ...process.env, ...opts.env },
  reject: false,
  timeout: opts.timeoutMs ?? 30_000,
});

const { stdout, stderr, exitCode } = await subprocess;
```

Keep return types and NDJSON parsing behavior unchanged.

- [ ] **Step 4: Re-run the Bun runtime scan**

Run: `rg -n 'from "bun"|Bun\\.' tests/cli-contract/helpers/claude.ts tests/cli-contract/helpers/copilot.ts`

Expected: PASS with no matches.

- [ ] **Step 5: Run the CLI contract suite**

Run: `cd tests/cli-contract && pnpm test`

Expected: PASS, assuming the Claude/Copilot CLIs are available in `PATH`.

- [ ] **Step 6: Commit**

```bash
git add tests/cli-contract/helpers/claude.ts tests/cli-contract/helpers/copilot.ts tests/cli-contract/package.json pnpm-lock.yaml
git commit -m "test: remove bun runtime APIs from cli helpers"
```

### Task 7: Replace Bun runtime APIs in desktop E2E runner

**Files:**
- Modify: `apps/desktop/tests/e2e/run.ts`

- [ ] **Step 1: Write the failing Bun runtime scan**

Run: `rg -n 'Bun\\.' apps/desktop/tests/e2e/run.ts`

Expected: FAIL with `Bun.spawn`, `Bun.Glob`, and `Bun.sleep`.

- [ ] **Step 2: Replace `Bun.spawn` with `execa` for fire-and-wait commands**

Use this helper:

```ts
import { execa } from "execa";

async function runCommand(command: string[], options: CommandOptions): Promise<void> {
  const [file, ...args] = command;
  const result = await execa(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${result.exitCode}`);
  }
}
```

- [ ] **Step 3: Replace `Bun.Glob` and `Bun.sleep`**

Use:

```ts
import fg from "fast-glob";

const files = await fg(`${prefix}**/*.test.ts`, { cwd: e2eRoot, onlyFiles: true });
await new Promise((resolve) => setTimeout(resolve, 1000));
```

Do not change the surrounding selection and polling logic beyond the API swap.

- [ ] **Step 4: Replace direct Bun test invocation**

Change:

```diff
-await runCommand(["bun", "test", testTarget], {
+await runCommand(["pnpm", "exec", "vitest", "run", testTarget], {
```

- [ ] **Step 5: Re-run the Bun runtime scan**

Run: `rg -n 'Bun\\.|\\bbun\\b' apps/desktop/tests/e2e/run.ts`

Expected: PASS with no matches.

- [ ] **Step 6: Run the E2E runner in dry-target mode**

Run: `cd apps/desktop && pnpm exec tsx tests/e2e/run.ts mock/app-launch.test.ts`

Expected: PASS if the Tauri dev environment is available. If local environment prerequisites are missing, capture the exact failure and stop before broad E2E debugging.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/tests/e2e/run.ts apps/desktop/package.json pnpm-lock.yaml
git commit -m "test: remove bun runtime APIs from e2e runner"
```

### Task 8: Replace relay test Bun dependencies

**Files:**
- Modify: `services/relay/test/integration.test.ts`
- Modify: `services/relay/package.json`

- [ ] **Step 1: Write the failing relay Bun scan**

Run: `rg -n 'from "bun:test"|spawn\\("bun"' services/relay/test/integration.test.ts`

Expected: FAIL with the Bun test import and Bun runtime spawn command.

- [ ] **Step 2: Switch the relay test to Vitest imports**

Use:

```diff
-import { describe, it, expect, beforeAll, afterAll } from "bun:test";
+import { describe, it, expect, beforeAll, afterAll } from "vitest";
```

- [ ] **Step 3: Add the test tooling to `services/relay/package.json`**

Update it to:

```json
{
  "name": "kanna-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "firebase-admin": "^13.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.2"
  }
}
```

- [ ] **Step 4: Replace Bun-powered process launch**

Change:

```diff
-    relayProcess = spawn("bun", ["run", "src/index.ts"], {
+    relayProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
```

Keep the rest of the startup logic intact.

- [ ] **Step 5: Run the relay integration test**

Run: `cd services/relay && pnpm test -- test/integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/relay/package.json services/relay/test/integration.test.ts pnpm-lock.yaml
git commit -m "test: migrate relay integration tests off bun"
```

### Task 9: Update repo documentation and project instructions to stop mandating Bun

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/` files that document Bun commands for active developer workflows

- [ ] **Step 1: Write the failing documentation scan**

Run: `rg -n '\\bbun\\b|\\bbunx\\b|bun\\.lock|bunfig\\.toml' AGENTS.md docs scripts`

Expected: FAIL with many matches.

- [ ] **Step 2: Update the canonical project instructions**

Change the package-manager rule in `AGENTS.md` from:

```md
Use `bun` for all package management and script execution. Not pnpm, not npm.
```

to:

```md
Use `pnpm` for all package management and script execution. Do not use bun or npm for repository tasks.
```

Also update any workflow examples in `AGENTS.md` that currently tell contributors to run Bun commands.

- [ ] **Step 3: Update active developer docs**

For docs that describe current supported workflows, replace commands using these mappings:

```text
bun install -> pnpm install
bun test -> pnpm test
bun run <script> -> pnpm run <script>
bunx <tool> -> pnpm exec <tool>
bun tauri <subcommand> -> pnpm exec tauri <subcommand>
```

Do not mass-edit archived plans/specs unless the repo treats them as live instructions. Focus on docs contributors actually follow.

- [ ] **Step 4: Re-run the documentation scan**

Run: `rg -n '\\bbun\\b|\\bbunx\\b|bun\\.lock|bunfig\\.toml' AGENTS.md docs scripts`

Expected: Remaining matches, if any, should only be in historical design docs or explicitly labeled archival material.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs scripts
git commit -m "docs: update repository guidance for pnpm"
```

### Task 10: Run end-to-end verification from a clean pnpm-oriented workflow

**Files:**
- Modify: `pnpm-lock.yaml`
- Modify: any files touched in prior tasks if verification exposes regressions

- [ ] **Step 1: Run TypeScript verification**

Run:

```bash
pnpm exec tsc --noEmit
cd apps/desktop && pnpm exec vue-tsc --noEmit
```

Expected: PASS for both commands.

- [ ] **Step 2: Run package test verification**

Run:

```bash
pnpm test
cd services/relay && pnpm test
cd tests/cli-contract && pnpm test
```

Expected: PASS, subject to external CLI prerequisites for the contract suite.

- [ ] **Step 3: Run desktop dev-flow verification**

Run:

```bash
./scripts/dev.sh start
./scripts/dev.sh log
./scripts/dev.sh stop --kill-daemon
```

Expected: PASS. The log should show the desktop app launching through pnpm-backed commands instead of Bun.

- [ ] **Step 4: Run desktop build verification**

Run: `cd apps/desktop && pnpm exec tauri build`

Expected: PASS. If code signing or host-specific packaging prerequisites fail, capture the exact failure and verify that the Node/pnpm layer itself is functioning correctly.

- [ ] **Step 5: Remove obsolete Bun files**

Run:

```bash
git rm bun.lock
git rm services/relay/bun.lock
```

Expected: PASS if both files still exist. If they were already removed earlier, skip this step and ensure they are absent from the final diff.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build: complete pnpm migration"
```
