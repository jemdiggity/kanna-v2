# Agent Provider Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Claude from built-in `.kanna/agents` definitions and align built-in agent docs, parser logic, and tests so Codex and Copilot are the supported providers for those agent configuration paths.

**Architecture:** This is a configuration consistency change across three layers: built-in agent markdown definitions, parser/type validation in `packages/core`, and tests that encode provider expectations. The runtime spawn path already supports Codex, so the work should avoid behavioral changes and focus on keeping source-of-truth files, docs, and parsing rules in sync.

**Tech Stack:** Markdown frontmatter, TypeScript, Vitest, Kanna pipeline agent definitions

---

### Task 1: Update built-in agent definitions and built-in factory documentation

**Files:**
- Modify: `.kanna/agents/implement/AGENT.md`
- Modify: `.kanna/agents/pr/AGENT.md`
- Modify: `.kanna/agents/merge/AGENT.md`
- Modify: `.kanna/agents/agent-factory/AGENT.md`
- Modify: `.kanna/agents/pipeline-factory/AGENT.md`

- [ ] **Step 1: Inspect the current built-in agent frontmatter and built-in factory wording**

Run:

```bash
sed -n '1,120p' .kanna/agents/implement/AGENT.md
sed -n '1,160p' .kanna/agents/pr/AGENT.md
sed -n '1,200p' .kanna/agents/merge/AGENT.md
sed -n '1,220p' .kanna/agents/agent-factory/AGENT.md
sed -n '1,220p' .kanna/agents/pipeline-factory/AGENT.md
```

Expected: the files still show `agent_provider: claude, copilot`, and several files still include `model: sonnet` or Claude-specific provider examples.

- [ ] **Step 2: Edit built-in agents so they only advertise Codex and Copilot and omit `model` entirely**

Apply these exact frontmatter changes:

```md
---
name: implement
description: Default task agent — passes the user prompt through as-is
agent_provider: codex, copilot
permission_mode: default
---
```

```md
---
name: pr
description: Creates a GitHub pull request for a completed task branch
agent_provider: codex, copilot
permission_mode: default
---
```

```md
---
name: merge
description: Analyzes PR interactions for semantic conflicts, then safely merges in optimal order
agent_provider: codex, copilot
permission_mode: default
---
```

```md
---
name: agent-factory
description: Helps users create new agent definitions for Kanna
agent_provider: codex, copilot
permission_mode: default
---
```

```md
---
name: pipeline-factory
description: Helps users create new pipeline definitions for Kanna
agent_provider: codex, copilot
permission_mode: default
---
```

Expected: all five built-in agent files now list `codex, copilot` and none of them contain a `model:` line.

- [ ] **Step 3: Update built-in factory examples and field docs to stop teaching Claude**

In `.kanna/agents/agent-factory/AGENT.md`, make these wording changes:

```md
agent_provider: codex, copilot   # or just: codex
permission_mode: default         # optional: default | acceptEdits | dontAsk
allowed_tools: []                # optional: tool allowlist (provider-specific)
```

```md
| `agent_provider` | string or list | no | Compatible providers: `codex`, `copilot`, or both. Falls back to user default. |
| `model` | string | no | Optional model override. Falls back to provider default. |
```

In `.kanna/agents/pipeline-factory/AGENT.md`, make these wording changes:

```md
"agent_provider": "<optional override: codex | copilot>",
```

```md
| `agent_provider` | string | no | Override agent provider for this stage: `codex` or `copilot` |
```

Expected: the built-in factory docs still mention `model` as an optional field in general, but they no longer recommend Claude anywhere in their examples or provider descriptions.

- [ ] **Step 4: Verify the built-in agent files after editing**

Run:

```bash
rg -n '^agent_provider:|^model:' .kanna/agents/*/AGENT.md
```

Expected:
- every built-in agent file shows `agent_provider: codex, copilot`
- no result includes `model:`

- [ ] **Step 5: Commit the built-in agent definition and documentation cleanup**

Run:

```bash
git add .kanna/agents/implement/AGENT.md .kanna/agents/pr/AGENT.md .kanna/agents/merge/AGENT.md .kanna/agents/agent-factory/AGENT.md .kanna/agents/pipeline-factory/AGENT.md
git commit -m "chore: update built-in agents for codex and copilot"
```

Expected: a commit is created containing only the built-in `.kanna/agents` changes.

### Task 2: Widen custom task parsing and guidance to accept Codex

**Files:**
- Modify: `packages/core/src/config/custom-tasks.ts`
- Test: `packages/core/src/config/custom-tasks.test.ts`

- [ ] **Step 1: Add a failing parser test for `codex` frontmatter**

In `packages/core/src/config/custom-tasks.test.ts`, add this test inside the `describe("parseAgentMd", ...)` block:

```ts
  it("accepts codex as an agent provider", () => {
    const content = `---
agent_provider: codex
---
Use Codex for this task.
`;
    const result = parseAgentMd(content, "codex-task");
    expect(result).not.toBeNull();
    expect(result!.agentProvider).toBe("codex");
    expect(result!.prompt).toBe("Use Codex for this task.");
  });
```

Expected: this test fails before the parser change because `agentProvider` is currently limited to `"claude" | "copilot"`.

- [ ] **Step 2: Run the targeted test and confirm the failure is real**

Run:

```bash
bun --filter @kanna/core test packages/core/src/config/custom-tasks.test.ts
```

