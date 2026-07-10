# Resource-Bounded Test Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local and CI JavaScript/Rust verification deterministic under bounded host resources without increasing timeouts.

**Architecture:** `pnpm test` remains the offline JavaScript unit/static-contract entry point, with Turbo limited to two package tasks and every ordinary Vitest process limited to two workers. Live agent CLI compatibility uses a guarded, serialized `test:agent-cli-compat` lane; process-heavy remote E2E and TUI fidelity use separate explicit scripts. `./kd test rust` prepares the frontend and sidecar inputs required by Tauri, runs non-daemon workspace tests normally, then runs the daemon crate with one libtest thread.

**Tech Stack:** pnpm 11, Turbo 2, Vitest 3/4, TypeScript, kd task registry, Cargo/libtest, GitHub Actions.

---

### Task 1: Bound JavaScript Unit Tests and Separate Heavy Suites

**Files:**
- Create: `tools/kd/tests/test-orchestration.test.ts`
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `apps/mobile/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/db/package.json`
- Modify: `packages/stream-client/package.json`
- Modify: `services/firebase-functions/package.json`
- Modify: `services/relay/package.json`
- Modify: `tests/cli-contract/package.json`
- Modify: `tests/cli-contract/vitest.config.ts`
- Create: `tests/cli-contract/vitest.live.config.ts`
- Create: `tests/cli-contract/helpers/live-contract-guard.ts`
- Move: two static CLI contracts to `tests/cli-contract/tests/offline/`
- Move: twelve external-provider contracts to `tests/cli-contract/tests/live/`
- Modify: `tests/remote-e2e/package.json`
- Modify: `tests/tui-fidelity/package.json`
- Modify: `tools/kd/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the failing orchestration contract**

Create `tools/kd/tests/test-orchestration.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as PackageManifest;
}

const vitestUnitPackages = [
  "apps/desktop/package.json",
  "apps/mobile/package.json",
  "packages/core/package.json",
  "packages/db/package.json",
  "packages/stream-client/package.json",
  "services/firebase-functions/package.json",
  "services/relay/package.json",
  "tests/cli-contract/package.json",
  "tools/kd/package.json",
];

describe("test orchestration", () => {
  it("keeps root unit tests bounded and heavy suites explicit", () => {
    const root = manifest("package.json");
    const remote = manifest("tests/remote-e2e/package.json");
    const fidelity = manifest("tests/tui-fidelity/package.json");

    expect(root.scripts?.test).toBe("turbo test --concurrency=2");
    expect(root.scripts?.["test:remote-e2e"]).toBe("./kd test remote-e2e");
    expect(root.scripts?.["test:tui-fidelity"])
      .toBe("pnpm --filter @kanna/tui-fidelity test:tui-fidelity");
    expect(remote.scripts).not.toHaveProperty("test");
    expect(remote.scripts?.["test:remote-e2e"]).toBe("tsx src/run.ts --dev");
    expect(fidelity.scripts).not.toHaveProperty("test");
    expect(fidelity.scripts?.["test:tui-fidelity"]).toBe("tsx src/run.ts");
  });

  it.each(vitestUnitPackages)("%s limits ordinary Vitest fan-out", (path) => {
    expect(manifest(path).scripts?.test).toContain("--maxWorkers=2");
  });

  it("uses the lockfile-managed Vitest binary for mobile", () => {
    const mobile = manifest("apps/mobile/package.json");
    expect(mobile.scripts?.test).toContain("pnpm exec vitest");
    expect(mobile.scripts?.test).not.toContain("pnpm dlx");
    expect(mobile.devDependencies?.vitest).toBe("^4.1.4");
  });
});
```

- [ ] **Step 2: Verify the contract is red**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/test-orchestration.test.ts --maxWorkers=2
```

Expected: failures for unbounded Turbo, generic heavy-suite scripts, missing worker caps, and `pnpm dlx` on mobile.

- [ ] **Step 3: Split root and heavy-suite scripts**

Set root scripts to:

