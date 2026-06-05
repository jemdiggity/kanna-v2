# Cloud Testing Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable emulator, staging cloud, physical LAN lab, and production smoke test workflows for Kanna remote sync.

**Architecture:** Build this in layers. First expose transport diagnostics from the desktop workspace model so tests can prove whether a task came from cloud or LAN. Then add explicit `kd test` commands for emulator/staging/prod smoke. Finally add a controller-side physical LAN lab runner that uses SSH to coordinate isolated Kanna instances on real Macs.

**Tech Stack:** Vue 3/Pinia desktop app, Tauri v2 commands, TypeScript E2E harness, Firebase Auth/Firestore/Functions, Cloud Run relay, `kd` CLI, SSH/tmux, Vitest.

---

## File Structure

- Modify `apps/desktop/src/workspace/types.ts`
  - Add `RemoteTaskDiagnostics`.
- Modify `apps/desktop/src/workspace/buildWorkspace.ts`
  - Emit diagnostics for every workspace task.
- Modify `apps/desktop/src/workspace/buildWorkspace.test.ts`
  - Unit-test cloud, LAN, and mixed diagnostics.
- Modify `apps/desktop/src/App.vue`
  - Expose diagnostics to E2E through setup state.
- Modify `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`
  - Assert cloud transport explicitly.
- Modify `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`
  - Assert LAN transport explicitly.
- Modify `apps/desktop/src/services/desktopFirebaseConfig.ts`
  - Read runtime cloud endpoint overrides through `readEnv`.
- Modify `apps/desktop/src/services/desktopFirebaseConfig.test.ts`
  - Cover staging/production/local config resolution.
- Modify `tools/kd/src/cli.ts`
  - Add `test cloud-emulator`, `test cloud-staging`, `test cloud-prod-smoke`, and `test lan-lab`.
- Modify `tools/kd/src/tasks/registry.ts`
  - Register the new test commands.
- Create `tools/kd/src/runtime/cloud-test.ts`
  - Build command invocations for emulator/staging/prod smoke tests.
- Create `tools/kd/src/runtime/lan-lab.ts`
  - Parse host inventory and coordinate SSH workers.
- Create `tools/kd/src/runtime/lan-lab-runner.ts`
  - Build the controller-side physical LAN scenario command.
- Create `tools/kd/tests/cloud-test.test.ts`
  - Unit-test command construction and env requirements.
- Modify `tools/kd/tests/cli.test.ts`
  - Cover new cloud and LAN lab command parsing.
- Create `tools/kd/tests/lan-lab.test.ts`
  - Unit-test inventory parsing and SSH command planning.
- Create `tools/kd/tests/lan-lab-runner.test.ts`
  - Unit-test physical LAN scenario command construction.
- Create `apps/desktop/tests/e2e/real/cloud-prod-smoke.test.ts`
  - Minimal production/staging cloud publish/read smoke.
- Create `apps/desktop/tests/e2e/helpers/lan-lab-scenario.ts`
  - Pair two physical Macs through WebDriver tunnels, create a task, and assert LAN diagnostics.
- Create `.kanna/lab/macs.example.json`
  - Document physical Mac host inventory without committing private hostnames.
- Modify `docs/superpowers/specs/2026-05-31-cloud-testing-strategy-design.md`
  - Link the implementation commands after they exist.

---

### Task 1: Workspace Remote Diagnostics

**Files:**
- Modify: `apps/desktop/src/workspace/types.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.ts`
- Test: `apps/desktop/src/workspace/buildWorkspace.test.ts`
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Add diagnostics type**

Add this type to `apps/desktop/src/workspace/types.ts`:

```ts
export interface RemoteTaskDiagnostics {
  itemId: string;
  prompt: string;
  repoId: string;
  sources: Array<"local" | "cloud" | "lan">;
  selectedTerminalTransport: "local" | "cloud" | "lan" | "none";
  ownerDesktopId?: string;
  ownerLocalTaskId?: string;
  cloudUpdatedAt?: string;
  lanUpdatedAt?: string;
}
```

Extend `BuildWorkspaceResult`:

```ts
export interface BuildWorkspaceResult {
  repos: WorkspaceRepo[];
  tasks: WorkspaceTask[];
  diagnostics: RemoteTaskDiagnostics[];
}
```

- [ ] **Step 2: Write failing diagnostics tests**

Append these tests to `apps/desktop/src/workspace/buildWorkspace.test.ts`:

```ts
it("reports cloud transport diagnostics for cloud-only tasks", () => {
  const cloudItem = item({
    id: "cloud:remote-repo:task-cloud",
    repo_id: "cloud:remote-repo",
    prompt: "Cloud diagnostic task",
  });

  const result = buildWorkspace({
    localRepos: [],
    localItems: [],
    cloudSnapshot: {
      repos: [{
        id: "cloud:remote-repo",
        path: "cloud",
        name: "kanna",
        remote_url: "git@example.com:kanna.git",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-06-01T00:00:00.000Z",
        last_opened_at: "2026-06-01T00:00:00.000Z",
      }],
      items: [cloudItem],
      terminalRefs: {
        "cloud:remote-repo:task-cloud": {
          ownerDesktopId: "desktop-cloud",
          ownerLocalTaskId: "task-cloud",
          transport: "cloud",
        },
      },
    },
    lanSnapshot: emptySnapshot(),
  });

  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    itemId: "cloud:remote-repo:task-cloud",
    prompt: "Cloud diagnostic task",
    repoId: "cloud:remote-repo",
    sources: ["cloud"],
    selectedTerminalTransport: "cloud",
    ownerDesktopId: "desktop-cloud",
    ownerLocalTaskId: "task-cloud",
  }));
});

it("reports LAN as the selected transport when cloud and LAN advertise the same task", () => {
  const cloudItem = item({
    id: "cloud:remote-repo:task-shared",
    repo_id: "repo-local",
    prompt: "Shared diagnostic task",
  });
  const lanItem = item({
    id: "cloud:lan:peer-primary:remote-repo:task-shared",
    repo_id: "repo-local",
    prompt: "Shared diagnostic task",
  });

  const result = buildWorkspace({
    localRepos: [{ repo: repo({ id: "repo-local" }), remoteUrlHash: "same-hash" }],
    localItems: [],
    cloudSnapshot: {
      repos: [],
      items: [cloudItem],
      terminalRefs: {
        "cloud:remote-repo:task-shared": {
          ownerDesktopId: "desktop-cloud",
          ownerLocalTaskId: "task-shared",
          transport: "cloud",
        },
      },
    },
    lanSnapshot: {
      repos: [],
      items: [lanItem],
      terminalRefs: {
        "cloud:lan:peer-primary:remote-repo:task-shared": {
          ownerDesktopId: "peer-primary",
          ownerLocalTaskId: "task-shared",
          transport: "lan",
        },
      },
    },
  });

  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    prompt: "Shared diagnostic task",
    sources: ["cloud", "lan"],
    selectedTerminalTransport: "lan",
    ownerDesktopId: "peer-primary",
    ownerLocalTaskId: "task-shared",
  }));
});
```

