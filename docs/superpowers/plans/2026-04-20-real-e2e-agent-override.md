# Real E2E Agent Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real desktop E2E runs default to `codex` with `gpt-5.4-mini` without requiring Claude authentication, while keeping DB task metadata and runtime spawn configuration in sync.

**Architecture:** Add a small desktop-side resolver that reads `KANNA_E2E_REAL_AGENT_PROVIDER` and `KANNA_E2E_REAL_AGENT_MODEL`, validates them, and returns a PTY-task override only when task creation did not already specify an explicit provider or model. Wire that resolver into `tasks.ts` before DB insert and before spawn, and have the E2E runner inject the default real-suite env vars so the policy stays centralized in the harness.

**Tech Stack:** TypeScript, Vue/Pinia store logic, Vitest, desktop E2E runner

---

### Task 1: Add a focused real-E2E agent override resolver

**Files:**
- Create: `apps/desktop/src/stores/e2eRealAgentOverride.ts`
- Create: `apps/desktop/src/stores/e2eRealAgentOverride.test.ts`
- Test: `apps/desktop/src/stores/e2eRealAgentOverride.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const readEnvVar = vi.fn(async (_name: string) => "");

vi.mock("../invoke", () => ({
  invoke: vi.fn(async (command: string, args?: { name?: string }) => {
    if (command === "read_env_var") {
      return readEnvVar(args?.name ?? "");
    }
    throw new Error(`unexpected invoke: ${command}`);
  }),
}));

describe("resolveRealE2eAgentOverride", () => {
  beforeEach(() => {
    readEnvVar.mockReset();
    readEnvVar.mockResolvedValue("");
  });

  it("returns a codex model override for PTY tasks when env vars are present", async () => {
    readEnvVar.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: undefined,
        explicitModel: undefined,
      }),
    ).resolves.toEqual({
      agentProvider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("ignores invalid provider values", async () => {
    readEnvVar.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "bogus";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: undefined,
        explicitModel: undefined,
      }),
    ).resolves.toBeNull();
  });

  it("ignores empty model overrides", async () => {
    readEnvVar.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: undefined,
        explicitModel: undefined,
      }),
    ).resolves.toEqual({
      agentProvider: "codex",
      model: null,
    });
  });

  it("does not apply overrides when an explicit provider is supplied", async () => {
    readEnvVar.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: "copilot",
        explicitModel: undefined,
      }),
    ).resolves.toBeNull();
  });

  it("does not apply overrides when an explicit model is supplied", async () => {
    readEnvVar.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: undefined,
        explicitModel: "gpt-5.1",
      }),
    ).resolves.toBeNull();
  });

  it("does not apply overrides to SDK tasks", async () => {
    readEnvVar.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "sdk",
        explicitAgentProvider: undefined,
        explicitModel: undefined,
      }),
    ).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the resolver tests to verify they fail**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/e2eRealAgentOverride.test.ts`
Expected: FAIL because `e2eRealAgentOverride.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal resolver**

```ts
import type { AgentProvider } from "@kanna/db";
import { invoke } from "../invoke";

export interface RealE2eAgentOverrideInput {
  agentType: "pty" | "sdk";
  explicitAgentProvider?: AgentProvider;
  explicitModel?: string;
}

export interface RealE2eAgentOverride {
  agentProvider: AgentProvider;
  model: string | null;
}

function isAgentProvider(value: string): value is AgentProvider {
  return value === "claude" || value === "copilot" || value === "codex";
}

async function readEnv(name: string): Promise<string> {
  try {
    return (await invoke<string>("read_env_var", { name })) || "";
  } catch {
    return "";
  }
}

export async function resolveRealE2eAgentOverride(
  input: RealE2eAgentOverrideInput,
): Promise<RealE2eAgentOverride | null> {
  if (input.agentType !== "pty") return null;
  if (input.explicitAgentProvider || input.explicitModel) return null;

  const [rawProvider, rawModel] = await Promise.all([
    readEnv("KANNA_E2E_REAL_AGENT_PROVIDER"),
    readEnv("KANNA_E2E_REAL_AGENT_MODEL"),
  ]);

  const provider = rawProvider.trim();
  if (!isAgentProvider(provider)) return null;

  const model = rawModel.trim();
  return {
    agentProvider: provider,
    model: model.length > 0 ? model : null,
  };
}
```

- [ ] **Step 4: Run the resolver tests to verify they pass**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/e2eRealAgentOverride.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the resolver**

```bash
git add apps/desktop/src/stores/e2eRealAgentOverride.ts apps/desktop/src/stores/e2eRealAgentOverride.test.ts
git commit -m "test: add real e2e agent override resolver"
```

### Task 2: Apply the override in task creation before DB insert and spawn

**Files:**
- Modify: `apps/desktop/src/stores/tasks.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Add failing store integration tests for the override**