```json
{
  "test": "turbo test --concurrency=2",
  "test:agent-cli-compat": "pnpm --filter @kanna/cli-contract test:agent-cli-compat",
  "test:remote-e2e": "./kd test remote-e2e",
  "test:tui-fidelity": "pnpm --filter @kanna/tui-fidelity test:tui-fidelity"
}
```

Rename heavy package scripts:

```json
// tests/remote-e2e/package.json
{
  "test:remote-e2e": "tsx src/run.ts --dev",
  "smoke": "vitest run --maxWorkers=2 src/remote-harness.smoke.test.ts"
}
```

```json
// tests/tui-fidelity/package.json
{
  "test:tui-fidelity": "tsx src/run.ts",
  "typecheck": "tsc --noEmit"
}
```

Neither heavy package retains a generic `test` script, so Turbo excludes it from `pnpm test`. The CLI-contract package keeps a generic `test`, but its default Vitest config includes only `tests/offline/**/*.test.ts`; real-provider tests are isolated under `tests/live/`.

- [ ] **Step 4: Bound ordinary Vitest scripts**

Use these exact forms while retaining each package's current arguments:

```json
// apps/desktop
"test": "sh -c 'if [ \"$1\" = \"--\" ]; then shift; fi; exec vitest run --maxWorkers=2 src \"$@\"' --"

// apps/mobile
"test": "sh -c 'if [ \"$1\" = \"--\" ]; then shift; fi; if [ \"$1\" = \"--runInBand\" ]; then shift; fi; exec pnpm exec vitest run --maxWorkers=2 \"$@\"' --"

// core, db, stream-client, relay, tools/kd
"test": "vitest run --maxWorkers=2"

// firebase-functions
"test": "pnpm exec vitest run --maxWorkers=2 --exclude 'dist/**'"

// cli-contract
"test": "sh -c 'if [ \"$1\" = \"--\" ]; then shift; fi; exec vitest run --maxWorkers=2 \"$@\"' --",
"test:agent-cli-compat": "KANNA_RUN_LIVE_AGENT_CLI_CONTRACTS=1 vitest run --config vitest.live.config.ts"
```

The live config preserves the existing 120-second test and 30-second hook timeouts, sets `fileParallelism: false` and `maxWorkers: 1`, and includes only `tests/live/**/*.test.ts`. All provider helpers call the shared opt-in guard before binary discovery. Do not change remote E2E's existing one-worker isolation or any timeout.

- [ ] **Step 5: Pin mobile Vitest and refresh the lockfile**

Add to `apps/mobile/package.json`:

```json
"devDependencies": {
  "vitest": "^4.1.4"
}
```

Run:

```bash
pnpm install --lockfile-only
```

Expected: the mobile importer records Vitest 4.1.4.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/test-orchestration.test.ts --maxWorkers=2
pnpm install --frozen-lockfile
```

Expected: the contract passes and the frozen install makes no lockfile changes.

```bash
git add package.json pnpm-lock.yaml \
  apps/desktop/package.json apps/mobile/package.json \
  packages/core/package.json packages/db/package.json packages/stream-client/package.json \
  services/firebase-functions/package.json services/relay/package.json \
  tests/cli-contract/package.json tests/remote-e2e/package.json tests/tui-fidelity/package.json \
  tools/kd/package.json tools/kd/tests/test-orchestration.test.ts
git commit -m "test: bound JavaScript test orchestration"
```

### Task 2: Add the Canonical Split Rust Workflow

**Files:**
- Create: `tools/kd/src/runtime/rust-test.ts`
- Create: `tools/kd/tests/rust-test.test.ts`
- Modify: `tools/kd/src/cli.ts`
- Modify: `tools/kd/src/tasks/registry.ts`
- Modify: `tools/kd/tests/cli.test.ts`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add failing command-plan and fail-fast tests**

Create `tools/kd/tests/rust-test.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRustTestCommands, executeRustTests } from "../src/runtime/rust-test";
import type { CommandRunner } from "../src/runtime/process";

