# Agent Provider Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent_provider` resolve to the first available provider in its configured order, remove silent Claude fallback, and surface missing/unavailable-provider errors through existing catch-and-toast flows.

**Architecture:** Add a small provider-resolution helper in the desktop store layer that normalizes candidate lists, checks CLI availability, and returns a concrete provider or throws. Use that helper in task creation, stage advance, and rerun, and add a defensive no-fallback guard in the spawn path so unresolved providers cannot silently become Claude.

**Tech Stack:** TypeScript, Vue/Pinia store logic, Tauri `invoke`, Vitest

---

### Task 1: Add a focused provider resolver with availability-aware semantics

**Files:**
- Create: `apps/desktop/src/stores/agent-provider.ts`
- Test: `apps/desktop/src/stores/agent-provider.test.ts`

- [ ] **Step 1: Write failing resolver tests for ordered provider selection and error cases**

Create `apps/desktop/src/stores/agent-provider.test.ts` with these tests:

```ts
import { describe, expect, it } from "vitest";
import { resolveAgentProvider } from "./agent-provider";

describe("resolveAgentProvider", () => {
  it("returns a single provider when it is available", () => {
    const result = resolveAgentProvider(["codex"], {
      codex: true,
      copilot: false,
      claude: false,
    });
    expect(result).toBe("codex");
  });

  it("returns the first available provider from an ordered list", () => {
    const result = resolveAgentProvider(["codex", "copilot"], {
      codex: false,
      copilot: true,
      claude: true,
    });
    expect(result).toBe("copilot");
  });

  it("throws when no providers are configured", () => {
    expect(() => resolveAgentProvider(undefined, {
      codex: true,
      copilot: true,
      claude: true,
    })).toThrow("No agent provider configured for this task or stage.");
  });

  it("throws when configured providers are unavailable", () => {
    expect(() => resolveAgentProvider(["codex", "copilot"], {
      codex: false,
      copilot: false,
      claude: true,
    })).toThrow("None of the configured agent providers are available: codex, copilot.");
  });
});
```

Expected: this test file fails because `resolveAgentProvider` does not exist yet.

- [ ] **Step 2: Run the test to confirm the missing helper failure**

Run:

```bash
bun test apps/desktop/src/stores/agent-provider.test.ts
```

Expected: FAIL with an import or missing-symbol error for `resolveAgentProvider`.

- [ ] **Step 3: Implement a small pure resolver helper**

Create `apps/desktop/src/stores/agent-provider.ts` with this shape:

```ts
import type { AgentProvider } from "@kanna/db";

export interface AgentProviderAvailability {
  claude: boolean;
  copilot: boolean;
  codex: boolean;
}

export function normalizeAgentProviderCandidates(
  providers: AgentProvider | AgentProvider[] | undefined,
): AgentProvider[] {
  if (!providers) return [];
  return Array.isArray(providers) ? providers : [providers];
}

export function resolveAgentProvider(
  providers: AgentProvider | AgentProvider[] | undefined,
  availability: AgentProviderAvailability,
): AgentProvider {
  const candidates = normalizeAgentProviderCandidates(providers);
  if (candidates.length === 0) {
    throw new Error("No agent provider configured for this task or stage.");
  }

  for (const provider of candidates) {
    if (availability[provider]) return provider;
  }

  throw new Error(`None of the configured agent providers are available: ${candidates.join(", ")}.`);
}
```

Expected: the helper stays pure and testable, with no Tauri or store coupling.

- [ ] **Step 4: Re-run the resolver unit tests**

Run:

```bash
bun test apps/desktop/src/stores/agent-provider.test.ts
```

Expected: PASS with all resolver tests green.

- [ ] **Step 5: Commit the new helper and unit tests**

Run:

```bash
git add apps/desktop/src/stores/agent-provider.ts apps/desktop/src/stores/agent-provider.test.ts
git commit -m "feat: add agent provider resolver"
```

Expected: a commit is created for the pure resolver helper and its tests.

### Task 2: Use the resolver in task creation and pipeline execution

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/agent-provider.ts`
- Test: `apps/desktop/src/stores/agent-provider.test.ts`

- [ ] **Step 1: Add failing tests for runtime-facing availability helpers if needed**

If Task 1’s test file only covers the pure resolver, extend `apps/desktop/src/stores/agent-provider.test.ts` with these tests for candidate selection helpers:

```ts
import { getPreferredAgentProviders } from "./agent-provider";

it("prefers stage provider over agent provider over item provider", () => {
  const result = getPreferredAgentProviders({
    stageProvider: "copilot",
    agentProviders: ["codex", "copilot"],
    itemProvider: "claude",
  });
  expect(result).toEqual(["copilot"]);
});

