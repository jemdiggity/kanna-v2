# Custom Agent Tasks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users define reusable agent task templates as `.kanna/tasks/<name>/agent.md` files with YAML frontmatter config, discoverable and launchable from the command palette.

**Architecture:** New `packages/core/src/config/custom-tasks.ts` module handles parsing and scanning. New `useCustomTasks` composable manages async discovery with cancellation. `CommandPaletteModal` gains a `dynamicCommands` prop for custom task entries. `usePipeline.createItem` and `spawnPtySession` accept optional `CustomTaskConfig` to overlay settings.

**Tech Stack:** TypeScript, Vue 3, Tauri v2, vitest, `yaml` npm package for frontmatter parsing

**Spec:** `docs/superpowers/specs/2026-03-22-custom-agent-tasks-design.md`

---

## File Structure

### New files
- `packages/core/src/config/custom-tasks.ts` — types, frontmatter parser, directory scanner, meta-prompt constant
- `packages/core/src/config/custom-tasks.test.ts` — unit tests for parsing and scanning
- `apps/desktop/src/composables/useCustomTasks.ts` — Vue composable: async scan trigger, cancellation, caching

### Modified files
- `packages/core/package.json` — add `yaml` dependency
- `packages/core/src/index.ts` — export custom-tasks module
- `packages/db/src/queries.ts` — `insertPipelineItem` accepts optional `display_name`
- `apps/desktop/src/composables/usePipeline.ts` — `createItem` and `spawnPtySession` accept `CustomTaskConfig`
- `apps/desktop/src/components/CommandPaletteModal.vue` — `dynamicCommands` prop, description subtitle
- `apps/desktop/src/App.vue` — wire up `useCustomTasks`, pass dynamic commands to palette, handle custom task actions

---

### Task 1: Core types and frontmatter parser

**Files:**
- Create: `packages/core/src/config/custom-tasks.ts`
- Create: `packages/core/src/config/custom-tasks.test.ts`
- Modify: `packages/core/package.json` (add `yaml` dep)
- Modify: `packages/core/src/index.ts` (add export)

- [ ] **Step 1: Install yaml package**

```bash
cd packages/core && bun add yaml
```

- [ ] **Step 2: Write failing tests for `parseAgentMd`**

Create `packages/core/src/config/custom-tasks.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseAgentMd } from "./custom-tasks.js";

describe("parseAgentMd", () => {
  it("parses a full agent.md with all fields", () => {
    const content = `---
name: Ship
description: Ship the current work
model: sonnet
permission_mode: dontAsk
execution_mode: pty
allowed_tools: ["Bash", "Read"]
disallowed_tools: ["Write"]
max_turns: 10
max_budget_usd: 0.50
setup: ["bun install"]
teardown: ["bun clean"]
stage: in_progress
---

You are a shipping agent.
`;
    const result = parseAgentMd(content, "ship");
    expect(result).toEqual({
      name: "Ship",
      description: "Ship the current work",
      model: "sonnet",
      permissionMode: "dontAsk",
      executionMode: "pty",
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["Write"],
      maxTurns: 10,
      maxBudgetUsd: 0.50,
      setup: ["bun install"],
      teardown: ["bun clean"],
      stage: "in_progress",
      prompt: "You are a shipping agent.",
    });
  });

  it("derives name from directory slug when missing", () => {
    const content = `---
description: Does things
---

Do the thing.
`;
    const result = parseAgentMd(content, "code-review");
    expect(result.name).toBe("Code Review");
  });

  it("returns null for empty body", () => {
    const content = `---
name: Empty
---
`;
    expect(parseAgentMd(content, "empty")).toBeNull();
  });

  it("returns null for whitespace-only body", () => {
    const content = `---
name: Empty
---


`;
    expect(parseAgentMd(content, "empty")).toBeNull();
  });

  it("handles missing frontmatter entirely", () => {
    const content = "Just a prompt with no frontmatter.";
    const result = parseAgentMd(content, "simple");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Simple");
    expect(result!.prompt).toBe("Just a prompt with no frontmatter.");
  });

  it("ignores unknown frontmatter fields", () => {
    const content = `---
name: Test
unknown_field: hello
another: 123
---

Do stuff.
`;
    const result = parseAgentMd(content, "test");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Test");
    expect((result as any).unknown_field).toBeUndefined();
    expect((result as any).another).toBeUndefined();
  });

  it("falls back on type mismatches", () => {
    const content = `---