describe("Rust test orchestration", () => {
  it("prepares Tauri inputs before workspace and serialized daemon tests", () => {
    expect(buildRustTestCommands()).toEqual([
      { name: "frontend", command: "pnpm", args: ["--dir", "apps/desktop", "build"] },
      { name: "sidecars", command: "./kd", args: ["build", "sidecars"] },
      { name: "workspace", command: "cargo", args: ["test", "--workspace", "--exclude", "kanna-daemon"] },
      { name: "daemon", command: "cargo", args: ["test", "-p", "kanna-daemon", "--", "--test-threads=1"] },
    ]);
  });

  it("stops after the first failed prerequisite", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push(`${command} ${args.join(" ")}`);
        expect(options?.streamOutput).toBe(true);
        return { exitCode: 1, stdout: "", stderr: "frontend failed" };
      },
    };

    const result = await executeRustTests({ repoRoot: "/repo", env: {}, runner });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("frontend failed");
    expect(calls).toEqual(["pnpm --dir apps/desktop build"]);
  });
});
```

The assertion proves fail-fast behavior. The command-plan assertion proves all four commands and their order without running subprocesses.

Extend `tools/kd/tests/cli.test.ts`:

```ts
expect(parseCliArgs(["test", "rust"])).toEqual({ taskId: "test.rust", input: {} });
```

- [ ] **Step 2: Verify the tests are red**

```bash
pnpm --dir tools/kd exec vitest run tests/rust-test.test.ts tests/cli.test.ts --maxWorkers=2
```

Expected: the runtime module is missing and `test rust` is unknown.

- [ ] **Step 3: Implement the command plan and executor**

Create `tools/kd/src/runtime/rust-test.ts`:

```ts
import type { CommandRunner, CommandResult } from "./process";

export interface RustTestCommand {
  name: "frontend" | "sidecars" | "workspace" | "daemon";
  command: "pnpm" | "./kd" | "cargo";
  args: string[];
}

interface ExecutedRustTestCommand extends RustTestCommand, CommandResult {}

export function buildRustTestCommands(): RustTestCommand[] {
  return [
    { name: "frontend", command: "pnpm", args: ["--dir", "apps/desktop", "build"] },
    { name: "sidecars", command: "./kd", args: ["build", "sidecars"] },
    { name: "workspace", command: "cargo", args: ["test", "--workspace", "--exclude", "kanna-daemon"] },
    { name: "daemon", command: "cargo", args: ["test", "-p", "kanna-daemon", "--", "--test-threads=1"] },
  ];
}

export async function executeRustTests(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}) {
  const commands: ExecutedRustTestCommand[] = [];
  for (const command of buildRustTestCommands()) {
    const result = await input.runner.run(command.command, command.args, {
      cwd: input.repoRoot,
      env: input.env,
      streamOutput: true,
    });
    commands.push({ ...command, ...result });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: result.stderr || result.stdout || `${command.name} Rust tests failed.`,
        data: { commands },
      };
    }
  }
  return { ok: true, message: "Canonical Rust tests passed.", data: { commands } };
}
```

The frontend build and sidecar staging are required inputs for the `kanna-desktop` Cargo build script on a clean checkout; keeping them in the canonical executor prevents the missing-`externalBin` failure seen in the review.

- [ ] **Step 4: Wire `kd test rust`**

Add this parse branch in `tools/kd/src/cli.ts` alongside the other `test` commands:

```ts
if (group === "test" && command === "rust") {
  return { taskId: "test.rust", input: {} };
}
```

Register `test.rust` in `tools/kd/src/tasks/registry.ts` using the existing empty-input and default-context patterns:

```ts
{
  id: "test.rust",
  description: "Run workspace Rust tests with daemon integration tests serialized.",
  inputSchema: emptyInputSchema,
  execute: async () => {
    const context = await resolveDefaultContext(process.env);
    return executeRustTests({
      repoRoot: context.repoRoot,
      env: context.env,
      runner: nodeCommandRunner,
    });
  },
},
```

Add `test rust` to the top-level and `kd test --help` output. Document in `AGENTS.md`:

```bash
# Canonical automated verification
pnpm test
./kd test rust

