# Local Verification and Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GitHub-hosted test workflows with a canonical sequential `./kd test ci` command, repair the Remote E2E desktop-pairing boundary, and make the macOS SIGKILL escalation test deterministic.

**Architecture:** A small KD runtime orchestrator owns the ordered local verification phases and is exposed through CLI and MCP task registries. Remote E2E gets a focused loopback desktop-pairing client rather than tunneling the desktop-only request through the phone relay. The macOS process test obtains a kernel-assigned port from an explicit child readiness handshake.

**Tech Stack:** TypeScript, Vitest, KD task registry, Rust/Tokio, GitHub workflow YAML, Markdown

---

### Task 1: Add the canonical local CI orchestrator

**Files:**
- Create: `tools/kd/src/runtime/local-ci.ts`
- Create: `tools/kd/tests/local-ci.test.ts`
- Modify: `tools/kd/src/tasks/registry.ts`
- Modify: `tools/kd/src/cli.ts`
- Modify: `tools/kd/tests/cli.test.ts`
- Modify: `tools/kd/src/mcp/tool-registry.ts`
- Modify: `tools/kd/tests/mcp-tools.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Create `tools/kd/tests/local-ci.test.ts` with tests that require the three phases to run sequentially and stop after the first failure:

```ts
import { describe, expect, it } from "vitest";
import { executeLocalCi } from "../src/runtime/local-ci";
import type { CommandRunner } from "../src/runtime/process";

describe("local CI", () => {
  it("runs bounded, canonical verification phases sequentially", async () => {
    const calls: Array<{ command: string; args: string[]; streamOutput?: boolean }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, streamOutput: options?.streamOutput });
        return { exitCode: 0, stdout: `${command} passed`, stderr: "" };
      },
    };

    const result = await executeLocalCi({
      repoRoot: "/repo",
      env: { PATH: "/usr/bin" },
      runner,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { command: "pnpm", args: ["test"], streamOutput: true },
      { command: "./kd", args: ["test", "rust"], streamOutput: true },
      { command: "./kd", args: ["test", "remote-e2e"], streamOutput: true },
    ]);
  });

  it("stops after the first failed phase", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push([command, ...args].join(" "));
        return calls.length === 2
          ? { exitCode: 9, stdout: "", stderr: "rust failed" }
          : { exitCode: 0, stdout: "passed", stderr: "" };
      },
    };

    const result = await executeLocalCi({
      repoRoot: "/repo",
      env: {},
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Rust");
    expect(calls).toEqual(["pnpm test", "./kd test rust"]);
  });
});
```

Add this assertion to the existing cloud-test parsing test in `tools/kd/tests/cli.test.ts`:

```ts
expect(parseCliArgs(["test", "ci"])).toEqual({
  taskId: "test.ci",
  input: {},
});
expect(getTaskDefinition("test.ci").description).toBe(
  "Run canonical local verification sequentially.",
);
```

Add `"test_ci"` before `"test_app_update_bundle"` in the expected MCP tool list in `tools/kd/tests/mcp-tools.test.ts`.

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
pnpm --dir tools/kd exec vitest run --maxWorkers=2 tests/local-ci.test.ts tests/cli.test.ts tests/mcp-tools.test.ts
```

Expected: FAIL because `runtime/local-ci.ts`, the `test.ci` task, CLI route, and MCP tool do not exist.

- [ ] **Step 3: Implement the local CI runtime**

Create `tools/kd/src/runtime/local-ci.ts`:

```ts
import type { CommandRunner } from "./process";

export interface LocalCiInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

interface LocalCiStep {
  name: string;
  command: string;
  args: string[];
}

const LOCAL_CI_STEPS: LocalCiStep[] = [
  { name: "JavaScript and TypeScript", command: "pnpm", args: ["test"] },
  { name: "Rust", command: "./kd", args: ["test", "rust"] },
  { name: "Remote E2E", command: "./kd", args: ["test", "remote-e2e"] },
];

export async function executeLocalCi(input: LocalCiInput) {
  const results: Array<LocalCiStep & { exitCode: number }> = [];
  for (const step of LOCAL_CI_STEPS) {
    const result = await input.runner.run(step.command, step.args, {
      cwd: input.repoRoot,
      env: input.env,
      streamOutput: true,
    });
    results.push({ ...step, exitCode: result.exitCode });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: `Local CI failed during ${step.name}.`,
        data: { steps: results },
      };
    }
  }
  return {
    ok: true,
    message: "Local CI passed.",
    data: { steps: results },
  };
}
```