```ts
it("uses the real E2E override for PTY task provider and model when no explicit choice is supplied", async () => {
  mockState.readEnvVarOverrides = {
    KANNA_DB_NAME: "kanna-wt-task-existing.db",
    KANNA_E2E_REAL_AGENT_PROVIDER: "codex",
    KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-mini",
  };
  const store = await createStore();

  await store.createItem("repo-1", "/tmp/repo", "Use cheap real e2e agent", "pty");

  expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      agent_provider: "codex",
    }),
  );

  await vi.waitFor(() => {
    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        cmd: expect.stringContaining("codex"),
      }),
    );
  });

  await vi.waitFor(() => {
    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        cmd: expect.stringContaining("-m gpt-5.4-mini"),
      }),
    );
  });
});

it("does not override an explicit PTY provider choice", async () => {
  mockState.readEnvVarOverrides = {
    KANNA_DB_NAME: "kanna-wt-task-existing.db",
    KANNA_E2E_REAL_AGENT_PROVIDER: "codex",
    KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-mini",
  };
  const store = await createStore();

  await store.createItem("repo-1", "/tmp/repo", "Respect explicit provider", "pty", {
    agentProvider: "copilot",
  });

  expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      agent_provider: "copilot",
    }),
  );

  await vi.waitFor(() => {
    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        cmd: expect.stringContaining("copilot"),
      }),
    );
  });
});
```

- [ ] **Step 2: Run the integration test file to verify the new assertions fail**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts`
Expected: FAIL because task creation does not yet resolve the real-E2E override.

- [ ] **Step 3: Wire the resolver into `createItem` and spawn setup**

```ts
import { resolveRealE2eAgentOverride } from "./e2eRealAgentOverride";

const requestedAgentProviders = opts?.customTask?.agentProvider ?? opts?.agentProvider;
const requestedModel = opts?.customTask?.model ?? opts?.model;
const realE2eOverride = await resolveRealE2eAgentOverride({
  agentType: effectiveAgentType,
  explicitAgentProvider: requestedAgentProviders,
  explicitModel: requestedModel,
});

const requestedProviderForResolution = realE2eOverride?.agentProvider ?? requestedAgentProviders;
const resolvedModel = requestedModel ?? realE2eOverride?.model ?? null;
```

And use the resolved values consistently:

```ts
const candidates = getPreferredAgentProviders({
  explicit: requestedProviderForResolution,
  stage: firstStageProviders,
  agent: firstStageAgentProviders,
});
```

```ts
await insertPipelineItem(context.requireDb(), {
  // ...
  agent_provider: effectiveAgentProvider,
});
```

```ts
void setupWorktreeAndSpawn(
  id,
  repoPath,
  worktreePath,
  branch,
  workflowPrompt,
  effectiveAgentType,
  effectiveAgentProvider,
  {
    ...opts,
    model: resolvedModel ?? undefined,
  },
);
```

- [ ] **Step 4: Update the existing test mock to support env overrides**

```ts
let readEnvVarOverrides: Record<string, string> = {
  KANNA_DB_NAME: "kanna-wt-task-existing.db",
};

case "read_env_var":
  return readEnvVarOverrides[String(args?.name ?? "")] ?? "";
```

And reset it in `mockState.reset()`:

```ts
readEnvVarOverrides = {
  KANNA_DB_NAME: "kanna-wt-task-existing.db",
};
```

- [ ] **Step 5: Run the store integration tests to verify they pass**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the task creation wiring**

```bash
git add apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "feat: apply real e2e agent overrides to pty task creation"
```

### Task 3: Inject real-suite defaults from the desktop E2E runner

**Files:**
- Create: `apps/desktop/tests/e2e/runEnv.ts`
- Create: `apps/desktop/tests/e2e/runEnv.test.ts`
- Modify: `apps/desktop/tests/e2e/run.ts`
- Test: `apps/desktop/tests/e2e/runEnv.test.ts`

- [ ] **Step 1: Write failing tests for runner env resolution**

```ts
import { describe, expect, it } from "vitest";
import { buildRealE2eAgentEnv } from "./runEnv";