- [ ] **Step 3: Run diagnostics tests and verify failure**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts
```

Expected: fail because `result.diagnostics` is missing.

- [ ] **Step 4: Implement diagnostics builder**

In `apps/desktop/src/workspace/buildWorkspace.ts`, add:

```ts
function diagnosticsForTask(task: WorkspaceTask): RemoteTaskDiagnostics {
  const selectedRef = task.terminal.kind === "cloud" || task.terminal.kind === "lan"
    ? task.terminal.remoteRef
    : undefined;
  const cloudSource = task.sources.find((source) => source.kind === "cloud");
  const lanSource = task.sources.find((source) => source.kind === "lan");
  const sources = task.sources
    .map((source) => source.kind)
    .filter((kind, index, all) => all.indexOf(kind) === index);

  return {
    itemId: task.item.id,
    prompt: task.item.prompt,
    repoId: task.repoKey,
    sources,
    selectedTerminalTransport: task.terminal.kind,
    ownerDesktopId: selectedRef?.ownerDesktopId,
    ownerLocalTaskId: selectedRef?.ownerLocalTaskId,
    cloudUpdatedAt: cloudSource?.updatedAt,
    lanUpdatedAt: lanSource?.updatedAt,
  };
}
```

Update the `buildWorkspace()` return:

```ts
const tasks = [...tasksByKey.values()].sort((a, b) =>
  b.item.created_at.localeCompare(a.item.created_at),
);