Import `executeLocalCi` in `tools/kd/src/tasks/registry.ts` and add this task immediately before `test.rust`:

```ts
{
  id: "test.ci",
  description: "Run canonical local verification sequentially.",
  inputSchema: emptyInputSchema,
  execute: async () => {
    const context = await resolveDefaultContext(process.env);
    return executeLocalCi({
      repoRoot: context.repoRoot,
      env: context.env,
      runner: nodeCommandRunner,
    });
  },
},
```

In `tools/kd/src/cli.ts`, route `kd test ci` to `{ taskId: "test.ci", input: {} }`, add `test ci` to the top-level command list, and add this help topic:

```ts
"test ci": [
  "Usage: kd test ci",
  "",
  "Run canonical local verification sequentially: pnpm, Rust, then Remote E2E.",
],
```

Add `["test_ci", "test.ci"]` to `tools/kd/src/mcp/tool-registry.ts`.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```bash
pnpm --dir tools/kd exec vitest run --maxWorkers=2 tests/local-ci.test.ts tests/cli.test.ts tests/mcp-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/kd/src/runtime/local-ci.ts tools/kd/tests/local-ci.test.ts tools/kd/src/tasks/registry.ts tools/kd/src/cli.ts tools/kd/tests/cli.test.ts tools/kd/src/mcp/tool-registry.ts tools/kd/tests/mcp-tools.test.ts
git commit -m "feat(kd): add canonical local CI command"
```

### Task 2: Repair the Remote E2E desktop pairing boundary

**Files:**
- Create: `tests/remote-e2e/src/desktopPairing.ts`
- Create: `tests/remote-e2e/src/desktopPairing.test.ts`
- Modify: `tests/remote-e2e/src/harness.ts`
- Modify: `tests/remote-e2e/src/cloud-pairing-auth-discovery.e2e.test.ts`
- Modify: `tests/remote-e2e/package.json`
- Modify: `tools/kd/tests/test-orchestration.test.ts`

- [ ] **Step 1: Write a failing direct-loopback pairing test**

Create `tests/remote-e2e/src/desktopPairing.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createDesktopPairingSession } from "./desktopPairing";

describe("desktop pairing client", () => {
  it("creates pairing through the desktop loopback boundary", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "ABC123",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      pairingPayload: "{}",
      lanHost: "127.0.0.1",
      lanPort: 48120,
      expiresAtUnixMs: 1_800_000,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(createDesktopPairingSession(
      "http://127.0.0.1:48120",
      fetchImpl as typeof fetch,
    )).resolves.toMatchObject({
      code: "ABC123",
      desktopId: "desktop-1",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/pairing/sessions",
      { method: "POST" },
    );
  });

  it("reports the status and body when desktop pairing fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));

    await expect(createDesktopPairingSession(
      "http://127.0.0.1:48120",
      fetchImpl as typeof fetch,
    )).rejects.toThrow("403 forbidden");
  });
});
```

Add `src/desktopPairing.test.ts` to the bounded `test` script in `tests/remote-e2e/package.json`.
Update the exact remote package script assertion in `tools/kd/tests/test-orchestration.test.ts` to include the new test file.

- [ ] **Step 2: Run the unit test to verify RED**

Run:

```bash
pnpm --dir tests/remote-e2e exec vitest run --maxWorkers=2 src/desktopPairing.test.ts
```

Expected: FAIL because `desktopPairing.ts` does not exist.

- [ ] **Step 3: Implement the loopback client and harness operation**

Create `tests/remote-e2e/src/desktopPairing.ts`:

```ts
export interface DesktopPairingSession {
  code: string;
  desktopId: string;
  desktopName: string;
  pairingPayload: string;
  lanHost: string;
  lanPort: number;
  expiresAtUnixMs: number;
}

export async function createDesktopPairingSession(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopPairingSession> {
  const response = await fetchImpl(`${baseUrl}/v1/pairing/sessions`, {
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`desktop pairing failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
  const pairing = JSON.parse(body) as Partial<DesktopPairingSession>;
  if (!pairing.code || !pairing.desktopId || !pairing.desktopName) {
    throw new Error("desktop pairing returned an incomplete response");
  }
  return pairing as DesktopPairingSession;
}
```

Import the helper into `tests/remote-e2e/src/harness.ts`, add this member to `RemoteHarness`:

```ts
createDesktopPairingSession(): Promise<DesktopPairingSession>;
```

and return an implementation that calls the helper with `http://127.0.0.1:${ports.server}`.

Replace the tunneled `harness.client.invokeDesktop` call at the start of `cloud-pairing-auth-discovery.e2e.test.ts` with:

```ts
const localPairing = asPairingSession(
  await harness.createDesktopPairingSession(),
);
```

- [ ] **Step 4: Run unit and server authorization tests**

Run:

```bash
pnpm --dir tests/remote-e2e exec vitest run --maxWorkers=2 src/desktopPairing.test.ts
cargo test -p kanna-server create_pairing_session_route_rejects -- --nocapture
```

Expected: PASS, including the existing relay-tunnel HTTP 403 invariant.

- [ ] **Step 5: Run the focused Remote E2E spec**

Run:

```bash
pnpm --dir tests/remote-e2e exec vitest run --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --hookTimeout=240000 --testTimeout=120000 src/cloud-pairing-auth-discovery.e2e.test.ts
```

Expected: PASS with the bootstrap pairing created locally and the remaining status/auth/discovery assertions still using the relay.

- [ ] **Step 6: Commit**

```bash
git add tests/remote-e2e/src/desktopPairing.ts tests/remote-e2e/src/desktopPairing.test.ts tests/remote-e2e/src/harness.ts tests/remote-e2e/src/cloud-pairing-auth-discovery.e2e.test.ts tests/remote-e2e/package.json tools/kd/tests/test-orchestration.test.ts
git commit -m "fix(remote-e2e): create pairing at desktop boundary"
```

### Task 3: Make the macOS SIGKILL escalation test deterministic

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mobile/process.rs`

- [ ] **Step 1: Change the test to require a child-owned port**

Change the start of `stop_server_on_port_escalates_to_sigkill_when_sigterm_is_ignored` to:

```rust
let (mut child, port) = start_sigterm_ignoring_listener().await;
let child_pid = child.id().expect("listener should have pid");
```

Remove the import of `free_loopback_port`.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
./kd build sidecars
cargo test -p kanna-desktop stop_server_on_port_escalates_to_sigkill_when_sigterm_is_ignored -- --nocapture
```

Expected: FAIL to compile because the helper still requires a port and returns only `Child`.

- [ ] **Step 3: Implement the readiness handshake**

Import `tokio::io::{AsyncBufReadExt, BufReader}`. Change the helper to return `(Child, u16)`, configure `kill_on_drop(true)`, pipe stdout, and have Python bind port zero:

```rust
async fn start_sigterm_ignoring_listener() -> (Child, u16) {
    let script = r#"
import signal
import socket
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", 0))
sock.listen(1)
print(sock.getsockname()[1], flush=True)
while True:
    time.sleep(1)
"#;
    let mut command = Command::new("python3");
    command
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .expect("python3 should start SIGTERM-ignoring listener");
    let stdout = child.stdout.take().expect("listener stdout should be piped");
    let mut lines = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await;
    let port = match ready {
        Ok(Ok(Some(line))) => line
            .trim()
            .parse::<u16>()
            .expect("listener should report a valid port"),
        Ok(Ok(None)) => panic!("listener closed stdout before reporting its port"),
        Ok(Err(error)) => panic!("failed to read listener port: {error}"),
        Err(_) => panic!("timed out waiting for listener port"),
    };
    (child, port)
}
```

- [ ] **Step 4: Run the focused test repeatedly**

Run:

```bash
for iteration in 1 2 3; do
  cargo test -p kanna-desktop stop_server_on_port_escalates_to_sigkill_when_sigterm_is_ignored -- --nocapture || exit 1
done
```