# Explicit live/process-heavy suites
pnpm test:agent-cli-compat
pnpm test:remote-e2e
pnpm test:tui-fidelity
```

- [ ] **Step 5: Verify and commit**

```bash
pnpm --dir tools/kd exec vitest run tests/rust-test.test.ts tests/cli.test.ts --maxWorkers=2
pnpm --dir tools/kd exec tsc --noEmit
```

Expected: focused tests and typecheck pass.

```bash
git add AGENTS.md tools/kd/src/runtime/rust-test.ts tools/kd/src/cli.ts \
  tools/kd/src/tasks/registry.ts tools/kd/tests/rust-test.test.ts tools/kd/tests/cli.test.ts
git commit -m "test: add canonical split Rust workflow"
```

### Task 3: Run Canonical Commands in CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `tools/kd/tests/ci-workflow.test.ts`

- [ ] **Step 1: Add a failing workflow contract**

Create `tools/kd/tests/ci-workflow.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");

describe("canonical CI workflow", () => {
  it("runs the same bounded JavaScript and Rust commands used locally", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("run: pnpm test");
    expect(workflow).toContain("run: ./kd test rust");
    expect(workflow).not.toContain("pnpm test:agent-cli-compat");
    expect(workflow).not.toContain("pnpm test:remote-e2e");
    expect(workflow).not.toContain("pnpm test:tui-fidelity");
    expect(workflow.match(/pnpm install --frozen-lockfile/g)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Verify the contract is red**

```bash
pnpm --dir tools/kd exec vitest run tests/ci-workflow.test.ts --maxWorkers=2
```

Expected: ENOENT for `.github/workflows/ci.yml`.

- [ ] **Step 3: Add the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  javascript:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11.0.8
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  rust:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11.0.8
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - uses: dtolnay/rust-toolchain@master
        with:
          toolchain: 1.93.1
      - name: Install native test dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            libc++-dev libc++abi-dev zsh \
            libwebkit2gtk-4.1-dev libappindicator3-dev \
            librsvg2-dev patchelf
      - name: Install Zig
        env:
          ZIG_VERSION: 0.15.2
          ZIG_SHA256: 02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239
        run: |
          curl -fsSLo zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz"
          echo "${ZIG_SHA256}  zig.tar.xz" | sha256sum -c -
          tar -xf zig.tar.xz
          echo "$PWD/zig-x86_64-linux-${ZIG_VERSION}" >> "$GITHUB_PATH"
      - run: pnpm install --frozen-lockfile
      - run: ./kd test rust
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm --dir tools/kd exec vitest run tests/ci-workflow.test.ts --maxWorkers=2
```

Expected: PASS.

```bash
git add .github/workflows/ci.yml tools/kd/tests/ci-workflow.test.ts
git commit -m "ci: run canonical bounded test workflows"
```

### Task 4: Prove the Complete Orchestration

- [ ] **Step 1: Run orchestration contracts**

```bash
pnpm --dir tools/kd exec vitest run \
  tests/test-orchestration.test.ts \
  tests/rust-test.test.ts \
  tests/ci-workflow.test.ts \
  tests/cli.test.ts \
  --maxWorkers=2
```

Expected: all selected tests pass.

- [ ] **Step 2: Run canonical JavaScript tests**

```bash
pnpm test
```

Expected: Turbo runs only offline unit/static-contract tests; the CLI-contract task lists exactly the two offline files; desktop passes without starvation timeouts; live agent compatibility, remote E2E, and TUI fidelity do not run.

- [ ] **Step 3: Run canonical Rust tests**

```bash
./kd test rust
```

Expected: non-daemon workspace tests pass, followed by serialized daemon tests including `interrupt_is_surfaced_as_interrupted_not_crashed`.

- [ ] **Step 4: Check explicit suite entry points and scope**

```bash
pnpm --filter @kanna/remote-e2e typecheck
pnpm --filter @kanna/tui-fidelity typecheck
pnpm --dir tests/cli-contract exec vitest list --filesOnly --staticParse
pnpm --dir tests/cli-contract exec vitest list --config vitest.live.config.ts --filesOnly --staticParse
git diff --check
```

Expected: both heavy-suite packages typecheck; default CLI discovery lists exactly two offline files; live discovery lists exactly twelve files without executing them; and the diff has no whitespace errors. Do not run live agent contracts or increase test/socket timeouts.