return {
  repos: repoContext.repos,
  tasks,
  diagnostics: tasks.map(diagnosticsForTask),
};
```

Add the import:

```ts
import type { RemoteTaskDiagnostics } from "./types";
```

- [ ] **Step 5: Expose diagnostics to E2E**

In `apps/desktop/src/App.vue`, add:

```ts
const remoteTaskDiagnostics = computed(() => workspace.value.diagnostics);
```

Because `App.vue` uses `<script setup>`, this top-level binding is automatically visible through the existing `window.__KANNA_E2E__.setupState` getter in `apps/desktop/src/main.ts`.

- [ ] **Step 6: Run diagnostics tests**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit diagnostics**

Run:

```bash
git add apps/desktop/src/workspace/types.ts apps/desktop/src/workspace/buildWorkspace.ts apps/desktop/src/workspace/buildWorkspace.test.ts apps/desktop/src/App.vue
git commit -m "test: expose remote task transport diagnostics"
```

---

### Task 2: Explicit Cloud Transport Assertions in Existing E2E

**Files:**
- Modify: `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`
- Modify: `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`

- [ ] **Step 1: Add E2E diagnostics helper**

In both files, add this helper near the existing sidebar helper functions:

```ts
async function remoteDiagnosticsForPrompt(
  client: typeof primary,
  prompt: string,
): Promise<Array<{
  prompt: string;
  sources: string[];
  selectedTerminalTransport: string;
  ownerDesktopId?: string;
  ownerLocalTaskId?: string;
}>> {
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.remoteTaskDiagnostics?.__v_isRef
      ? ctx.remoteTaskDiagnostics.value
      : ctx.remoteTaskDiagnostics;
    return JSON.parse(JSON.stringify((value || []).filter((entry) =>
      entry.prompt === ${JSON.stringify(prompt)}
    )));
  `);
}
```

- [ ] **Step 2: Assert cloud transport in cloud E2E**

In `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`, after the secondary sees `"Cloud sync visible task"`, add:

```ts
const cloudDiagnostics = await remoteDiagnosticsForPrompt(secondary, "Cloud sync visible task");
expect(cloudDiagnostics).toContainEqual(expect.objectContaining({
  selectedTerminalTransport: "cloud",
  sources: expect.arrayContaining(["cloud"]),
}));
```

- [ ] **Step 3: Assert LAN transport in LAN E2E**

In `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`, after the secondary sees the LAN task, add:

```ts
const lanDiagnostics = await remoteDiagnosticsForPrompt(secondary, "LAN visible task");
expect(lanDiagnostics).toContainEqual(expect.objectContaining({
  selectedTerminalTransport: "lan",
  sources: expect.arrayContaining(["lan"]),
}));
```

- [ ] **Step 4: Run focused unit tests**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts
```

Expected: pass.

- [ ] **Step 5: Run cloud emulator E2E**

Run from a worktree with emulators running:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-task-sync.test.ts
```

Expected: pass and diagnostics show `selectedTerminalTransport: "cloud"`.

- [ ] **Step 6: Run LAN E2E**

Run:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/local-transfer-task-sync.test.ts
```

Expected: pass and diagnostics show `selectedTerminalTransport: "lan"`.

- [ ] **Step 7: Commit E2E assertions**

Run:

```bash
git add apps/desktop/tests/e2e/real/cloud-task-sync.test.ts apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts
git commit -m "test: assert remote task transport in e2e"
```

---

### Task 3: Runtime Cloud Environment Selection

**Files:**
- Modify: `apps/desktop/src/services/desktopFirebaseConfig.ts`
- Test: `apps/desktop/src/services/desktopFirebaseConfig.test.ts`

- [ ] **Step 1: Add failing config tests**

Append to `apps/desktop/src/services/desktopFirebaseConfig.test.ts`:

```ts
it("uses runtime Firebase app config overrides when provided", async () => {
  const config = await resolveDesktopFirebaseConfig({
    dev: false,
    readEnv: async (name) => ({
      KANNA_FIREBASE_API_KEY: "runtime-key",
      KANNA_FIREBASE_AUTH_DOMAIN: "runtime.firebaseapp.com",
      KANNA_FIREBASE_PROJECT_ID: "runtime-project",
      KANNA_FIREBASE_APP_ID: "runtime-app-id",
      KANNA_CLOUD_FUNCTIONS_ENDPOINT: "https://runtime.example/upsertTaskSnapshot",
    }[name] ?? ""),
  });

  expect(config.app).toMatchObject({
    apiKey: "runtime-key",
    authDomain: "runtime.firebaseapp.com",
    projectId: "runtime-project",
    appId: "runtime-app-id",
  });
  expect(config.functionsEndpoint).toBe("https://runtime.example/upsertTaskSnapshot");
});

it("keeps emulator ports ahead of runtime function endpoint in local tests", async () => {
  const config = await resolveDesktopFirebaseConfig({
    dev: true,
    readEnv: async (name) => ({
      KANNA_FIREBASE_FUNCTIONS_PORT: "15002",
      KANNA_CLOUD_FUNCTIONS_ENDPOINT: "https://runtime.example/upsertTaskSnapshot",
    }[name] ?? ""),
  });

  expect(config.functionsEndpoint).toBe(
    "http://127.0.0.1:15002/kanna-local/us-central1/upsertTaskSnapshot",
  );
});
```

- [ ] **Step 2: Run config tests and verify failure**

Run:

```bash
pnpm --dir apps/desktop test -- desktopFirebaseConfig.test.ts
```

Expected: fail because runtime app config and `KANNA_CLOUD_FUNCTIONS_ENDPOINT` are ignored.

- [ ] **Step 3: Implement runtime env config**

In `apps/desktop/src/services/desktopFirebaseConfig.ts`, replace `readAppConfig(dev)` call with async runtime config:

```ts
const runtimeApp = await readRuntimeAppConfig(readEnv);
const app = runtimeApp ?? readBuildTimeAppConfig(dev);
```

Add:

```ts
async function readRuntimeAppConfig(
  readEnv: ResolveDesktopFirebaseConfigOptions["readEnv"],
): Promise<DesktopFirebaseAppConfig | null> {
  const [apiKey, authDomain, projectId, appId, storageBucket, messagingSenderId] = await Promise.all([
    readEnv("KANNA_FIREBASE_API_KEY").catch(() => ""),
    readEnv("KANNA_FIREBASE_AUTH_DOMAIN").catch(() => ""),
    readEnv("KANNA_FIREBASE_PROJECT_ID").catch(() => ""),
    readEnv("KANNA_FIREBASE_APP_ID").catch(() => ""),
    readEnv("KANNA_FIREBASE_STORAGE_BUCKET").catch(() => ""),
    readEnv("KANNA_FIREBASE_MESSAGING_SENDER_ID").catch(() => ""),
  ]);

  const normalizedApiKey = normalizeEnvValue(apiKey);
  const normalizedProjectId = normalizeEnvValue(projectId);
  const normalizedAppId = normalizeEnvValue(appId);
  if (!normalizedApiKey || !normalizedProjectId || !normalizedAppId) return null;

  return compactAppConfig({
    apiKey: normalizedApiKey,
    authDomain: normalizeEnvValue(authDomain),
    projectId: normalizedProjectId,
    appId: normalizedAppId,
    storageBucket: normalizeEnvValue(storageBucket),
    messagingSenderId: normalizeEnvValue(messagingSenderId),
  });
}
```

Rename `readAppConfig` to `readBuildTimeAppConfig`.

Update functions endpoint parsing:

```ts
const runtimeFunctionsEndpoint = await readEnv("KANNA_CLOUD_FUNCTIONS_ENDPOINT").catch(() => "");
functionsEndpoint: parseFunctionsEndpoint(functionsPort, runtimeFunctionsEndpoint, dev),
```

Change signature:

```ts
function parseFunctionsEndpoint(
  rawPort: string | undefined,
  runtimeEndpoint: string | undefined,
  dev: boolean,
): string | null {
  const parsed = parseAuthEmulatorPort(rawPort);
  if (parsed) {
    return `${parsed.url}/kanna-local/us-central1/upsertTaskSnapshot`;
  }

  const runtime = normalizeEnvValue(runtimeEndpoint);
  if (runtime) return runtime;

  return dev ? null : PRODUCTION_FUNCTIONS_ENDPOINT;
}
```

- [ ] **Step 4: Run config tests**

Run:

```bash
pnpm --dir apps/desktop test -- desktopFirebaseConfig.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit config selection**

Run:

```bash
git add apps/desktop/src/services/desktopFirebaseConfig.ts apps/desktop/src/services/desktopFirebaseConfig.test.ts
git commit -m "feat: support runtime cloud endpoint config"
```

---

### Task 4: `kd` Cloud Test Commands

**Files:**
- Modify: `tools/kd/src/cli.ts`
- Modify: `tools/kd/src/tasks/registry.ts`
- Create: `tools/kd/src/runtime/cloud-test.ts`
- Test: `tools/kd/tests/cloud-test.test.ts`
- Modify: `tools/kd/tests/cli.test.ts`

- [ ] **Step 1: Add failing CLI parser tests**

In `tools/kd/tests/cli.test.ts`, add:

```ts
it("parses cloud test commands", () => {
  expect(parseCliArgs(["test", "cloud-emulator"])).toEqual({
    taskId: "test.cloud-emulator",
    input: {},
  });
  expect(parseCliArgs(["test", "cloud-staging"])).toEqual({
    taskId: "test.cloud-staging",
    input: {},
  });
  expect(parseCliArgs(["test", "cloud-prod-smoke"])).toEqual({
    taskId: "test.cloud-prod-smoke",
    input: {},
  });
});
```

- [ ] **Step 2: Add failing runtime tests**

Create `tools/kd/tests/cloud-test.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildCloudEmulatorTestCommand,
  buildCloudSmokeEnv,
  requireCloudSmokeEnv,
} from "../src/runtime/cloud-test";

describe("cloud test runtime", () => {
  it("builds the emulator e2e command", () => {
    expect(buildCloudEmulatorTestCommand()).toEqual([
      "pnpm",
      ["--dir", "apps/desktop", "exec", "tsx", "tests/e2e/run.ts", "real/cloud-task-sync.test.ts"],
    ]);
  });

  it("requires staging cloud endpoint configuration", () => {
    expect(() => requireCloudSmokeEnv({
      KANNA_FIREBASE_API_KEY: "key",
      KANNA_FIREBASE_PROJECT_ID: "project",
      KANNA_FIREBASE_APP_ID: "app",
      KANNA_CLOUD_FUNCTIONS_ENDPOINT: "https://example/upsert",
      KANNA_CLOUD_TEST_EMAIL: "test@example.com",
      KANNA_CLOUD_TEST_PASSWORD: "password",
    }, "staging")).not.toThrow();
  });

  it("rejects incomplete cloud smoke configuration", () => {
    expect(() => requireCloudSmokeEnv({}, "staging")).toThrow("KANNA_FIREBASE_API_KEY");
  });

  it("builds cloud smoke env without mutating input", () => {
    const source = { KANNA_FIREBASE_API_KEY: "key" };
    const env = buildCloudSmokeEnv(source, "staging");
    expect(env.KANNA_CLOUD_ENV).toBe("staging");
    expect(source).toEqual({ KANNA_FIREBASE_API_KEY: "key" });
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm --dir tools/kd test -- cli.test.ts cloud-test.test.ts
```

Expected: fail because parser/runtime do not exist.

- [ ] **Step 4: Implement cloud-test runtime**

Create `tools/kd/src/runtime/cloud-test.ts`:

```ts
export type CloudEnvironment = "staging" | "production";

export function buildCloudEmulatorTestCommand(): [string, string[]] {
  return [
    "pnpm",
    ["--dir", "apps/desktop", "exec", "tsx", "tests/e2e/run.ts", "real/cloud-task-sync.test.ts"],
  ];
}

export function buildCloudSmokeCommand(): [string, string[]] {
  return [
    "pnpm",
    ["--dir", "apps/desktop", "exec", "tsx", "tests/e2e/run.ts", "real/cloud-prod-smoke.test.ts"],
  ];
}

export function buildCloudSmokeEnv(
  env: NodeJS.ProcessEnv,
  cloudEnv: CloudEnvironment,
): NodeJS.ProcessEnv {
  return {
    ...env,
    KANNA_CLOUD_ENV: cloudEnv,
  };
}

export function requireCloudSmokeEnv(
  env: NodeJS.ProcessEnv,
  cloudEnv: CloudEnvironment,
): void {
  const required = [
    "KANNA_FIREBASE_API_KEY",
    "KANNA_FIREBASE_PROJECT_ID",
    "KANNA_FIREBASE_APP_ID",
    "KANNA_CLOUD_FUNCTIONS_ENDPOINT",
    "KANNA_CLOUD_TEST_EMAIL",
    "KANNA_CLOUD_TEST_PASSWORD",
  ];
  for (const name of required) {
    if (!env[name]?.trim()) {
      throw new Error(`${name} is required for ${cloudEnv} cloud tests.`);
    }
  }
}
```

- [ ] **Step 5: Wire CLI parser**

In `tools/kd/src/cli.ts`, add:

```ts
if (group === "test" && command === "cloud-emulator") {
  return { taskId: "test.cloud-emulator", input: {} };
}
if (group === "test" && command === "cloud-staging") {
  return { taskId: "test.cloud-staging", input: {} };
}
if (group === "test" && command === "cloud-prod-smoke") {
  return { taskId: "test.cloud-prod-smoke", input: {} };
}
```

Add help lines:

```ts
"  test cloud-emulator",
"  test cloud-staging",
"  test cloud-prod-smoke",
```

- [ ] **Step 6: Register task definitions**

In `tools/kd/src/tasks/registry.ts`, import:

```ts
import {
  buildCloudEmulatorTestCommand,
  buildCloudSmokeCommand,
  buildCloudSmokeEnv,
  requireCloudSmokeEnv,
} from "../runtime/cloud-test";
```

Add task definitions:

```ts
{
  id: "test.cloud-emulator",
  description: "Run cloud sync E2E against Firebase emulators.",
  inputSchema: emptyInputSchema,
  execute: async () => {
    const context = await resolveDefaultContext(process.env);
    const [command, args] = buildCloudEmulatorTestCommand();
    const result = await nodeCommandRunner.run(command, args, {
      cwd: context.repoRoot,
      env: context.env,
    });
    return {
      ok: result.exitCode === 0,
      message: result.exitCode === 0 ? result.stdout : result.stderr || result.stdout,
    };
  }
},
{
  id: "test.cloud-staging",
  description: "Run cloud sync E2E against staging cloud services.",
  inputSchema: emptyInputSchema,
  execute: async () => {
    const context = await resolveDefaultContext(process.env);
    requireCloudSmokeEnv(context.env, "staging");
    const [command, args] = buildCloudSmokeCommand();
    const result = await nodeCommandRunner.run(command, args, {
      cwd: context.repoRoot,
      env: buildCloudSmokeEnv(context.env, "staging"),
    });
    return {
      ok: result.exitCode === 0,
      message: result.exitCode === 0 ? result.stdout : result.stderr || result.stdout,
    };
  }
},
{
  id: "test.cloud-prod-smoke",
  description: "Run minimal cloud smoke against production cloud services.",
  inputSchema: emptyInputSchema,
  execute: async () => {
    const context = await resolveDefaultContext(process.env);
    requireCloudSmokeEnv(context.env, "production");
    const [command, args] = buildCloudSmokeCommand();
    const result = await nodeCommandRunner.run(command, args, {
      cwd: context.repoRoot,
      env: buildCloudSmokeEnv(context.env, "production"),
    });
    return {
      ok: result.exitCode === 0,
      message: result.exitCode === 0 ? result.stdout : result.stderr || result.stdout,
    };
  }
},
```

- [ ] **Step 7: Run kd tests**

Run:

```bash
pnpm --dir tools/kd test -- cli.test.ts cloud-test.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit cloud test commands**

Run:

```bash
git add tools/kd/src/cli.ts tools/kd/src/tasks/registry.ts tools/kd/src/runtime/cloud-test.ts tools/kd/tests/cli.test.ts tools/kd/tests/cloud-test.test.ts
git commit -m "feat: add kd cloud test commands"
```

---

### Task 5: Cloud Smoke E2E

**Files:**
- Create: `apps/desktop/tests/e2e/real/cloud-prod-smoke.test.ts`

- [ ] **Step 1: Write failing smoke test**

Create `apps/desktop/tests/e2e/real/cloud-prod-smoke.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const cloudEnv = process.env.KANNA_CLOUD_ENV ?? "staging";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for cloud smoke tests`);
  return value;
}

async function signInForIdToken(): Promise<{ idToken: string; localId: string }> {
  const apiKey = requireEnv("KANNA_FIREBASE_API_KEY");
  const email = requireEnv("KANNA_CLOUD_TEST_EMAIL");
  const password = requireEnv("KANNA_CLOUD_TEST_PASSWORD");
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await response.json().catch(() => null) as { idToken?: string; localId?: string } | null;
  if (!response.ok || !body?.idToken || !body.localId) {
    throw new Error(`failed to sign in cloud smoke user: ${response.status} ${JSON.stringify(body)}`);
  }
  return { idToken: body.idToken, localId: body.localId };
}

function smokeSnapshot(runId: string) {
  const now = new Date().toISOString();
  return {
    cloudTaskId: `${cloudEnv}:smoke:${runId}`,
    ownerDesktopId: `desktop-smoke-${runId}`,
    ownerLocalTaskId: `task-smoke-${runId}`,
    title: `Kanna cloud smoke ${runId}`,
    promptSnippet: "Kanna cloud smoke",
    displayName: `Kanna cloud smoke ${runId}`,
    stage: "in progress",
    activity: "idle",
    status: "active",
    repo: {
      cloudRepoId: `${cloudEnv}:smoke-repo`,
      name: "kanna-smoke",
      remoteUrl: "https://example.invalid/kanna-smoke.git",
      remoteUrlHash: `smoke-${cloudEnv}`,
      defaultBranch: "main",
    },
    branch: `task-smoke-${runId}`,
    baseRef: "origin/main",
    prNumber: null,
    prUrl: null,
    agent: { provider: "codex", type: "pty" },
    transfer: {
      state: "none",
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null,
    },
    blockedByTaskIds: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}

async function readFirestoreDocument(uid: string, cloudTaskId: string, idToken: string): Promise<Record<string, unknown>> {
  const projectId = requireEnv("KANNA_FIREBASE_PROJECT_ID");
  const encodedPath = `users/${uid}/tasks/${cloudTaskId}`.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${encodedPath}`,
    {
      headers: { Authorization: `Bearer ${idToken}` },
    },
  );
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    throw new Error(`failed to read smoke snapshot: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function publishSnapshot(endpoint: string, idToken: string, snapshot: ReturnType<typeof smokeSnapshot>): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(snapshot),
  });
  if (response.status !== 200) {
    throw new Error(`failed to publish smoke snapshot: ${response.status} ${await response.text()}`);
  }
}

describe("cloud production/staging smoke", () => {
  it("publishes a smoke task through the deployed function and reads it from Firestore", async () => {
    const endpoint = requireEnv("KANNA_CLOUD_FUNCTIONS_ENDPOINT");
    const runId = randomUUID().slice(0, 8);
    const { idToken, localId } = await signInForIdToken();
    const snapshot = smokeSnapshot(runId);
    try {
      await publishSnapshot(endpoint, idToken, snapshot);
      const document = await readFirestoreDocument(localId, snapshot.cloudTaskId, idToken);
      expect(JSON.stringify(document)).toContain(snapshot.title);
    } finally {
      const now = new Date().toISOString();
      await publishSnapshot(endpoint, idToken, {
        ...snapshot,
        stage: "done",
        status: "done",
        updatedAt: now,
        closedAt: now,
      }).catch(() => undefined);
    }
  });
});
```

- [ ] **Step 2: Run smoke test without env and verify failure**

Run:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-prod-smoke.test.ts
```

Expected: fail with `KANNA_FIREBASE_API_KEY is required for cloud smoke tests`.

- [ ] **Step 3: Run against staging env**

Run with staging env:

```bash
KANNA_CLOUD_ENV=staging \
KANNA_FIREBASE_API_KEY="$KANNA_STAGING_FIREBASE_API_KEY" \
KANNA_FIREBASE_PROJECT_ID="$KANNA_STAGING_FIREBASE_PROJECT_ID" \
KANNA_CLOUD_FUNCTIONS_ENDPOINT="$KANNA_STAGING_CLOUD_FUNCTIONS_ENDPOINT" \
KANNA_CLOUD_TEST_EMAIL="$KANNA_STAGING_CLOUD_TEST_EMAIL" \
KANNA_CLOUD_TEST_PASSWORD="$KANNA_STAGING_CLOUD_TEST_PASSWORD" \
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-prod-smoke.test.ts
```

Expected: pass and mark the uniquely prefixed smoke snapshot closed.

- [ ] **Step 4: Commit smoke test**

Run:

```bash
git add apps/desktop/tests/e2e/real/cloud-prod-smoke.test.ts
git commit -m "test: add cloud smoke e2e"
```

---

### Task 6: Staging Cloud Deploy Support

**Files:**
- Modify: `tools/kd/src/runtime/cloud-deploy.ts`
- Modify: `tools/kd/src/tasks/registry.ts`
- Modify: `tools/kd/src/cli.ts`
- Test: `tools/kd/tests/cloud-deploy.test.ts`
- Test: `tools/kd/tests/cli.test.ts`

- [ ] **Step 1: Add failing staging deploy tests**

In `tools/kd/tests/cloud-deploy.test.ts`, add:

```ts
it("resolves staging Firebase project from environment", () => {
  expect(resolveFirebaseProject("/repo", {
    KANNA_FIREBASE_STAGING_PROJECT: "kanna-staging",
  } as NodeJS.ProcessEnv, "staging")).toBe("kanna-staging");
});

it("refuses cloud deploy without an explicit environment", async () => {
  const runner: CommandRunner = {
    async run() {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };

  await expect(deployFirebaseCloud({
    repoRoot: "/repo",
    env: {},
    runner,
    environment: "none" as never,
    relay: false,
  })).rejects.toThrow("cloud deploy requires staging or production");
});
```

Update the test imports to include `resolveFirebaseProject` and `type CommandRunner`.

- [ ] **Step 2: Add CLI parser test**

In `tools/kd/tests/cli.test.ts`, add:

```ts
expect(parseCliArgs(["cloud", "deploy", "--staging", "--relay"])).toEqual({
  taskId: "cloud.deploy",
  input: { staging: true, production: false, relay: true },
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm --dir tools/kd test -- cloud-deploy.test.ts cli.test.ts
```

Expected: fail because staging deploy is unsupported.

- [ ] **Step 4: Implement staging project resolution**

In `tools/kd/src/runtime/cloud-deploy.ts`, replace `production: boolean` with:

```ts
export type CloudDeployEnvironment = "staging" | "production";

export interface CloudDeployInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  environment: CloudDeployEnvironment;
}
```

Add:

```ts
export function resolveFirebaseProject(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  environment: CloudDeployEnvironment,
): string {
  const envName = environment === "staging"
    ? "KANNA_FIREBASE_STAGING_PROJECT"
    : "KANNA_FIREBASE_PRODUCTION_PROJECT";
  const envProject = env[envName]?.trim();
  if (envProject) return envProject;

  try {
    const firebaserc = JSON.parse(readFileSync(join(repoRoot, ".firebaserc"), "utf8")) as Firebaserc;
    const project = firebaserc.projects?.[environment]?.trim();
    if (project) return project;
  } catch {
    // Fall through to explicit error.
  }

  throw new Error(`No ${environment} Firebase project configured. Set ${envName} or add projects.${environment} to .firebaserc.`);
}

export function resolveProductionFirebaseProject(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  return resolveFirebaseProject(repoRoot, env, "production");
}
```

Update deploy guard:

```ts
if (input.environment !== "staging" && input.environment !== "production") {
  throw new Error("cloud deploy requires staging or production");
}
```

Use `resolveFirebaseProject(input.repoRoot, input.env, input.environment)` in both Function and relay deploy paths.

In existing `cloud-deploy.test.ts` deploy invocations, replace `production: true` with `environment: "production"`.

- [ ] **Step 5: Wire CLI staging flag**

In `tools/kd/src/cli.ts`, add to `booleanFlagMap`:

```ts
"--staging": "staging",
```

Update cloud deploy parse defaults:

```ts
return { taskId: "cloud.deploy", input: parseFlagInput(rest, { staging: false, production: false, relay: false }) };
```

- [ ] **Step 6: Wire task registry environment**

In `tools/kd/src/tasks/registry.ts`, update schema:

```ts
const cloudDeployInputSchema = z.object({
  staging: z.boolean().default(false),
  production: z.boolean().default(false),
  relay: z.boolean().default(false)
});
```

Before calling `deployFirebaseCloud`, derive environment:

```ts
const environment = parsed.staging ? "staging" : parsed.production ? "production" : null;
if (parsed.staging && parsed.production) {
  return { ok: false, message: "cloud deploy accepts only one of --staging or --production." };
}
if (!environment) {
  return { ok: false, message: "cloud deploy requires --staging or --production." };
}
```

Pass:

```ts
environment,
```

- [ ] **Step 7: Run kd deploy tests**

Run:

```bash
pnpm --dir tools/kd test -- cloud-deploy.test.ts cli.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit staging deploy support**

Run:

```bash
git add tools/kd/src/runtime/cloud-deploy.ts tools/kd/src/tasks/registry.ts tools/kd/src/cli.ts tools/kd/tests/cloud-deploy.test.ts tools/kd/tests/cli.test.ts
git commit -m "feat: support staging cloud deploys"
```

---

### Task 7: Physical LAN Lab Runner

**Files:**
- Create: `tools/kd/src/runtime/lan-lab.ts`
- Test: `tools/kd/tests/lan-lab.test.ts`
- Modify: `tools/kd/src/cli.ts`
- Modify: `tools/kd/src/tasks/registry.ts`
- Modify: `tools/kd/tests/cli.test.ts`
- Create: `.kanna/lab/macs.example.json`

- [ ] **Step 1: Add failing LAN lab tests**

Create `tools/kd/tests/lan-lab.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildLanLabPlan,
  parseLanLabInventory,
} from "../src/runtime/lan-lab";

describe("LAN lab runtime", () => {
  it("parses a physical Mac inventory", () => {
    const inventory = parseLanLabInventory(JSON.stringify({
      hosts: [
        { name: "desktop-a", ssh: "desktop-a.local", repo: "/Users/jeremy/kanna" },
        { name: "desktop-b", ssh: "desktop-b.local", repo: "/Users/jeremy/kanna", webDriverPort: 4456 },
      ],
    }));

    expect(inventory.hosts).toHaveLength(2);
    expect(inventory.hosts[0]).toMatchObject({
      name: "desktop-a",
      ssh: "desktop-a.local",
      repo: "/Users/jeremy/kanna",
      webDriverPort: 4445,
    });
    expect(inventory.hosts[1]?.webDriverPort).toBe(4456);
  });

  it("requires at least two physical hosts", () => {
    expect(() => parseLanLabInventory(JSON.stringify({
      hosts: [{ name: "desktop-a", ssh: "desktop-a.local", repo: "/Users/jeremy/kanna" }],
    }))).toThrow("LAN lab requires at least two hosts");
  });

  it("builds isolated worker commands", () => {
    const plan = buildLanLabPlan({
      runId: "run-123",
      tunnelBasePort: 46000,
      hosts: [
        { name: "desktop-a", ssh: "desktop-a.local", repo: "/Users/jeremy/kanna", webDriverPort: 4445 },
        { name: "desktop-b", ssh: "desktop-b.local", repo: "/Users/jeremy/kanna", webDriverPort: 4445 },
      ],
    });

    expect(plan.workers[0]?.startSshArgs).toEqual([
      "desktop-a.local",
      "cd '/Users/jeremy/kanna' && KANNA_WEBDRIVER_PORT='4445' KANNA_TRANSFER_DISCOVERY='mdns' KANNA_TRANSFER_PEER_ID='desktop-a' KANNA_TRANSFER_DISPLAY_NAME='desktop-a' ./kd dev up --db 'kanna-test-lab-run-123-desktop-a.db' --delete-db --daemon-dir '.kanna-lab/run-123/desktop-a/daemon' --transfer-root '.kanna-lab/run-123/desktop-a/transfer'",
    ]);
    expect(plan.workers[0]?.peerId).toBe("desktop-a");
    expect(plan.workers[0]?.tunnelArgs).toEqual([
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "46000:127.0.0.1:4445",
      "desktop-a.local",
    ]);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --dir tools/kd test -- lan-lab.test.ts
```

Expected: fail because `lan-lab.ts` does not exist.

- [ ] **Step 3: Implement inventory parser and command planner**

Create `tools/kd/src/runtime/lan-lab.ts`:

```ts
import { z } from "zod";

const hostSchema = z.object({
  name: z.string().min(1),
  ssh: z.string().min(1),
  repo: z.string().min(1),
  webDriverPort: z.number().int().min(1).max(65535).default(4445),
});

const inventorySchema = z.object({
  hosts: z.array(hostSchema).min(2),
});

export type LanLabHost = z.infer<typeof hostSchema>;
export type LanLabInventory = z.infer<typeof inventorySchema>;

export interface LanLabPlanInput {
  runId: string;
  hosts: LanLabHost[];
  tunnelBasePort: number;
}

export interface LanLabWorkerPlan {
  host: LanLabHost;
  peerId: string;
  localWebDriverPort: number;
  startSshArgs: string[];
  tunnelArgs: string[];
}

export interface LanLabPlan {
  workers: LanLabWorkerPlan[];
}

export function parseLanLabInventory(raw: string): LanLabInventory {
  const parsed = inventorySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.path[0] === "hosts" && issue.code === "too_small")) {
      throw new Error("LAN lab requires at least two hosts");
    }
    throw new Error(parsed.error.message);
  }
  if (new Set(parsed.data.hosts.map((host) => host.name)).size !== parsed.data.hosts.length) {
    throw new Error("LAN lab host names must be unique");
  }
  return parsed.data;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function buildLanLabPlan(input: LanLabPlanInput): LanLabPlan {
  return {
    workers: input.hosts.map((host, index) => {
      const name = safeName(host.name);
      const daemonDir = `.kanna-lab/${input.runId}/${name}/daemon`;
      const transferRoot = `.kanna-lab/${input.runId}/${name}/transfer`;
      const dbName = `kanna-test-lab-${input.runId}-${name}.db`;
      const localWebDriverPort = input.tunnelBasePort + index;
      const command = [
        `cd ${shellQuote(host.repo)}`,
        [
          `KANNA_WEBDRIVER_PORT=${shellQuote(String(host.webDriverPort))}`,
          "KANNA_TRANSFER_DISCOVERY='mdns'",
          `KANNA_TRANSFER_PEER_ID=${shellQuote(name)}`,
          `KANNA_TRANSFER_DISPLAY_NAME=${shellQuote(host.name)}`,
          "./kd dev up",
          `--db ${shellQuote(dbName)}`,
          "--delete-db",
          `--daemon-dir ${shellQuote(daemonDir)}`,
          `--transfer-root ${shellQuote(transferRoot)}`,
        ].join(" "),
      ].join(" && ");
      return {
        host,
        peerId: name,
        localWebDriverPort,
        startSshArgs: [host.ssh, command],
        tunnelArgs: [
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `${localWebDriverPort}:127.0.0.1:${host.webDriverPort}`,
          host.ssh,
        ],
      };
    }),
  };
}
```

- [ ] **Step 4: Add CLI parser and help**

In `tools/kd/src/cli.ts`, support `--hosts` in `parseFlagInput`:

```ts
if (arg === "--hosts") {
  const value = rest[index + 1];
  if (!value) {
    throw new Error("--hosts requires a value");
  }
  input.hosts = value;
  index += 1;
  continue;
}
```

Add command:

```ts
if (group === "test" && command === "lan-lab") {
  return { taskId: "test.lan-lab", input: parseFlagInput(rest, {}) };
}
```

Add help line:

```ts
"  test lan-lab --hosts <path>",
```

In `tools/kd/tests/cli.test.ts`, add:

```ts
expect(parseCliArgs(["test", "lan-lab", "--hosts", ".kanna/lab/macs.json"])).toEqual({
  taskId: "test.lan-lab",
  input: { hosts: ".kanna/lab/macs.json" },
});
```

- [ ] **Step 5: Register LAN lab task**

In `tools/kd/src/tasks/registry.ts`, add schema:

```ts
const lanLabInputSchema = z.object({
  hosts: z.string()
});
```

Import:

```ts
import { readFile } from "node:fs/promises";
import { buildLanLabPlan, parseLanLabInventory } from "../runtime/lan-lab";
```

Add task:

```ts
{
  id: "test.lan-lab",
  description: "Run LAN sync tests against physical Macs over SSH.",
  inputSchema: lanLabInputSchema,
  execute: async (_context, input) => {
    const parsed = lanLabInputSchema.parse(input);
    const context = await resolveDefaultContext(process.env);
    const inventory = parseLanLabInventory(await readFile(parsed.hosts, "utf8"));
    const runId = `run-${Date.now()}`;
    const plan = buildLanLabPlan({ runId, hosts: inventory.hosts, tunnelBasePort: 46000 });
    const results = [];
    for (const worker of plan.workers) {
      const result = await nodeCommandRunner.run("ssh", worker.startSshArgs, {
        cwd: context.repoRoot,
        env: context.env,
      });
      results.push({ host: worker.host.name, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          message: `LAN lab worker ${worker.host.name} failed: ${result.stderr || result.stdout}`,
          data: { runId, results },
        };
      }
    }
    return {
      ok: true,
      message: `Started LAN lab run ${runId} on ${plan.workers.length} hosts.`,
      data: { runId, results },
    };
  }
},
```

- [ ] **Step 6: Add example inventory**

Create `.kanna/lab/macs.example.json`:

```json
{
  "hosts": [
    {
      "name": "desktop-a",
      "ssh": "desktop-a.local",
      "repo": "/Users/jeremy/kanna",
      "webDriverPort": 4445
    },
    {
      "name": "desktop-b",
      "ssh": "desktop-b.local",
      "repo": "/Users/jeremy/kanna",
      "webDriverPort": 4445
    },
    {
      "name": "laptop",
      "ssh": "laptop.local",
      "repo": "/Users/jeremy/kanna",
      "webDriverPort": 4445
    }
  ]
}
```

- [ ] **Step 7: Run kd LAN lab tests**

Run:

```bash
pnpm --dir tools/kd test -- cli.test.ts lan-lab.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit LAN lab planner**

Run:

```bash
git add tools/kd/src/runtime/lan-lab.ts tools/kd/src/cli.ts tools/kd/src/tasks/registry.ts tools/kd/tests/lan-lab.test.ts tools/kd/tests/cli.test.ts .kanna/lab/macs.example.json
git commit -m "feat: add physical LAN lab test planner"
```

---

### Task 8: LAN Lab End-to-End Assertions

**Files:**
- Create: `tools/kd/src/runtime/lan-lab-runner.ts`
- Test: `tools/kd/tests/lan-lab-runner.test.ts`
- Modify: `tools/kd/src/tasks/registry.ts`
- Create: `apps/desktop/tests/e2e/helpers/lan-lab-scenario.ts`

- [ ] **Step 1: Add runner tests**

Create `tools/kd/tests/lan-lab-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildLanLabScenarioCommand } from "../src/runtime/lan-lab-runner";

describe("LAN lab assertion runner", () => {
  it("builds the controller-side scenario command", () => {
    const command = buildLanLabScenarioCommand({
      prompt: "LAN lab visible task",
      source: {
        repo: "/Users/jeremy/kanna",
        peerId: "desktop-a",
        displayName: "desktop-a",
        localWebDriverPort: 46000,
      },
      observer: {
        repo: "/Users/jeremy/kanna",
        peerId: "desktop-b",
        displayName: "desktop-b",
        localWebDriverPort: 46001,
      },
    });

    expect(command).toEqual({
      command: "pnpm",
      args: [
        "--dir",
        "apps/desktop",
        "exec",
        "tsx",
        "tests/e2e/helpers/lan-lab-scenario.ts",
        "--source-port",
        "46000",
        "--observer-port",
        "46001",
        "--source-repo",
        "/Users/jeremy/kanna",
        "--observer-repo",
        "/Users/jeremy/kanna",
        "--source-peer",
        "desktop-a",
        "--observer-peer",
        "desktop-b",
        "--observer-name",
        "desktop-b",
        "--prompt",
        "LAN lab visible task",
      ],
    });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --dir tools/kd test -- lan-lab-runner.test.ts
```

Expected: fail because runner module does not exist.

- [ ] **Step 3: Implement assertion command builder**

Create `tools/kd/src/runtime/lan-lab-runner.ts`:

```ts
export interface LanLabScenarioEndpoint {
  repo: string;
  peerId: string;
  displayName: string;
  localWebDriverPort: number;
}

export interface LanLabScenarioInput {
  source: LanLabScenarioEndpoint;
  observer: LanLabScenarioEndpoint;
  prompt: string;
}

export interface BuiltLanLabScenarioCommand {
  command: "pnpm";
  args: string[];
}

export function buildLanLabScenarioCommand(input: LanLabScenarioInput): BuiltLanLabScenarioCommand {
  return {
    command: "pnpm",
    args: [
      "--dir",
      "apps/desktop",
      "exec",
      "tsx",
      "tests/e2e/helpers/lan-lab-scenario.ts",
      "--source-port",
      String(input.source.localWebDriverPort),
      "--observer-port",
      String(input.observer.localWebDriverPort),
      "--source-repo",
      input.source.repo,
      "--observer-repo",
      input.observer.repo,
      "--source-peer",
      input.source.peerId,
      "--observer-peer",
      input.observer.peerId,
      "--observer-name",
      input.observer.displayName,
      "--prompt",
      input.prompt,
    ],
  };
}
```

- [ ] **Step 4: Create physical LAN scenario helper**

Create `apps/desktop/tests/e2e/helpers/lan-lab-scenario.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { WebDriverClient } from "./webdriver";
import { pairWithPeerThroughUi } from "./transferFlow";
import { callVueMethod, tauriInvoke } from "./vue";

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readPort(name: string): number {
  const value = Number(readArg(name));
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a TCP port`);
  }
  return value;
}

async function importRepo(client: WebDriverClient, repoPath: string, name: string): Promise<string> {
  const result = await callVueMethod(client, "store.importRepo", repoPath, name, "main");
  if (typeof result !== "string") throw new Error(`importRepo returned ${JSON.stringify(result)}`);
  await callVueMethod(client, "store.selectRepo", result);
  return result;
}

async function createTask(client: WebDriverClient, repoId: string, repoPath: string, prompt: string): Promise<string> {
  const result = await callVueMethod(
    client,
    "store.createItem",
    repoId,
    repoPath,
    prompt,
    "sdk",
    { agentProvider: "codex", baseRef: "origin/main" },
  );
  if (typeof result !== "string") throw new Error(`createItem returned ${JSON.stringify(result)}`);
  await tauriInvoke(client, "spawn_session", {
    sessionId: result,
    cwd: repoPath,
    executable: "/bin/zsh",
    args: ["--login", "-c", "printf 'LAN lab terminal ready\\n'; sleep 60"],
    env: {},
    cols: 80,
    rows: 24,
    agentProvider: "codex",
  });
  return result;
}

async function waitForLanDiagnostics(client: WebDriverClient, prompt: string): Promise<unknown> {
  const deadline = Date.now() + 60_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    last = await client.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const value = ctx.remoteTaskDiagnostics?.__v_isRef
        ? ctx.remoteTaskDiagnostics.value
        : ctx.remoteTaskDiagnostics;
      return JSON.parse(JSON.stringify((value || []).filter((entry) =>
        entry.prompt === ${JSON.stringify(prompt)}
      )));
    `);
    if (Array.isArray(last) && last.some((entry) =>
      entry?.selectedTerminalTransport === "lan" &&
      Array.isArray(entry.sources) &&
      entry.sources.includes("lan")
    )) return last;
    await sleep(500);
  }
  throw new Error(`LAN lab diagnostics missing for ${prompt}: ${JSON.stringify(last)}`);
}

const sourcePort = readPort("--source-port");
const observerPort = readPort("--observer-port");
const sourceRepo = readArg("--source-repo");
const observerRepo = readArg("--observer-repo");
const sourcePeer = readArg("--source-peer");
const observerPeer = readArg("--observer-peer");
const observerName = readArg("--observer-name");
const prompt = readArg("--prompt");

const source = new WebDriverClient(sourcePort);
const observer = new WebDriverClient(observerPort);
await source.createSession();
await observer.createSession();
try {
  const sourceRepoId = await importRepo(source, sourceRepo, "lan-lab-source");
  await importRepo(observer, observerRepo, "lan-lab-observer");
  await pairWithPeerThroughUi(source, observerName, observerPeer, {
    promptClient: observer,
    promptPeerId: sourcePeer,
  });
  await createTask(source, sourceRepoId, sourceRepo, prompt);
  const diagnostics = await waitForLanDiagnostics(observer, prompt);
  console.log(JSON.stringify({ ok: true, diagnostics }));
} finally {
  await source.deleteSession().catch(() => undefined);
  await observer.deleteSession().catch(() => undefined);
}
```

- [ ] **Step 5: Extend LAN lab task with tunnel and scenario phase**

In `tools/kd/src/tasks/registry.ts`, replace the Task 7 success return with a tunnel/scenario block, then return success after the scenario completes:

```ts
const tunnelProcesses = plan.workers.map((worker) =>
  spawn("ssh", worker.tunnelArgs, { stdio: "ignore" })
);
try {
  await Promise.all(plan.workers.map((worker) =>
    waitForTcpPort(worker.localWebDriverPort, 30_000)
  ));
  const [source, observer] = plan.workers;
  const scenario = buildLanLabScenarioCommand({
    prompt: "LAN lab visible task",
    source: {
      repo: source.host.repo,
      peerId: source.peerId,
      displayName: source.host.name,
      localWebDriverPort: source.localWebDriverPort,
    },
    observer: {
      repo: observer.host.repo,
      peerId: observer.peerId,
      displayName: observer.host.name,
      localWebDriverPort: observer.localWebDriverPort,
    },
  });
  const scenarioResult = await nodeCommandRunner.run(scenario.command, scenario.args, {
    cwd: context.repoRoot,
    env: context.env,
  });
  if (scenarioResult.exitCode !== 0) {
    return {
      ok: false,
      message: scenarioResult.stderr || scenarioResult.stdout || "LAN lab scenario failed.",
      data: { runId, results, scenarioResult },
    };
  }
} finally {
  for (const tunnel of tunnelProcesses) {
    tunnel.kill("SIGTERM");
  }
}
return {
  ok: true,
  message: `LAN lab run ${runId} passed.`,
  data: { runId, results },
};
```

Add helper functions in the same file:

```ts
async function waitForTcpPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolvePort) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePort(true);
      });
      socket.once("error", () => resolvePort(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolvePort(false);
      });
    });
    if (ok) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`timed out waiting for WebDriver tunnel on port ${port}`);
}
```

Import:

```ts
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { buildLanLabScenarioCommand } from "../runtime/lan-lab-runner";
```

- [ ] **Step 6: Run runner tests**

Run:

```bash
pnpm --dir tools/kd test -- lan-lab-runner.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit LAN assertions**