Expected: all three runs PASS and no listener process remains.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/mobile/process.rs
git commit -m "test(desktop): make server kill escalation deterministic"
```

### Task 4: Remove GitHub verification and document the local gate

**Files:**
- Delete: `.github/workflows/ci.yml`
- Delete: `.github/workflows/remote-e2e.yml`
- Move: `tools/kd/tests/ci-workflow.test.ts` → `tools/kd/tests/github-workflows.test.ts`
- Delete: `tools/kd/tests/remote-e2e-workflow.test.ts`
- Modify: `AGENTS.md`
- Modify: `docs/dev/testing.md`
- Modify: `docs/dev/dev-workflow.md`
- Modify: `docs/dev/getting-started.md`
- Modify: `docs/specs/remote-task-e2e.md`

- [ ] **Step 1: Replace workflow-content tests with the desired inventory**

Replace `tools/kd/tests/ci-workflow.test.ts` with `tools/kd/tests/github-workflows.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

describe("GitHub workflow inventory", () => {
  it("keeps publishing automation but no hosted verification", () => {
    expect(
      readdirSync(workflowsDir)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort(),
    ).toEqual(["config-schema-pages.yml"]);

    const pages = readFileSync(
      resolve(workflowsDir, "config-schema-pages.yml"),
      "utf8",
    );
    expect(pages).toContain("name: Config Schema Pages");
    expect(pages).toContain("actions/deploy-pages@v4");
  });
});
```

- [ ] **Step 2: Run the inventory test to verify RED**

Run:

```bash
pnpm --dir tools/kd exec vitest run --maxWorkers=2 tests/github-workflows.test.ts
```

Expected: FAIL because `ci.yml` and `remote-e2e.yml` still exist.

- [ ] **Step 3: Delete hosted verification workflows**

Delete `.github/workflows/ci.yml`, `.github/workflows/remote-e2e.yml`, and `tools/kd/tests/remote-e2e-workflow.test.ts`. Keep `.github/workflows/config-schema-pages.yml` unchanged.

- [ ] **Step 4: Update canonical verification documentation**

Make these source-of-truth changes:

- `AGENTS.md`: replace the two-command canonical block with `./kd test ci`; keep individual commands documented as focused suites.
- `docs/dev/testing.md`: define `./kd test ci` as the required local gate and explain its three sequential phases.
- `docs/dev/dev-workflow.md` and `docs/dev/getting-started.md`: show `./kd test ci` as the completion check.
- `docs/specs/remote-task-e2e.md`: replace references to `.github/workflows/remote-e2e.yml`, pull-request CI, and scheduled staging CI with local `./kd test ci` / explicit human staging execution.

- [ ] **Step 5: Run focused KD and documentation tests**

Run:

```bash
pnpm --dir tools/kd exec vitest run --maxWorkers=2 tests/github-workflows.test.ts tests/local-ci.test.ts tests/cli.test.ts tests/mcp-tools.test.ts tests/developer-docs.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows tools/kd/tests AGENTS.md docs/dev/testing.md docs/dev/dev-workflow.md docs/dev/getting-started.md docs/specs/remote-task-e2e.md
git commit -m "chore: replace GitHub CI with local verification"
```

### Task 5: Run canonical verification and review

**Files:**
- Verify all modified files

- [ ] **Step 1: Run formatting and static checks for changed code**

Run:

```bash
pnpm --dir tools/kd exec tsc --noEmit
pnpm --dir tests/remote-e2e exec tsc --noEmit
cargo fmt --all -- --check
git diff --check origin/main...HEAD
```

Expected: PASS.

- [ ] **Step 2: Run the new local verification gate**

Run:

```bash
./kd test ci
```

Expected: all three phases PASS sequentially: `pnpm test`, `./kd test rust`, and `./kd test remote-e2e`.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only the approved design/plan and implementation files differ; no generated or temporary artifacts are tracked.

- [ ] **Step 4: Commit any verification-only corrections**

If formatting or documentation corrections were required, stage only those files and commit:

```bash
git commit -m "chore: finalize local verification migration"
```