describe("buildRealE2eAgentEnv", () => {
  it("returns codex and gpt-5.4-mini for real suites by default", () => {
    expect(buildRealE2eAgentEnv(["tests/e2e/real/claude-session.test.ts"], {})).toEqual({
      KANNA_E2E_REAL_AGENT_PROVIDER: "codex",
      KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-mini",
    });
  });

  it("returns no override for mock suites", () => {
    expect(buildRealE2eAgentEnv(["tests/e2e/mock/app-launch.test.ts"], {})).toEqual({});
  });

  it("allows explicit process env to replace the default real-suite values", () => {
    expect(
      buildRealE2eAgentEnv(["tests/e2e/real/claude-session.test.ts"], {
        KANNA_E2E_REAL_AGENT_PROVIDER: "copilot",
        KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-nano",
      }),
    ).toEqual({
      KANNA_E2E_REAL_AGENT_PROVIDER: "copilot",
      KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-nano",
    });
  });
});
```

- [ ] **Step 2: Run the runner env tests to verify they fail**

Run: `pnpm --dir apps/desktop exec vitest run tests/e2e/runEnv.test.ts`
Expected: FAIL because `runEnv.ts` does not exist yet.

- [ ] **Step 3: Implement the runner env helper**

```ts
export function buildRealE2eAgentEnv(
  testTargets: string[],
  env: Record<string, string | undefined>,
): Record<string, string> {
  const hasRealSuite = testTargets.some((target) => target.includes("/real/"));
  if (!hasRealSuite) return {};

  return {
    KANNA_E2E_REAL_AGENT_PROVIDER: env.KANNA_E2E_REAL_AGENT_PROVIDER || "codex",
    KANNA_E2E_REAL_AGENT_MODEL: env.KANNA_E2E_REAL_AGENT_MODEL || "gpt-5.4-mini",
  };
}
```

- [ ] **Step 4: Wire the helper into `tests/e2e/run.ts`**

```ts
import { buildRealE2eAgentEnv } from "./runEnv";

const realE2eAgentEnv = buildRealE2eAgentEnv(testTargets, process.env);
```

Apply it to all launched app envs:

```ts
const env = toSpawnEnv({
  KANNA_DAEMON_DIR: input.daemonDir,
  KANNA_DB_NAME: input.dbName,
  KANNA_DEV_PORT: String(input.devPortEnvValue),
  KANNA_TMUX_SESSION: input.sessionName,
  KANNA_TRANSFER_PORT: String(input.transferPortEnvValue),
  KANNA_WEBDRIVER_PORT: String(input.webDriverPortEnvValue),
  ...realE2eAgentEnv,
  ...input.envOverrides,
});
```

And to the Vitest env:

```ts
const testEnv = toSpawnEnv({
  KANNA_DAEMON_DIR: primaryDaemonDir,
  KANNA_DB_NAME: primaryDbName,
  KANNA_DEV_PORT: String(primaryDevPort),
  KANNA_TRANSFER_REGISTRY_DIR: transferRegistryDir,
  KANNA_WEBDRIVER_PORT: String(primaryWebDriverPort),
  ...realE2eAgentEnv,
  ...(secondary ? { KANNA_E2E_TARGET_WEBDRIVER_PORT: String(secondary.webDriverPort) } : {}),
});
```

- [ ] **Step 5: Run the runner env tests to verify they pass**

Run: `pnpm --dir apps/desktop exec vitest run tests/e2e/runEnv.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the runner wiring**

```bash
git add apps/desktop/tests/e2e/run.ts apps/desktop/tests/e2e/runEnv.ts apps/desktop/tests/e2e/runEnv.test.ts
git commit -m "test: default real e2e runs to cheap codex model"
```

### Task 4: Verify the full change set

**Files:**
- Modify: none
- Test: `apps/desktop/src/stores/e2eRealAgentOverride.test.ts`, `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`, `apps/desktop/tests/e2e/runEnv.test.ts`

- [ ] **Step 1: Run the focused unit and store tests**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/e2eRealAgentOverride.test.ts src/stores/kanna.taskBaseBranch.test.ts tests/e2e/runEnv.test.ts`
Expected: PASS

- [ ] **Step 2: Run TypeScript verification**

Run: `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Run the mock desktop E2E suite**

Run: `pnpm --dir apps/desktop test:e2e`
Expected: PASS

- [ ] **Step 4: Run one real desktop E2E spec under the new default override**

Run: `pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/claude-session.test.ts`
Expected: PASS without requiring Claude authentication, with the created PTY task using `codex` and `gpt-5.4-mini`.

- [ ] **Step 5: Commit the verified change set**

```bash
git add apps/desktop/src/stores/e2eRealAgentOverride.ts apps/desktop/src/stores/e2eRealAgentOverride.test.ts apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts apps/desktop/tests/e2e/run.ts apps/desktop/tests/e2e/runEnv.ts apps/desktop/tests/e2e/runEnv.test.ts
git commit -m "feat: default real e2e tasks to codex gpt-5.4-mini"
```