name: Test
max_turns: "not a number"
setup: "not an array"
permission_mode: "invalid_mode"
stage: "invalid_stage"
---

Do stuff.
`;
    const result = parseAgentMd(content, "test");
    expect(result).not.toBeNull();
    expect(result!.maxTurns).toBeUndefined();
    expect(result!.setup).toBeUndefined();
    expect(result!.permissionMode).toBeUndefined();
    expect(result!.stage).toBeUndefined();
  });

  it("handles empty frontmatter", () => {
    const content = `---
---

The prompt.
`;
    const result = parseAgentMd(content, "my-task");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Task");
    expect(result!.prompt).toBe("The prompt.");
  });

  it("returns null for malformed YAML", () => {
    const content = `---
name: [invalid yaml
  broken: {
---

Prompt text.
`;
    expect(parseAgentMd(content, "bad")).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/core && bun test src/config/custom-tasks.test.ts
```

Expected: FAIL — `parseAgentMd` not found.

- [ ] **Step 4: Implement `parseAgentMd` and types**

Create `packages/core/src/config/custom-tasks.ts`:

```typescript
import { parse as parseYaml } from "yaml";

// --- Types ---

export interface CustomTaskConfig {
  name: string;
  description?: string;
  model?: string;
  permissionMode?: "dontAsk" | "acceptEdits" | "default";
  executionMode?: "pty" | "sdk";
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setup?: string[];
  teardown?: string[];
  stage?: "in_progress" | "pr" | "merge" | "done";
  prompt: string;
}

export interface CustomTaskScanResult {
  tasks: CustomTaskConfig[];
  errors: Array<{ path: string; error: string }>;
}

// --- Constants ---

const VALID_PERMISSION_MODES = ["dontAsk", "acceptEdits", "default"] as const;
const VALID_STAGES = ["in_progress", "pr", "merge", "done"] as const;

export const NEW_CUSTOM_TASK_PROMPT = `You are helping the user define a custom agent task for Kanna.

Custom tasks are reusable agent configurations stored at .kanna/tasks/<taskname>/agent.md.
The file uses YAML frontmatter for configuration and markdown body for the agent prompt.

Guide the user through defining their custom task by asking about:
1. What the task should do (name, description, purpose)
2. What instructions the agent should follow (the prompt)
3. Configuration options they want to set

Available frontmatter fields (all optional, defaults shown):
- name: Display name (default: derived from directory name)
- description: Short description for the command palette
- model: null (uses Kanna default)
- permission_mode: "dontAsk" | "acceptEdits" | "default" (default: dontAsk)
- execution_mode: "pty" | "sdk" (default: pty)
- allowed_tools: [] (empty = all allowed)
- disallowed_tools: []
- max_turns: null (unlimited)
- max_budget_usd: null (unlimited)
- setup: [] (commands run before the agent)
- teardown: [] (commands run after task closes)
- stage: "in_progress" (default)

Once you understand what they want, create the directory and write the agent.md file
at .kanna/tasks/<taskname>/agent.md. Use a lowercase hyphenated directory name.`;

// --- Parsing ---

/** Convert a slug like "code-review" to a display name like "Code Review" */
function slugToName(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((v) => typeof v === "string");
}

/**
 * Parse an agent.md file content into a CustomTaskConfig.
 * Returns null if the file is unparseable or has no prompt body.
 */
export function parseAgentMd(content: string, dirName: string): CustomTaskConfig | null {
  // Split frontmatter from body
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  let frontmatter: Record<string, unknown> = {};
  let body: string;

  if (fmMatch) {
    try {
      const parsed = parseYaml(fmMatch[1]);
      if (parsed && typeof parsed === "object") {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      return null; // Malformed YAML
    }
    body = fmMatch[2];
  } else {
    // No frontmatter — entire content is the prompt
    body = content;
  }

  // Trim and validate body
  const prompt = body.trim();
  if (!prompt) return null;

  // Build config with validation
  const config: CustomTaskConfig = {
    name: typeof frontmatter.name === "string" ? frontmatter.name : slugToName(dirName),
    prompt,
  };

  if (typeof frontmatter.description === "string") config.description = frontmatter.description;
  if (typeof frontmatter.model === "string") config.model = frontmatter.model;

  if (typeof frontmatter.permission_mode === "string" &&
      VALID_PERMISSION_MODES.includes(frontmatter.permission_mode as any)) {
    config.permissionMode = frontmatter.permission_mode as CustomTaskConfig["permissionMode"];
  }

  if (typeof frontmatter.execution_mode === "string" &&
      (frontmatter.execution_mode === "pty" || frontmatter.execution_mode === "sdk")) {
    config.executionMode = frontmatter.execution_mode as CustomTaskConfig["executionMode"];
  }

  if (isStringArray(frontmatter.allowed_tools)) config.allowedTools = frontmatter.allowed_tools;
  if (isStringArray(frontmatter.disallowed_tools)) config.disallowedTools = frontmatter.disallowed_tools;

  if (typeof frontmatter.max_turns === "number" && Number.isFinite(frontmatter.max_turns)) {
    config.maxTurns = frontmatter.max_turns;
  }
  if (typeof frontmatter.max_budget_usd === "number" && Number.isFinite(frontmatter.max_budget_usd)) {
    config.maxBudgetUsd = frontmatter.max_budget_usd;
  }

  if (isStringArray(frontmatter.setup)) config.setup = frontmatter.setup;
  if (isStringArray(frontmatter.teardown)) config.teardown = frontmatter.teardown;

  if (typeof frontmatter.stage === "string" &&
      VALID_STAGES.includes(frontmatter.stage as any)) {
    config.stage = frontmatter.stage as CustomTaskConfig["stage"];
  }

  return config;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/core && bun test src/config/custom-tasks.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Export from index.ts**

Add to `packages/core/src/index.ts`:

```typescript
// Custom Tasks
export * from "./config/custom-tasks.js";
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/
git commit -m "feat: add custom task types and frontmatter parser"
```

---

### Task 2: Directory scanner

**Files:**
- Modify: `packages/core/src/config/custom-tasks.ts` (add `scanCustomTasks`)
- Modify: `packages/core/src/config/custom-tasks.test.ts` (add scanner tests)

- [ ] **Step 1: Write failing tests for `scanCustomTasks`**

Add to `packages/core/src/config/custom-tasks.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseAgentMd, scanCustomTasks } from "./custom-tasks.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ... existing parseAgentMd tests ...

describe("scanCustomTasks", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `kanna-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("scans a directory with valid custom tasks", async () => {
    const tasksDir = join(testDir, ".kanna", "tasks", "ship");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "agent.md"), `---
name: Ship
---

Ship the code.
`);
    const result = await scanCustomTasks(testDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("Ship");
    expect(result.tasks[0].prompt).toBe("Ship the code.");
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty list when .kanna/tasks/ does not exist", async () => {
    const result = await scanCustomTasks(testDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty list when .kanna/tasks/ is empty", async () => {
    mkdirSync(join(testDir, ".kanna", "tasks"), { recursive: true });
    const result = await scanCustomTasks(testDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips directories without agent.md", async () => {
    const emptyTask = join(testDir, ".kanna", "tasks", "empty");
    mkdirSync(emptyTask, { recursive: true });
    writeFileSync(join(emptyTask, "README.md"), "Not an agent");
    const result = await scanCustomTasks(testDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("reports errors for malformed agent.md", async () => {
    const badTask = join(testDir, ".kanna", "tasks", "bad");
    mkdirSync(badTask, { recursive: true });
    writeFileSync(join(badTask, "agent.md"), `---
name: [broken yaml
---

Some prompt.
`);
    const result = await scanCustomTasks(testDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toContain("bad");
  });

  it("handles mix of valid and invalid tasks", async () => {
    const goodDir = join(testDir, ".kanna", "tasks", "good");
    const badDir = join(testDir, ".kanna", "tasks", "bad");
    mkdirSync(goodDir, { recursive: true });
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(goodDir, "agent.md"), `---
name: Good
---

Good prompt.
`);
    writeFileSync(join(badDir, "agent.md"), `---
name: [broken
---

Bad prompt.
`);
    const result = await scanCustomTasks(testDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("Good");
    expect(result.errors).toHaveLength(1);
  });

  it("supports cancellation via AbortSignal", async () => {
    const taskDir = join(testDir, ".kanna", "tasks", "ship");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "agent.md"), `---
name: Ship
---

Ship it.
`);
    const controller = new AbortController();
    controller.abort();
    const result = await scanCustomTasks(testDir, controller.signal);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/core && bun test src/config/custom-tasks.test.ts
```

Expected: FAIL — `scanCustomTasks` not exported.

- [ ] **Step 3: Implement `scanCustomTasks`**

Add to `packages/core/src/config/custom-tasks.ts`:

```typescript
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";

/**
 * Scan .kanna/tasks/ for custom task definitions.
 * Returns parsed tasks and any errors encountered.
 * Respects AbortSignal for cancellation.
 */
export async function scanCustomTasks(
  repoPath: string,
  signal?: AbortSignal,
): Promise<CustomTaskScanResult> {
  const result: CustomTaskScanResult = { tasks: [], errors: [] };
  const tasksDir = join(repoPath, ".kanna", "tasks");

  if (signal?.aborted) return result;

  // Check if .kanna/tasks/ exists
  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    return result; // Directory doesn't exist — not an error
  }

  for (const entry of entries) {
    if (signal?.aborted) return { tasks: [], errors: [] };

    const entryPath = join(tasksDir, entry);

    // Only process directories
    try {
      const entryStat = await stat(entryPath);
      if (!entryStat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Read agent.md
    const agentMdPath = join(entryPath, "agent.md");
    let content: string;
    try {
      content = await readFile(agentMdPath, "utf-8");
    } catch {
      continue; // No agent.md — skip silently
    }

    // Parse
    const config = parseAgentMd(content, entry);
    if (config) {
      result.tasks.push(config);
    } else {
      result.errors.push({ path: agentMdPath, error: "Failed to parse agent.md (malformed YAML or empty prompt)" });
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/core && bun test src/config/custom-tasks.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat: add custom task directory scanner with cancellation"
```

---

### Task 3: Update `insertPipelineItem` to accept `display_name`

**Files:**
- Modify: `packages/db/src/queries.ts:63-87`

- [ ] **Step 1: Modify `insertPipelineItem` to accept optional `display_name`**

In `packages/db/src/queries.ts`, update the `insertPipelineItem` function signature and SQL to include `display_name`:

Change the type parameter from:
```typescript
item: Omit<PipelineItem, "created_at" | "updated_at" | "activity_changed_at" | "pinned" | "pin_order" | "display_name"> & { activity?: PipelineItem["activity"] }
```

To:
```typescript
item: Omit<PipelineItem, "created_at" | "updated_at" | "activity_changed_at" | "pinned" | "pin_order" | "display_name"> & { activity?: PipelineItem["activity"]; display_name?: string | null }
```

Note: `display_name` stays in the `Omit` list so the intersection's optional `display_name?` takes effect (otherwise TypeScript merges it as required).

Update the INSERT SQL to include `display_name`. The current INSERT uses `?` positional markers. Add `display_name` to the column list and add one more `?` to the VALUES. Bind `item.display_name ?? null` at the end of the parameter array.

- [ ] **Step 2: Verify existing tests still pass**

```bash
cd packages/db && bun test
```

Expected: PASS (existing tests don't set display_name, which defaults to null).

- [ ] **Step 3: Commit**

```bash
git add packages/db/
git commit -m "feat: insertPipelineItem accepts optional display_name"
```

---

### Task 3.5: Add `disallowed_tools` and `max_budget_usd` to `create_agent_session` Rust command

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/agent.rs:23-107`

- [ ] **Step 1: Add parameters to `create_agent_session`**

In `apps/desktop/src-tauri/src/commands/agent.rs`, add two new parameters to `create_agent_session`:

```rust
pub async fn create_agent_session(
    state: State<'_, AgentState>,
    session_id: String,
    cwd: String,
    prompt: String,
    system_prompt: Option<String>,
    model: Option<String>,
    allowed_tools: Option<Vec<String>>,
    disallowed_tools: Option<Vec<String>>,   // NEW
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,              // NEW
    permission_mode: Option<String>,
) -> Result<(), String>
```

Wire them into the `SessionOptions` builder:

```rust
if let Some(tools) = disallowed_tools {
    builder = builder.disallowed_tools(tools);
}
if let Some(budget) = max_budget_usd {
    builder = builder.max_budget_usd(budget);
}
```

- [ ] **Step 2: Verify Rust builds**

```bash
cd apps/desktop/src-tauri && cargo check
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/agent.rs
git commit -m "feat: create_agent_session accepts disallowed_tools and max_budget_usd"
```

---

### Task 4: Modify `spawnPtySession` to accept custom task config

**Files:**
- Modify: `apps/desktop/src/composables/usePipeline.ts:138-217`

- [ ] **Step 1: Update `spawnPtySession` signature and CLI construction**

In `apps/desktop/src/composables/usePipeline.ts`, modify `spawnPtySession` to accept an optional config object for custom task settings:

```typescript
interface PtySpawnOptions {
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setupCmdsOverride?: string[];
}

async function spawnPtySession(
  sessionId: string,
  cwd: string,
  prompt: string,
  cols = 80,
  rows = 24,
  options?: PtySpawnOptions,
) {
```

Update the CLI command construction (around line 203-206):

Replace:
```typescript
const modelFlag = model ? ` --model ${model}` : "";
const claudeCmd = `claude --dangerously-skip-permissions${modelFlag} --settings '${hookSettings}' '${prompt.replace(/'/g, "'\\''")}'`;
const fullCmd = [...setupCmds, claudeCmd].join(" && ");
```

With:
```typescript
const flags: string[] = [];

// Permission mode (default: dontAsk)
const permMode = options?.permissionMode ?? "dontAsk";
flags.push(`--permission-mode ${permMode}`);

if (options?.model) flags.push(`--model ${options.model}`);
if (options?.maxTurns) flags.push(`--max-turns ${options.maxTurns}`);
if (options?.maxBudgetUsd) flags.push(`--max-budget-usd ${options.maxBudgetUsd}`);
if (options?.allowedTools?.length) {
  flags.push(`--allowedTools ${options.allowedTools.join(",")}`);
}
if (options?.disallowedTools?.length) {
  flags.push(`--disallowedTools ${options.disallowedTools.join(",")}`);
}

const escapedPrompt = prompt.replace(/'/g, "'\\''");
const claudeCmd = `claude ${flags.join(" ")} --settings '${hookSettings}' '${escapedPrompt}'`;

// Merge setup commands: repo config first, then custom task overrides
const allSetupCmds = [...setupCmds, ...(options?.setupCmdsOverride || [])];
const fullCmd = [...allSetupCmds, claudeCmd].join(" && ");
```

- [ ] **Step 2: Update existing `spawnPtySession` call sites**

The existing call in `createItem` (line 126) passes `(id, worktreePath, prompt)` — no changes needed since `options` is optional.

The existing call in `TerminalView.vue` (if any) also passes just the basic params — verify it still works.

- [ ] **Step 3: Verify the app builds**

```bash
cd apps/desktop && bun run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/composables/usePipeline.ts
git commit -m "feat: spawnPtySession accepts custom task config options"
```

---

### Task 5: Modify `createItem` to accept `CustomTaskConfig`

**Files:**
- Modify: `apps/desktop/src/composables/usePipeline.ts:34-134`

- [ ] **Step 1: Update `createItem` signature and implementation**

Add `CustomTaskConfig` import and update `createItem`:

```typescript
import { canTransition, parseRepoConfig, type RepoConfig, type Stage, type CustomTaskConfig } from "@kanna/core";
```

Update signature:

```typescript
async function createItem(
  repoId: string,
  repoPath: string,
  prompt: string,
  agentType: AgentType = "pty",
  opts?: { baseBranch?: string; stage?: Stage; customTask?: CustomTaskConfig },
)
```

In the DB insert section (around line 88-108), apply custom task overrides:

```typescript
const effectivePrompt = opts?.customTask?.prompt ?? prompt;
const effectiveAgentType: AgentType = opts?.customTask?.executionMode ?? agentType;
const effectiveStage = opts?.customTask?.stage ?? opts?.stage ?? "in_progress";
const displayName = opts?.customTask?.name ?? null;

await insertPipelineItem(db.value, {
  id,
  repo_id: repoId,
  issue_number: null,
  issue_title: null,
  prompt: effectivePrompt,
  stage: effectiveStage,
  pr_number: null,
  pr_url: null,
  branch,
  agent_type: effectiveAgentType,
  port_offset: portOffset,
  port_env: Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null,
  activity: "working",
  display_name: displayName,
});
```

In the agent spawn section (around line 110-130), pass custom task config:

```typescript
if (effectiveAgentType !== "pty") {
  await invoke("create_agent_session", {
    sessionId: id,
    cwd: worktreePath,
    prompt: effectivePrompt,
    systemPrompt: null,
    permissionMode: opts?.customTask?.permissionMode ?? "dontAsk",
    model: opts?.customTask?.model ?? null,
    allowedTools: opts?.customTask?.allowedTools ?? null,
    disallowedTools: opts?.customTask?.disallowedTools ?? null,
    maxTurns: opts?.customTask?.maxTurns ?? null,
    maxBudgetUsd: opts?.customTask?.maxBudgetUsd ?? null,
  });
} else {
  try {
    await spawnPtySession(id, worktreePath, effectivePrompt, 80, 24, {
      model: opts?.customTask?.model,
      permissionMode: opts?.customTask?.permissionMode,
      allowedTools: opts?.customTask?.allowedTools,
      disallowedTools: opts?.customTask?.disallowedTools,
      maxTurns: opts?.customTask?.maxTurns,
      maxBudgetUsd: opts?.customTask?.maxBudgetUsd,
      setupCmdsOverride: opts?.customTask?.setup,
    });
  } catch (e) {
    console.warn("[pipeline] PTY pre-spawn failed, will retry on mount:", e);
  }
}
```

- [ ] **Step 2: Verify the app builds**

```bash
cd apps/desktop && bun run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/usePipeline.ts
git commit -m "feat: createItem accepts CustomTaskConfig for custom agent tasks"
```

---

### Task 6: Command palette dynamic commands

**Files:**
- Modify: `apps/desktop/src/components/CommandPaletteModal.vue`

- [ ] **Step 1: Add `dynamicCommands` prop and merge with static commands**

Update the script section to accept dynamic commands:

```typescript
interface DynamicCommand {
  label: string;
  description?: string;
  action: () => void;
}

const props = withDefaults(defineProps<{
  dynamicCommands?: DynamicCommand[];
}>(), {
  dynamicCommands: () => [],
});
```

Add a unified command type and merged list:

```typescript
interface UnifiedCommand {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  execute: () => void;
}

const allCommands = computed<UnifiedCommand[]>(() => {
  const staticCmds: UnifiedCommand[] = shortcuts
    .filter((s) => s.action !== "dismiss" && s.action !== "commandPalette")
    .map((s) => ({
      id: `static:${s.action}`,
      label: s.label,
      shortcut: s.display,
      execute: () => { emit("close"); emit("execute", s.action); },
    }));

  const dynamicCmds: UnifiedCommand[] = props.dynamicCommands.map((d, i) => ({
    id: `dynamic:${i}:${d.label}`,
    label: d.label,
    description: d.description,
    execute: () => { emit("close"); d.action(); },
  }));

  return [...dynamicCmds, ...staticCmds];
});
```

Update `filtered` to search against `allCommands`:

```typescript
const filtered = computed(() => {
  const q = query.value.toLowerCase();
  if (!q) return allCommands.value;
  return allCommands.value.filter(
    (c) => c.label.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q))
  );
});
```

Update `handleKeydown` Enter handler:

```typescript
} else if (e.key === "Enter") {
  e.preventDefault();
  const cmd = filtered.value[selectedIndex.value];
  if (cmd) cmd.execute();
}
```

- [ ] **Step 2: Update template to use unified commands and show descriptions**

Replace the command list template:

```html
<div
  v-for="(cmd, i) in filtered"
  :key="cmd.id"
  class="command-item"
  :class="{ selected: i === selectedIndex }"
  @click="cmd.execute()"
  @mouseenter="mouseMoved && (selectedIndex = i)"
>
  <div class="command-label-group">
    <span class="command-label">{{ cmd.label }}</span>
    <span v-if="cmd.description" class="command-description">{{ cmd.description }}</span>
  </div>
  <span v-if="cmd.shortcut" class="command-meta">
    <span class="command-keys">
      <kbd v-for="key in splitKeys(cmd.shortcut)" :key="key" class="command-key">{{ key }}</kbd>
    </span>
  </span>
</div>
```

Remove the old click handler (`@click="emit('close'); emit('execute', cmd.action)"`) since `execute()` now handles close + action.

- [ ] **Step 3: Add description styles**

```css
.command-label-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.command-description {
  font-size: 11px;
  color: #888;
}
.command-item.selected .command-description {
  color: rgba(255, 255, 255, 0.7);
}
```

- [ ] **Step 4: Verify the app builds**

```bash
cd apps/desktop && bun run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/CommandPaletteModal.vue
git commit -m "feat: command palette supports dynamic commands with descriptions"
```

---

### Task 7: `useCustomTasks` composable

**Files:**
- Create: `apps/desktop/src/composables/useCustomTasks.ts`

- [ ] **Step 1: Create the composable**

Create `apps/desktop/src/composables/useCustomTasks.ts`:

```typescript
import { ref, type Ref } from "vue";
import { invoke } from "../invoke";
import { parseAgentMd, type CustomTaskConfig, type CustomTaskScanResult } from "@kanna/core";

export function useCustomTasks() {
  const tasks = ref<CustomTaskConfig[]>([]);
  const scanning = ref(false);
  let currentController: AbortController | null = null;

  /**
   * Scan .kanna/tasks/ for the given repo path.
   * Cancels any in-flight scan before starting.
   * Uses Tauri invoke for filesystem access (works in both Tauri and browser mock).
   */
  async function scan(repoPath: string) {
    // Cancel previous scan
    if (currentController) {
      currentController.abort();
      currentController = null;
    }

    const controller = new AbortController();
    currentController = controller;
    scanning.value = true;

    try {
      const tasksDir = `${repoPath}/.kanna/tasks`;

      // List subdirectories via Tauri
      let entries: string[];
      try {
        entries = await invoke<string[]>("list_dir", { path: tasksDir });
      } catch {
        // Directory doesn't exist — not an error
        tasks.value = [];
        return;
      }

      if (controller.signal.aborted) return;

      const found: CustomTaskConfig[] = [];

      for (const entry of entries) {
        if (controller.signal.aborted) return;

        const agentMdPath = `${tasksDir}/${entry}/agent.md`;
        let content: string;
        try {
          content = await invoke<string>("read_text_file", { path: agentMdPath });
        } catch {
          continue; // No agent.md or not a directory — skip
        }

        if (controller.signal.aborted) return;

        const config = parseAgentMd(content, entry);
        if (config) found.push(config);
        else console.warn(`[useCustomTasks] Skipped malformed ${agentMdPath}`);
      }

      // Only update if this scan wasn't cancelled
      if (!controller.signal.aborted) {
        tasks.value = found;
      }
    } finally {
      if (currentController === controller) {
        scanning.value = false;
        currentController = null;
      }
    }
  }

  function cancel() {
    if (currentController) {
      currentController.abort();
      currentController = null;
      scanning.value = false;
    }
  }

  return { tasks, scanning, scan, cancel };
}
```

- [ ] **Step 2: Verify the app builds**

```bash
cd apps/desktop && bun run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/useCustomTasks.ts
git commit -m "feat: add useCustomTasks composable with async scanning and cancellation"
```

---

### Task 8: Wire everything together in App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Import and initialize `useCustomTasks`**

Add imports:

```typescript
import { useCustomTasks } from "./composables/useCustomTasks";
import { NEW_CUSTOM_TASK_PROMPT, type CustomTaskConfig } from "@kanna/core";
```

Initialize the composable (near other composable initializations):

```typescript
const { tasks: customTasks, scan: scanCustomTasks, cancel: cancelCustomTasksScan } = useCustomTasks();
```

- [ ] **Step 2: Build dynamic commands for the command palette**

Add a computed property that builds `DynamicCommand[]` from scanned custom tasks:

```typescript
const customTaskCommands = computed(() => {
  const commands: Array<{ label: string; description?: string; action: () => void }> = [];

  // "New Custom Task" is always present
  commands.push({
    label: "New Custom Task",
    description: "Define a new custom agent task",
    action: () => handleCreateCustomTask(),
  });

  // One entry per discovered custom task
  for (const task of customTasks.value) {
    commands.push({
      label: `Custom Task ${task.name}`,
      description: task.description,
      action: () => handleLaunchCustomTask(task),
    });
  }

  return commands;
});
```

- [ ] **Step 3: Add handler functions**

```typescript
async function handleLaunchCustomTask(task: CustomTaskConfig) {
  if (!selectedRepoId.value) return;
  const repo = repos.value.find((r) => r.id === selectedRepoId.value);
  if (!repo) return;
  try {
    await createItem(selectedRepoId.value, repo.path, task.prompt, task.executionMode ?? "pty", {
      customTask: task,
    });
    await refreshItems();
  } catch (e: any) {
    console.error("Custom task creation failed:", e);
    alert(`Custom task creation failed: ${e?.message || e}`);
  }
}

async function handleCreateCustomTask() {
  if (!selectedRepoId.value) return;
  const repo = repos.value.find((r) => r.id === selectedRepoId.value);
  if (!repo) return;
  try {
    await createItem(selectedRepoId.value, repo.path, NEW_CUSTOM_TASK_PROMPT);
    await refreshItems();
  } catch (e: any) {
    console.error("New custom task creation failed:", e);
    alert(`Failed to start custom task creation: ${e?.message || e}`);
  }
}
```

- [ ] **Step 4: Trigger scan on command palette open**

Update the `commandPalette` action in `keyboardActions` to trigger a scan:

```typescript
commandPalette: () => {
  showCommandPalette.value = !showCommandPalette.value;
  if (showCommandPalette.value) {
    // Trigger async scan of custom tasks for the active repo
    const repo = repos.value.find((r) => r.id === selectedRepoId.value);
    if (repo) scanCustomTasks(repo.path);
  }
},
```

- [ ] **Step 5: Pass dynamic commands to `CommandPaletteModal`**

Update the template:

```html
<CommandPaletteModal
  v-if="showCommandPalette"
  :dynamic-commands="customTaskCommands"
  @close="showCommandPalette = false"
  @execute="(action: ActionName) => keyboardActions[action]()"
/>
```

- [ ] **Step 6: Wire custom task teardown into `handleCloseTask`**

Custom task teardown commands need to run when the task is closed. The challenge is that `CustomTaskConfig` is only available at task creation time, not at close time. To bridge this gap, store the custom task's teardown commands as a JSON string in the pipeline_item's `prompt` metadata (not ideal) or re-read the `agent.md` from the repo.

The pragmatic approach: since custom task definitions live in `.kanna/tasks/` and `display_name` stores the custom task's name, re-derive the slug from `display_name` and re-read the `agent.md` at close time.

In `handleCloseTask`, after the existing repo teardown section (around line 118-134), add:

```typescript
// Run custom task teardown (if this was a custom task)
if (item.display_name) {
  try {
    // Derive slug from display name: "Ship" → "ship", "Code Review" → "code-review"
    const slug = item.display_name.toLowerCase().replace(/\s+/g, "-");
    const agentMdPath = `${selectedRepo.value.path}/.kanna/tasks/${slug}/agent.md`;
    const agentMdContent = await invoke<string>("read_text_file", { path: agentMdPath });
    if (agentMdContent) {
      const taskConfig = parseAgentMd(agentMdContent, slug);
      if (taskConfig?.teardown?.length) {
        for (const cmd of taskConfig.teardown) {
          await invoke("run_script", { script: cmd, cwd: worktreePath, env: { KANNA_WORKTREE: "1" } });
        }
      }
    }
  } catch { /* custom task teardown failed — continue closing */ }
}
```

Add `parseAgentMd` to imports from `@kanna/core`.

Note: This approach is best-effort — if the custom task's `agent.md` was deleted or the display_name doesn't match a slug, teardown is silently skipped. This matches the existing repo teardown behavior (catch-and-continue).

- [ ] **Step 7: Verify the app builds**

```bash
cd apps/desktop && bun run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: wire custom agent tasks to command palette"
```

---

### Task 9: Manual testing

- [ ] **Step 1: Start the dev server**

```bash
./scripts/dev.sh
```

- [ ] **Step 2: Test "New Custom Task" command**

1. Open the command palette (Cmd+Shift+P)
2. Type "custom" — verify "New Custom Task" appears
3. Select it — verify a new PTY task launches with the meta-prompt
4. Interact with the agent to create a test custom task (e.g. "ship")
5. Verify `.kanna/tasks/ship/agent.md` is created in the worktree

- [ ] **Step 3: Test custom task discovery**

1. Manually create `.kanna/tasks/test-task/agent.md` in the main repo with valid frontmatter and a prompt body
2. Open the command palette — verify "Custom Task Test Task" appears
3. Select it — verify a new task launches with the configured prompt

- [ ] **Step 4: Test error handling**

1. Create a malformed `.kanna/tasks/broken/agent.md` with invalid YAML
2. Open command palette — verify it doesn't crash, "broken" is skipped
3. Check console for warning log

- [ ] **Step 5: Test cancellation**

1. Open and close the command palette rapidly several times
2. Verify no errors, no stale results, no duplicate entries

- [ ] **Step 6: Clean up test fixtures and commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during manual testing"
```

(Only if fixes were needed.)