Expected: a failure showing that the new `codex` provider test does not pass yet.

- [ ] **Step 3: Update the parser type, allowlist, and generator prompt**

In `packages/core/src/config/custom-tasks.ts`, make these exact edits:

```ts
export interface CustomTaskConfig {
  name: string;
  description?: string;
  agentProvider?: "claude" | "copilot" | "codex";
  model?: string;
  permissionMode?: "dontAsk" | "acceptEdits" | "default";
  executionMode?: "pty" | "sdk";
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setup?: string[];
  teardown?: string[];
  stage?: Stage;
  prompt: string;
}
```

```ts
- agent_provider: "codex" | "copilot" | "claude" (default: codex)
```

```ts
const VALID_AGENT_PROVIDERS = ["claude", "copilot", "codex"] as const;
```

Keep the rest of the parser behavior unchanged.

Expected: `parseAgentMd()` preserves `codex` in parsed output instead of dropping it as invalid.

- [ ] **Step 4: Re-run the custom task parser test file**

Run:

```bash
bun --filter @kanna/core test packages/core/src/config/custom-tasks.test.ts
```

Expected: all tests in `custom-tasks.test.ts` pass, including the new `codex` provider case.

- [ ] **Step 5: Commit the parser update**

Run:

```bash
git add packages/core/src/config/custom-tasks.ts packages/core/src/config/custom-tasks.test.ts
git commit -m "feat: allow codex in custom task configs"
```

Expected: a commit is created for the `packages/core` custom task parser and test changes.

### Task 3: Align agent-loader tests with Codex/Copilot built-in definitions and run final verification

**Files:**
- Test: `packages/core/src/pipeline/agent-loader.test.ts`
- Verify: `.kanna/agents/implement/AGENT.md`
- Verify: `.kanna/agents/pr/AGENT.md`
- Verify: `.kanna/agents/merge/AGENT.md`
- Verify: `.kanna/agents/agent-factory/AGENT.md`
- Verify: `.kanna/agents/pipeline-factory/AGENT.md`

- [ ] **Step 1: Update agent-loader tests to include Codex-compatible provider examples**

In `packages/core/src/pipeline/agent-loader.test.ts`, change the provider examples to avoid Claude-specific assumptions:

```ts
  it("parses valid AGENT.md with all fields", () => {
    const content = `---
name: My Agent
description: Does something useful
agent_provider: codex
model: gpt-5
permission_mode: dontAsk
allowed_tools:
  - Bash
  - Read
---

You are a helpful agent. Do the task.
`;
    const result = parseAgentDefinition(content);
    expect(result.name).toBe("My Agent");
    expect(result.description).toBe("Does something useful");
    expect(result.agent_provider).toEqual(["codex"]);
    expect(result.model).toBe("gpt-5");
    expect(result.permission_mode).toBe("dontAsk");
    expect(result.allowed_tools).toEqual(["Bash", "Read"]);
    expect(result.prompt).toBe("You are a helpful agent. Do the task.");
  });
```

```ts
  it("parses agent_provider as a single string into array", () => {
    const content = `---
name: Single Provider
description: Has one provider
agent_provider: codex
---

Do something.
`;
    const result = parseAgentDefinition(content);
    expect(result.agent_provider).toEqual(["codex"]);
  });
```

```ts
  it("parses agent_provider as a comma-separated list into array", () => {
    const content = `---
name: Multi Provider
description: Has multiple providers
agent_provider: "codex, copilot"
---

Do something.
`;
    const result = parseAgentDefinition(content);
    expect(result.agent_provider).toEqual(["codex", "copilot"]);
  });
```

```ts
  it("parses agent_provider as a YAML array into array", () => {
    const content = `---
name: Array Provider
description: Has array providers
agent_provider:
  - codex
  - copilot
---

Do something.
`;
    const result = parseAgentDefinition(content);
    expect(result.agent_provider).toEqual(["codex", "copilot"]);
  });
```

Expected: the tests still verify parser behavior, but now reflect the supported provider pair used by built-in agents.

- [ ] **Step 2: Run the targeted pipeline parser test file**

Run:

```bash
bun --filter @kanna/core test packages/core/src/pipeline/agent-loader.test.ts
```

Expected: all tests in `agent-loader.test.ts` pass.

- [ ] **Step 3: Run the combined targeted verification suite**

Run:

```bash
bun --filter @kanna/core test packages/core/src/config/custom-tasks.test.ts packages/core/src/pipeline/agent-loader.test.ts
```

Expected: both test files pass in one run with no provider-related failures.

- [ ] **Step 4: Perform a final source inspection for the built-in agents**

Run:

```bash
sed -n '1,40p' .kanna/agents/implement/AGENT.md
sed -n '1,40p' .kanna/agents/pr/AGENT.md
sed -n '1,40p' .kanna/agents/merge/AGENT.md
sed -n '1,60p' .kanna/agents/agent-factory/AGENT.md
sed -n '1,60p' .kanna/agents/pipeline-factory/AGENT.md
```

Expected:
- each file uses `agent_provider: codex, copilot`
- none of the files contain a `model:` line
- the built-in factory docs no longer recommend Claude provider values

- [ ] **Step 5: Commit the remaining parser test alignment and verification-ready state**

Run:

```bash
git add packages/core/src/pipeline/agent-loader.test.ts
git commit -m "test: align agent loader fixtures with codex providers"
```

Expected: a final commit is created after the tests pass and the tree is in a verified state for this feature.