Run:

```bash
git add tools/kd/src/runtime/lan-lab-runner.ts tools/kd/tests/lan-lab-runner.test.ts tools/kd/src/tasks/registry.ts apps/desktop/tests/e2e/helpers/lan-lab-scenario.ts
git commit -m "test: add LAN lab transport assertions"
```

---

### Task 9: Documentation and Final Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-05-31-cloud-testing-strategy-design.md`

- [ ] **Step 1: Update spec command details**

In `docs/superpowers/specs/2026-05-31-cloud-testing-strategy-design.md`, replace general command descriptions with implemented behavior:

```md
- `./kd test cloud-emulator`
  Runs `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts` against local Firebase emulators.

- `./kd test cloud-staging`
  Requires staging Firebase env vars and runs `cloud-prod-smoke.test.ts` with `KANNA_CLOUD_ENV=staging`.

- `./kd test cloud-prod-smoke`
  Requires production Firebase env vars and runs `cloud-prod-smoke.test.ts` with `KANNA_CLOUD_ENV=production`.

- `./kd test lan-lab --hosts .kanna/lab/macs.json`
  Starts isolated Kanna workers over SSH and asserts LAN transport diagnostics.
```

- [ ] **Step 2: Run full focused verification**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts desktopFirebaseConfig.test.ts
pnpm --dir tools/kd test -- cli.test.ts cloud-test.test.ts cloud-deploy.test.ts lan-lab.test.ts lan-lab-runner.test.ts
pnpm --dir apps/desktop build
```

Expected: all pass. Vite chunk warnings are acceptable if build exits `0`.

- [ ] **Step 3: Run emulator cloud E2E**

Run:

```bash
./kd test cloud-emulator
```

Expected: pass and report cloud transport diagnostics.

- [ ] **Step 4: Run staging smoke when credentials are available**

Run:

```bash
./kd test cloud-staging
```

Expected: pass with staging env configured. If env is missing, command must fail with the first missing variable name.

- [ ] **Step 5: Run LAN lab when hosts are available**

Run:

```bash
./kd test lan-lab --hosts .kanna/lab/macs.json
```

Expected: starts workers and either passes LAN diagnostics or fails with host-specific SSH/app diagnostics.

- [ ] **Step 6: Commit docs and verification updates**

Run:

```bash
git add docs/superpowers/specs/2026-05-31-cloud-testing-strategy-design.md
git commit -m "docs: document cloud and LAN test commands"
```