it("falls back from agent provider list to item provider only when no higher-precedence source exists", () => {
  const result = getPreferredAgentProviders({
    stageProvider: undefined,
    agentProviders: ["codex", "copilot"],
    itemProvider: "claude",
  });
  expect(result).toEqual(["codex", "copilot"]);
});
```

Expected: FAIL until the helper exists.

- [ ] **Step 2: Implement a small precedence helper**

In `apps/desktop/src/stores/agent-provider.ts`, add:

```ts
export function getPreferredAgentProviders(args: {
  stageProvider?: AgentProvider;
  agentProviders?: AgentProvider[];
  itemProvider?: AgentProvider;
}): AgentProvider[] | undefined {
  if (args.stageProvider) return [args.stageProvider];
  if (args.agentProviders?.length) return args.agentProviders;
  if (args.itemProvider) return [args.itemProvider];
  return undefined;
}
```

Expected: precedence becomes explicit and reusable instead of being inlined in multiple places.

- [ ] **Step 3: Add a store-local availability function in `kanna.ts`**

In `apps/desktop/src/stores/kanna.ts`, add a helper near the other local utilities:

```ts
  async function getAgentProviderAvailability(): Promise<{ claude: boolean; copilot: boolean; codex: boolean }> {
    async function hasCli(name: "claude" | "copilot" | "codex"): Promise<boolean> {
      try {
        await invoke<string>("which_binary", { name });
        return true;
      } catch {
        return false;
      }
    }

    const [claude, copilot, codex] = await Promise.all([
      hasCli("claude"),
      hasCli("copilot"),
      hasCli("codex"),
    ]);

    return { claude, copilot, codex };
  }
```

Expected: runtime provider resolution no longer depends on `MainPanel.vue` state.

- [ ] **Step 4: Replace task-creation fallback with explicit resolution**

In `createItem()` inside `apps/desktop/src/stores/kanna.ts`, replace:

```ts
    const effectiveAgentProvider = opts?.customTask?.agentProvider ?? opts?.agentProvider ?? "claude";
```

with logic equivalent to:

```ts
    const providerAvailability = await getAgentProviderAvailability();
    const effectiveAgentProvider = resolveAgentProvider(
      opts?.customTask?.agentProvider ?? opts?.agentProvider,
      providerAvailability,
    );
```

Wrap the surrounding create path so a thrown resolver error is caught and surfaced with:

```ts
toast.error(e instanceof Error ? e.message : String(e));
```

Expected: no implicit provider means no task is created silently with Claude.

- [ ] **Step 5: Replace stage-advance and rerun first-entry selection with ordered resolution**

In `apps/desktop/src/stores/kanna.ts`, replace both inlined expressions:

```ts
Array.isArray(agent.agent_provider) ? agent.agent_provider[0] : agent.agent_provider
```

with logic equivalent to:

```ts
const candidates = getPreferredAgentProviders({
  stageProvider: nextStage.agent_provider as AgentProvider | undefined,
  agentProviders: Array.isArray(agent.agent_provider) ? agent.agent_provider as AgentProvider[] : agent.agent_provider ? [agent.agent_provider as AgentProvider] : undefined,
  itemProvider: agentProvider,
});
const resolvedProvider = resolveAgentProvider(candidates, await getAgentProviderAvailability());
```

Use the same pattern for rerun with `currentStage`.

Expected: ordered provider lists now mean “first available”, not “index zero”.

- [ ] **Step 6: Run the resolver tests again**

Run:

```bash
bun test apps/desktop/src/stores/agent-provider.test.ts
```

Expected: PASS with precedence and resolver behavior covered.

- [ ] **Step 7: Commit the store integration**

Run:

```bash
git add apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/agent-provider.ts apps/desktop/src/stores/agent-provider.test.ts
git commit -m "feat: resolve agent providers by availability"
```

Expected: a commit is created for runtime integration of the provider resolver.

### Task 3: Remove spawn fallback and verify end-to-end provider behavior

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`
- Test: `apps/desktop/src/stores/agent-provider.test.ts`

- [ ] **Step 1: Add a failing guard test for missing spawn provider**

If `spawnPtySession` extraction is impractical, add a small helper in `agent-provider.ts` and test it first:

```ts
import { requireResolvedAgentProvider } from "./agent-provider";

it("throws when spawn is attempted without a resolved provider", () => {
  expect(() => requireResolvedAgentProvider(undefined)).toThrow(
    "No resolved agent provider was supplied for spawn.",
  );
});
```

Expected: FAIL until the guard helper exists.

- [ ] **Step 2: Implement the guard helper**

In `apps/desktop/src/stores/agent-provider.ts`, add:

```ts
export function requireResolvedAgentProvider(
  provider: AgentProvider | undefined,
): AgentProvider {
  if (!provider) {
    throw new Error("No resolved agent provider was supplied for spawn.");
  }
  return provider;
}
```

Expected: this provides a minimal hard-stop without refactoring the entire spawn function.

- [ ] **Step 3: Remove the spawn-path Claude fallback**

In `apps/desktop/src/stores/kanna.ts`, replace:

```ts
    const provider = options?.agentProvider ?? "claude";
```

with:

```ts
    const provider = requireResolvedAgentProvider(options?.agentProvider);
```

Keep the existing `if (provider === "copilot")`, `else if (provider === "codex")`, `else` branch structure unchanged after that.

Expected: missing provider now fails fast instead of silently selecting Claude.

- [ ] **Step 4: Run the focused desktop tests**

Run:

```bash
bun test apps/desktop/src/stores/agent-provider.test.ts
```

Expected: PASS with resolver, precedence, and spawn-guard coverage.

- [ ] **Step 5: Run the previously verified parser tests to catch regressions**

Run:

```bash
bun --cwd packages/core test src/config/custom-tasks.test.ts src/pipeline/agent-loader.test.ts
```

Expected: PASS with `34/34` tests still green.

- [ ] **Step 6: Commit the spawn guard and final verification-ready state**

Run:

```bash
git add apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/agent-provider.ts apps/desktop/src/stores/agent-provider.test.ts
git commit -m "fix: throw when no agent provider can be resolved"
```

Expected: a final commit is created after the no-fallback guard and verification pass.
