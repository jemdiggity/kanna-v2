# Agentic Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded tag-based workflow with user-definable agentic pipelines — agents as `.md` files, pipelines as `.json` files, and a pipeline engine that advances tasks through stages.

**Architecture:** File-first approach. Agent definitions (AGENT.md) and pipeline definitions (JSON) live on disk. The DB stores task state (which pipeline, which stage). A new `kanna-cli` sidecar lets agents signal stage completion. The Tauri app listens on a Unix socket for these signals and runs the pipeline engine to advance tasks.

**Tech Stack:** TypeScript (Vue 3, Pinia), Rust (Tauri, tokio), SQLite, YAML frontmatter parsing

**Spec:** `docs/superpowers/specs/2026-03-27-agentic-pipeline-design.md`

---

## File Structure

### New files to create

| File | Responsibility |
|------|---------------|
| `.kanna/agents/implement/AGENT.md` | Built-in coding agent definition |
| `.kanna/agents/pr/AGENT.md` | Built-in PR creation agent definition |
| `.kanna/agents/merge/AGENT.md` | Built-in merge queue agent definition |
| `.kanna/agents/agent-factory/AGENT.md` | Factory agent for creating new agents |
| `.kanna/agents/pipeline-factory/AGENT.md` | Factory agent for creating new pipelines |
| `.kanna/pipelines/default.json` | Built-in default pipeline definition |
| `packages/core/src/pipeline/pipeline-types.ts` | Pipeline & stage TypeScript interfaces |
| `packages/core/src/pipeline/pipeline-loader.ts` | Load & validate pipeline JSON from disk |
| `packages/core/src/pipeline/agent-loader.ts` | Load & validate AGENT.md from disk |
| `packages/core/src/pipeline/prompt-builder.ts` | Build stage prompt with variable substitution |
| `packages/core/src/pipeline/pipeline-loader.test.ts` | Tests for pipeline loading |
| `packages/core/src/pipeline/agent-loader.test.ts` | Tests for agent loading |
| `packages/core/src/pipeline/prompt-builder.test.ts` | Tests for prompt building |
| `crates/kanna-cli/src/main.rs` | Stage-complete CLI binary |
| `crates/kanna-cli/Cargo.toml` | kanna-cli crate manifest |

### Files to modify

| File | Changes |
|------|---------|
| `packages/core/src/pipeline/types.ts` | Remove `SYSTEM_TAGS`, `parseTags`, `hasTag`. Add stage helpers. |
| `packages/core/src/config/repo-config.ts` | Add `pipeline` field to `RepoConfig` |
| `packages/db/src/schema.ts` | Add `pipeline`, `stage_result` to `PipelineItem`. Remove `tags` usage. |
| `packages/db/src/queries.ts` | Replace tag queries with stage queries. Add `updatePipelineItemStage()`. |
| `apps/desktop/src/stores/db.ts` | Add migration for `pipeline`, `stage_result` columns. Tag-to-stage data migration. |
| `apps/desktop/src/stores/kanna.ts` | Replace tag-based logic with pipeline engine. Remove `startPrAgent`/`startMergeAgent`. Add `advanceStage()`, `rerunStage()`. |
| `apps/desktop/src/components/Sidebar.vue` | Replace tag-based grouping with stage-based grouping. |
| `apps/desktop/src/components/TaskHeader.vue` | Replace `TagBadges` with stage indicator. |
| `apps/desktop/src/components/MainPanel.vue` | Update blocked check from `hasTag` to blocker query. |
| `apps/desktop/src/components/NewTaskModal.vue` | Add pipeline selector dropdown. |
| `apps/desktop/src/components/CommandPaletteModal.vue` | Add "Create Agent" and "Create Pipeline" entries. |
| `apps/desktop/src-tauri/src/lib.rs` | Add `kanna.sock` Unix socket listener. |
| `apps/desktop/src-tauri/src/commands/mod.rs` | Register new pipeline commands if needed. |
| `apps/desktop/src/components/ActionBar.vue` | Replace hardcoded "Make PR" with generic stage advance. |
| `apps/desktop/src/App.vue` | Replace all `hasTag` usages with stage/blocker checks. |
| `apps/desktop/src/composables/useGc.ts` | Replace `hasTag(item, "done")` with `closed_at` check. |

### Files to delete

| File | Reason |
|------|--------|
| `apps/desktop/src/components/TagBadges.vue` | Replaced by stage indicator in TaskHeader |

---

## Task 0: Built-in agent and pipeline definition files

**Files:**
- Create: `.kanna/agents/implement/AGENT.md`
- Create: `.kanna/agents/pr/AGENT.md`
- Create: `.kanna/agents/merge/AGENT.md`
- Create: `.kanna/agents/agent-factory/AGENT.md`
- Create: `.kanna/agents/pipeline-factory/AGENT.md`
- Create: `.kanna/pipelines/default.json`

These are content files, not code. Write them first so the loaders have something to test against.

- [ ] **Step 1: Write implement agent AGENT.md**

Extract the existing hardcoded prompt from `kanna.ts` line ~500 (the `zsh -c "claude ..."` command builds the prompt inline). The implement agent is the default coding agent. Its AGENT.md should include the stage-complete instructions.

```markdown
---
name: implement
description: Coding agent that implements tasks from a prompt
agent_provider: claude, copilot
model: sonnet
permission_mode: default
---

You are a coding agent working in a git worktree.

## Rules
- Work in the current directory (it's already the worktree)
- Commit your work with clear commit messages
- Run tests if a test command is configured

## Completion
When you are done, run:
kanna-cli stage-complete --task-id $KANNA_TASK_ID --status success --summary "brief description of what you did"

If you cannot complete the task:
kanna-cli stage-complete --task-id $KANNA_TASK_ID --status failure --summary "what went wrong"
```

- [ ] **Step 2: Write PR agent AGENT.md**

Extract prompt from `startPrAgent()` at `kanna.ts:695-714`.

- [ ] **Step 3: Write merge agent AGENT.md**

Extract prompt from `startMergeAgent()` at `kanna.ts:716-753`.

- [ ] **Step 4: Write agent-factory AGENT.md**

Agent that helps users create new agent definitions. Its instructions include the AGENT.md frontmatter schema spec.

- [ ] **Step 5: Write pipeline-factory AGENT.md**

Agent that helps users create new pipeline definitions. Its instructions include the pipeline JSON schema spec.

- [ ] **Step 6: Write default.json pipeline**

```json
{
  "name": "default",
  "description": "Standard in progress -> PR flow",
  "stages": [
    {
      "name": "in progress",
      "description": "Agent implements the task",
      "agent": "implement",
      "prompt": "$TASK_PROMPT",
      "transition": "manual"
    },
    {
      "name": "pr",
      "description": "Agent creates a GitHub PR",
      "agent": "pr",
      "prompt": "Create a PR for the work on branch $BRANCH. Previous result: $PREV_RESULT",
      "transition": "manual"
    }
  ]
}
```

- [ ] **Step 7: Commit**

```bash
git add .kanna/agents/ .kanna/pipelines/
git commit -m "feat: add built-in agent and pipeline definition files"
```

---

## Task 1: Pipeline and agent TypeScript types

**Files:**
- Create: `packages/core/src/pipeline/pipeline-types.ts`
- Modify: `packages/core/src/pipeline/types.ts`

- [ ] **Step 1: Write pipeline-types.ts with interfaces**

```typescript
// packages/core/src/pipeline/pipeline-types.ts

export interface PipelineEnvironment {
  setup?: string[];
  teardown?: string[];
}

export interface PipelineStage {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: string;
  environment?: string;
  transition: "manual" | "auto";
}

export interface PipelineDefinition {
  name: string;
  description?: string;
  environments?: Record<string, PipelineEnvironment>;
  stages: PipelineStage[];
}

export interface AgentDefinition {
  name: string;
  description: string;
  agent_provider?: string | string[];
  model?: string;
  permission_mode?: "default" | "acceptEdits" | "dontAsk";
  allowed_tools?: string[];
  prompt: string; // markdown body
}

export interface StageCompleteResult {
  status: "success" | "failure";
  summary: string;
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 2: Update types.ts — deprecate SYSTEM_TAGS, add stage helpers**

Keep `parseTags` and `hasTag` for now (migration compatibility), but add:

```typescript
export function getStageIndex(pipeline: PipelineDefinition, stageName: string): number {
  return pipeline.stages.findIndex(s => s.name === stageName);
}

export function getNextStage(pipeline: PipelineDefinition, currentStage: string): PipelineStage | null {
  const idx = getStageIndex(pipeline, currentStage);
  if (idx === -1 || idx >= pipeline.stages.length - 1) return null;
  return pipeline.stages[idx + 1];
}

export function isLastStage(pipeline: PipelineDefinition, stageName: string): boolean {
  return getStageIndex(pipeline, stageName) === pipeline.stages.length - 1;
}
```

- [ ] **Step 3: Run `bun tsc --noEmit` in packages/core**

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/pipeline/
git commit -m "feat: add pipeline and agent TypeScript type definitions"
```

---

## Task 2: Pipeline loader (load + validate pipeline JSON)

**Files:**
- Create: `packages/core/src/pipeline/pipeline-loader.ts`
- Create: `packages/core/src/pipeline/pipeline-loader.test.ts`

- [ ] **Step 1: Write failing tests for pipeline-loader**

```typescript
// packages/core/src/pipeline/pipeline-loader.test.ts
import { describe, it, expect } from "vitest";
import { parsePipelineJson, validatePipeline } from "./pipeline-loader";

describe("parsePipelineJson", () => {
  it("parses valid pipeline JSON", () => { ... });
  it("rejects missing name", () => { ... });
  it("rejects empty stages array", () => { ... });
  it("rejects duplicate stage names", () => { ... });
  it("rejects invalid transition value", () => { ... });
  it("validates environment references exist", () => { ... });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test pipeline-loader`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement pipeline-loader.ts**

Functions:
- `parsePipelineJson(raw: string): PipelineDefinition` — parse and validate
- `validatePipeline(def: PipelineDefinition): string[]` — return list of validation errors

Validate: name required, stages non-empty, stage names unique, transition is "manual"|"auto", environment references exist in the `environments` map.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test pipeline-loader`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/pipeline-loader*
git commit -m "feat: add pipeline JSON loader with validation"
```

---

## Task 3: Agent loader (load + validate AGENT.md)

**Files:**
- Create: `packages/core/src/pipeline/agent-loader.ts`
- Create: `packages/core/src/pipeline/agent-loader.test.ts`

- [ ] **Step 1: Write failing tests for agent-loader**

Test cases: valid AGENT.md with all fields, minimal (name + description only), invalid permission_mode, missing required fields, provider as string vs array.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test agent-loader`
Expected: FAIL.

- [ ] **Step 3: Implement agent-loader.ts**

The AGENT.md format uses the same YAML frontmatter + markdown body pattern as custom tasks. `parseFrontmatter()` in `packages/core/src/config/custom-tasks.ts:63-88` is not currently exported. First, export it from `custom-tasks.ts`, then import it here. Do NOT duplicate the function.

Functions:
- `parseAgentDefinition(content: string): AgentDefinition` — parse AGENT.md content
- `validateAgentDefinition(def: AgentDefinition): string[]` — return validation errors

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test agent-loader`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/agent-loader*
git commit -m "feat: add AGENT.md loader with validation"
```

---

## Task 4: Prompt builder (variable substitution)

**Files:**
- Create: `packages/core/src/pipeline/prompt-builder.ts`
- Create: `packages/core/src/pipeline/prompt-builder.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `$TASK_PROMPT` replacement, `$PREV_RESULT` replacement, `$BRANCH` replacement, no-op when no variables present, undefined variables left as empty string.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test prompt-builder`

- [ ] **Step 3: Implement prompt-builder.ts**

```typescript
export interface PromptContext {
  taskPrompt?: string;
  prevResult?: string;
  branch?: string;
}

export function buildStagePrompt(
  agentPrompt: string,
  stagePrompt: string | undefined,
  context: PromptContext
): string {
  // Combine agent base prompt + stage prompt
  // Substitute $TASK_PROMPT, $PREV_RESULT, $BRANCH
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test prompt-builder`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/prompt-builder*
git commit -m "feat: add prompt builder with variable substitution"
```

---

## Task 5: Scanner for agents and pipelines per-repo

**Files:**
- Create: `packages/core/src/pipeline/scanner.ts`
- Create: `packages/core/src/pipeline/scanner.test.ts`

- [ ] **Step 1: Write failing tests**

Test: scan `.kanna/agents/*/AGENT.md` and `.kanna/pipelines/*.json` from a repo path. Mock filesystem reads via the same `listDir`/`readTextFile` pattern used in `custom-tasks-scanner.ts`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement scanner.ts**

Functions:
- `scanAgents(repoPath: string, readFile: ReadFn, listDir: ListDirFn): Promise<AgentDefinition[]>`
- `scanPipelines(repoPath: string, readFile: ReadFn, listDir: ListDirFn): Promise<PipelineDefinition[]>`

Follow the pattern from `custom-tasks-scanner.ts`. Accept injected file I/O functions for testability (Tauri commands in the app, fs in tests).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/scanner*
git commit -m "feat: add agent and pipeline scanner"
```

---

## Task 6: Update DB schema and queries

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/queries.ts`
- Modify: `packages/db/src/queries.test.ts`

- [ ] **Step 1: Update PipelineItem interface in schema.ts**

Add fields:
```typescript
pipeline: string;     // pipeline name (e.g., "default")
stage_result: string | null; // JSON from stage-complete signal
```

Keep `tags` and `stage` fields for backward compatibility. `stage` is repurposed (was legacy, now holds current stage name).

- [ ] **Step 2: Add new query functions in queries.ts**

```typescript
export async function updatePipelineItemStage(
  db: DbHandle, id: string, stage: string
): Promise<void> { ... }

export async function updatePipelineItemStageResult(
  db: DbHandle, id: string, result: string
): Promise<void> { ... }

export async function clearPipelineItemStageResult(
  db: DbHandle, id: string
): Promise<void> { ... }
```

- [ ] **Step 3: Update insertPipelineItem to accept pipeline and stage**

Modify the INSERT statement to include `pipeline` and ensure `stage` defaults to the first stage name.

- [ ] **Step 4: Update existing tests in queries.test.ts**

Add tests for new stage-related queries. Update mock data to include `pipeline` and `stage` fields.

- [ ] **Step 5: Run tests**

Run: `cd packages/db && bun test`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/
git commit -m "feat: add pipeline and stage columns to DB schema and queries"
```

---

## Task 7: DB migration (tags to stages)

**Files:**
- Modify: `apps/desktop/src/stores/db.ts`

- [ ] **Step 1: Add migration in runMigrations()**

After existing migrations, add:

```typescript
// Add pipeline column
await safeAlterTable(db, "pipeline_item", "pipeline", "TEXT NOT NULL DEFAULT 'default'");

// Add stage_result column
await safeAlterTable(db, "pipeline_item", "stage_result", "TEXT");

// Migrate tags to stage values
await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE tags LIKE '%"in progress"%' AND closed_at IS NULL`);
await db.execute(`UPDATE pipeline_item SET stage = 'pr' WHERE tags LIKE '%"pr"%' AND closed_at IS NULL`);
await db.execute(`UPDATE pipeline_item SET stage = 'merge' WHERE tags LIKE '%"merge"%' AND closed_at IS NULL`);
// Catch-all: convert old 'in_progress' (underscored) default to 'in progress' (spaced)
await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'in_progress'`);
```

- [ ] **Step 2: Verify migration runs without error on a test DB**

Run: `KANNA_DB_NAME=kanna-migration-test.db ./scripts/dev.sh`
Check: App starts, existing tasks show correct stage values.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/db.ts
git commit -m "feat: add pipeline/stage DB migration from tags"
```

---

## Task 8: Update repo config to support pipeline field

**Files:**
- Modify: `packages/core/src/config/repo-config.ts`

- [ ] **Step 1: Add `pipeline` to RepoConfig interface**

```typescript
export interface RepoConfig {
  setup?: string[];
  teardown?: string[];
  test?: string[];
  ports?: Record<string, number>;
  pipeline?: string; // default pipeline name
}
```

- [ ] **Step 2: Update parseRepoConfig() to parse the new field**

Validate that `pipeline` is a string if present.

- [ ] **Step 3: Run `bun tsc --noEmit` in packages/core**

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/repo-config.ts
git commit -m "feat: add pipeline field to RepoConfig"
```

---

## Task 9: kanna-cli Rust crate

**Files:**
- Create: `crates/kanna-cli/Cargo.toml`
- Create: `crates/kanna-cli/src/main.rs`
- Modify: `Cargo.toml` (workspace root)

- [ ] **Step 1: Create Cargo.toml for kanna-cli**

```toml
[package]
name = "kanna-cli"
version = "0.1.0"
edition = "2021"

[dependencies]
clap = { version = "4", features = ["derive"] }
rusqlite = { version = "0.31", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["net", "rt", "io-util"] }
```

- [ ] **Step 2: Implement main.rs**

Note: This crate is standalone (no Cargo workspace in this repo). Build it independently like the daemon crate.

```rust
use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    StageComplete {
        #[arg(long)]
        task_id: String,
        #[arg(long)]
        status: String,
        #[arg(long)]
        summary: String,
        #[arg(long)]
        metadata: Option<String>,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::StageComplete { task_id, status, summary, metadata } => {
            // 1. Read KANNA_DB_PATH env var
            // 2. Open SQLite, write stage_result JSON to pipeline_item
            // 3. Read KANNA_SOCKET_PATH env var
            // 4. Connect to Unix socket, send {"type":"stage_complete","task_id":"..."}
            // 5. Disconnect
        }
    }
}
```

- [ ] **Step 3: Build and verify**

Run: `cd crates/kanna-cli && cargo build`
Expected: Compiles without errors.

- [ ] **Step 4: Test CLI with --help**

Run: `./../../.build/debug/kanna-cli stage-complete --help`
Expected: Shows usage.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-cli/
git commit -m "feat: add kanna-cli crate for stage-complete signaling"
```

---

## Task 10: App socket listener (kanna.sock)

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add kanna.sock listener function**

Add a `spawn_pipeline_listener()` function that:
1. Computes socket path (same convention as daemon: respects worktree isolation)
2. Binds a `tokio::net::UnixListener`
3. On connection: reads one line of JSON, parses `{"type":"stage_complete","task_id":"..."}`
4. Emits a Tauri event `pipeline_stage_complete` with the task_id
5. Disconnects

- [ ] **Step 2: Call spawn_pipeline_listener() from the app setup**

Add it alongside `spawn_event_bridge()` in the Tauri builder setup.

- [ ] **Step 3: Pass pipeline env vars to agent spawn**

In `kanna.ts:spawnPtySession()`, add three env vars to the agent's environment:
- `KANNA_TASK_ID` — the pipeline_item.id (so agents can call `kanna-cli stage-complete --task-id $KANNA_TASK_ID`)
- `KANNA_SOCKET_PATH` — path to the app's Unix socket
- `KANNA_DB_PATH` — path to the SQLite DB file

- [ ] **Step 4: Build and verify**

Run: `cd apps/desktop && bun tauri build --debug` (or use `./scripts/dev.sh`)
Expected: App starts, socket file exists at expected path.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: add kanna.sock listener for stage-complete signals"
```

---

## Task 11: Pipeline engine in store

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`

This is the largest task. Replace the tag-based state machine with the pipeline engine.

- [ ] **Step 1: Add pipeline loading to the store**

Add a `loadPipeline(repoPath: string, pipelineName: string)` function that uses the scanner/loader from `@kanna/core` to read the pipeline JSON. Cache loaded pipelines in a reactive map.

- [ ] **Step 2: Update createItem() to use pipeline**

Modify `createItem()` to:
- Accept `pipelineName` parameter (default: from repo config or `"default"`)
- Load the pipeline definition
- Set `pipeline` and `stage` (first stage name) on the new DB row
- Use the first stage's agent definition to determine the prompt

- [ ] **Step 3: Implement advanceStage(taskId)**

Follow the spec's `advanceStage` flow (steps 1-14):
1. Read task's pipeline and stage from DB
2. Load pipeline definition
3. Run environment teardown (if any) via the existing `run_script` Tauri command in `commands/shell.rs`
4. Find next stage
5. If no next stage: toast "Task at final stage", return
6. Check blockers
7. Update DB stage + clear stage_result
8. Run environment setup (if any)
9. Spawn agent for new stage
10. Emit frontend event

Also implement `forceAdvanceStage(taskId)` — same as advanceStage but skips teardown. Used when teardown fails and user wants to continue.

- [ ] **Step 4: Implement rerunStage(taskId)**

Re-runs setup + spawns the current stage's agent again without advancing.

- [ ] **Step 5: Listen for pipeline_stage_complete Tauri event**

In the store's `init()` function, listen for the `pipeline_stage_complete` event. When received:
- Read stage_result from DB
- If current stage transition is `"auto"` and status is `"success"`: call `advanceStage(taskId)`
- Otherwise: update activity to `unread`, let user decide

- [ ] **Step 6: Remove startPrAgent() and startMergeAgent()**

These are replaced by `advanceStage()`. Remove from store and all call sites.

- [ ] **Step 7: Update sortItemsForRepo() for stage-based grouping**

Replace the tag-based sort (pinned → merge → pr → active → blocked) with:
- Load the pipeline definition for each item
- Group by stage in pipeline stage order
- Pinned items still go first, blocked items still go last

- [ ] **Step 8: Update closeTask() to remove tag references**

Replace `addPipelineItemTag(db, id, "done")` with setting `closed_at`. Remove teardown tag logic.

- [ ] **Step 9: Update checkUnblocked() to use stages instead of tags**

Replace the check for "done"/"pr"/"merge" tags on blockers. A blocker is resolved when its `closed_at` is set or it has reached a certain stage. Simplest: a blocker is resolved when `closed_at IS NOT NULL`.

- [ ] **Step 10: Run `bun tsc --noEmit`**

Expected: No type errors.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: implement pipeline engine with advanceStage and rerunStage"
```

---

## Task 12: Sidebar stage-based grouping

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue`

- [ ] **Step 1: Replace tag-based computed properties**

Remove `sortedMerge()`, `sortedPR()`, `sortedActive()`. Replace with a single computed that groups items by their `stage` field, ordered by the pipeline's stage order.

```typescript
const groupedByStage = computed(() => {
  // Group non-pinned, non-blocked items by stage
  // Order stages according to pipeline definition
  // Return: { stageName: string, items: PipelineItem[] }[]
});
```

- [ ] **Step 2: Update template to render stage groups dynamically**

Replace the hardcoded merge/pr/active sections with a `v-for` over `groupedByStage`.

- [ ] **Step 3: Verify visually**

Start dev server, create tasks, verify sidebar shows correct stage grouping.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/Sidebar.vue
git commit -m "feat: replace tag-based sidebar grouping with stage-based"
```

---

## Task 13: TaskHeader stage indicator

**Files:**
- Modify: `apps/desktop/src/components/TaskHeader.vue`
- Delete: `apps/desktop/src/components/TagBadges.vue`

- [ ] **Step 1: Replace TagBadges with a stage badge**

Remove the `<TagBadges>` component reference. Replace with a simple stage name display:

```html
<span class="stage-badge" :style="{ color: stageColor }">{{ item.stage }}</span>
```

Color can be derived from stage index (cycle through a palette) or just use a single accent color.

- [ ] **Step 2: Remove TagBadges.vue**

Delete the file. Remove any imports referencing it across the codebase.

- [ ] **Step 3: Run `bun tsc --noEmit`**

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git rm apps/desktop/src/components/TagBadges.vue
git add apps/desktop/src/components/TaskHeader.vue
git commit -m "feat: replace tag badges with stage indicator, remove TagBadges.vue"
```

---

## Task 14: MainPanel blocked check update

**Files:**
- Modify: `apps/desktop/src/components/MainPanel.vue`

- [ ] **Step 1: Replace hasTag(item, 'blocked') check**

The blocked check at line 25 currently uses `hasTag(item, 'blocked')`. Replace with a prop or computed that checks the `task_blocker` table directly (the store already has `listBlockersForItem`). The item is blocked if it has unresolved blockers, not based on a tag.

- [ ] **Step 2: Verify blocked placeholder still renders**

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/MainPanel.vue
git commit -m "feat: update blocked check to use blocker table instead of tags"
```

---

## Task 15: NewTaskModal pipeline selector

**Files:**
- Modify: `apps/desktop/src/components/NewTaskModal.vue`

- [ ] **Step 1: Add pipeline selector dropdown**

Add a `<select>` or custom dropdown that lists available pipelines for the current repo (scanned from `.kanna/pipelines/`). Default to the repo's configured pipeline from `.kanna/config.json`.

- [ ] **Step 2: Pass selected pipeline to submit event**

Change the `submit` event to emit `(prompt, pipelineName)` instead of just `prompt`.

- [ ] **Step 3: Update App.vue handler**

Update the `handleNewTask` handler to pass `pipelineName` through to `createItem()`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/NewTaskModal.vue apps/desktop/src/App.vue
git commit -m "feat: add pipeline selector to new task modal"
```

---

## Task 16: Command palette factory entries

**Files:**
- Modify: `apps/desktop/src/components/CommandPaletteModal.vue`
- Modify: `apps/App.vue`

- [ ] **Step 1: Add "Create Agent" and "Create Pipeline" dynamic commands**

In `apps/desktop/src/App.vue` where dynamic commands are assembled for the command palette, add two entries that create a task pre-configured with the factory agent. Use the `customTask` option (already supported by `createItem`) to pass the factory agent's config:

```typescript
{
  id: "create-agent",
  label: "Create Agent",
  description: "Create a new agent definition",
  execute: () => {
    // Load agent-factory AGENT.md config and pass as customTask
    store.createItem(repoId, repoPath, "Help me create a new agent", "pty", { customTask: agentFactoryConfig })
  }
},
{
  id: "create-pipeline",
  label: "Create Pipeline",
  description: "Create a new pipeline definition",
  execute: () => {
    store.createItem(repoId, repoPath, "Help me create a new pipeline", "pty", { customTask: pipelineFactoryConfig })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/components/CommandPaletteModal.vue apps/desktop/src/App.vue
git commit -m "feat: add Create Agent and Create Pipeline to command palette"
```

---

## Task 17: Stage advance keyboard shortcut

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts`
- Modify: `apps/App.vue`

- [ ] **Step 1: Replace Cmd+S (makePR) with generic "advance stage"**

Find the existing Cmd+S handler that calls `makePR()`. Replace with `advanceStage(currentItem.id)`.

- [ ] **Step 2: Remove Cmd+Shift+M (mergeQueue) shortcut**

Remove the Cmd+Shift+M handler entirely. Cmd+S is now the single "advance stage" shortcut. The merge queue agent is started via a regular task, not a shortcut.

- [ ] **Step 3: Update KeyboardShortcutsModal to show contextual label**

The shortcut description should show "Advance to {nextStageName}" based on the current task's pipeline state.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/composables/useKeyboardShortcuts.ts apps/App.vue apps/desktop/src/components/KeyboardShortcutsModal.vue
git commit -m "feat: replace PR/merge shortcuts with generic stage advance"
```

---

## Task 18: ActionBar and App.vue stage migration

**Files:**
- Modify: `apps/desktop/src/components/ActionBar.vue`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/composables/useGc.ts`

- [ ] **Step 1: Update ActionBar.vue**

Replace the hardcoded "Make PR" button (which uses `hasTag` checks) with a generic "Advance Stage" button. The button label should be contextual based on the current task's next stage name. Emit a generic `advance-stage` event instead of `make-pr`.

- [ ] **Step 2: Update App.vue hasTag usages**

Replace all `hasTag` calls in App.vue (blocking/blocker checks, command palette dynamic commands) with:
- Blocker checks: use `task_blocker` table queries (already available via `listBlockersForItem`)
- Stage checks: use `item.stage` field directly (e.g., `item.stage === 'pr'` instead of `hasTag(item, 'pr')`)

- [ ] **Step 3: Update useGc.ts**

Replace `hasTag(item, "done")` with `item.closed_at != null` for GC eligibility. Also update any `isHidden()` equivalent to use `closed_at` instead of tags.

- [ ] **Step 4: Run `bun tsc --noEmit`**

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/ActionBar.vue apps/desktop/src/App.vue apps/desktop/src/composables/useGc.ts
git commit -m "feat: migrate ActionBar, App.vue, and useGc from tags to stages"
```

---

## Task 19: Clean up deprecated tag code

**Files:**
- Modify: `packages/core/src/pipeline/types.ts`
- Modify: `packages/db/src/queries.ts`
- Modify: various files with `hasTag`/`parseTags` imports

- [ ] **Step 1: Remove SYSTEM_TAGS, parseTags, hasTag from types.ts**

- [ ] **Step 2: Remove tag query functions from queries.ts**

Remove `updatePipelineItemTags()`, `addPipelineItemTag()`, `removePipelineItemTag()`.

- [ ] **Step 3: Find and remove all imports of removed functions**

Run: `grep -r "hasTag\|parseTags\|SYSTEM_TAGS\|addPipelineItemTag\|removePipelineItemTag\|updatePipelineItemTags" --include="*.ts" --include="*.vue"`

Fix each file.

- [ ] **Step 4: Run `bun tsc --noEmit` from repo root**

Expected: No type errors.

- [ ] **Step 5: Run `bun test`**

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove deprecated tag-based code"
```

---

## Task 20: Stage sidecar binary for Tauri

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `scripts/stage-sidecars.sh`

- [ ] **Step 1: Add kanna-cli to externalBin in tauri.conf.json**

Add the kanna-cli binary alongside the daemon in the sidecar list.

- [ ] **Step 2: Update stage-sidecars.sh to include kanna-cli**

Follow the same pattern used for the daemon binary — copy to the Tauri externalBin directory with target triple suffix.

- [ ] **Step 3: Build and verify sidecar is packaged**

Run: `./scripts/stage-sidecars.sh && cd apps/desktop && bun tauri build --debug`
Expected: kanna-cli binary is in the app bundle.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json scripts/stage-sidecars.sh
git commit -m "feat: package kanna-cli as Tauri sidecar"
```

---

## Task 21: Integration test — full pipeline flow

**Files:**
- Create: `apps/desktop/tests/e2e/mock/pipeline-flow.test.ts` (or add to existing)

- [ ] **Step 1: Write E2E test for basic pipeline flow**

Test: create task with default pipeline → verify it starts in "in progress" stage → manually advance → verify it moves to "pr" stage → verify sidebar grouping updates.

- [ ] **Step 2: Write E2E test for stage-complete signal**

Test: simulate kanna-cli writing to DB + sending socket ping → verify app detects and updates UI.

- [ ] **Step 3: Run E2E tests**

Run: `cd apps/desktop && bun test:e2e`
Expected: New pipeline tests pass alongside existing tests.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/
git commit -m "test: add E2E tests for pipeline flow"
```

---

## Dependency Order

```
Task 0 (agent/pipeline files) — no deps
Task 1 (types) — no deps
Task 2 (pipeline loader) — depends on Task 1
Task 3 (agent loader) — depends on Task 1
Task 4 (prompt builder) — no deps
Task 5 (scanner) — depends on Tasks 2, 3
Task 6 (DB schema) — depends on Task 1
Task 7 (DB migration) — depends on Task 6
Task 8 (repo config) — no deps
Task 9 (kanna-cli) — depends on Task 6
Task 10 (app socket) — depends on Task 9
Task 11 (pipeline engine) — depends on Tasks 2, 3, 4, 5, 6, 7, 8, 10
Task 12 (sidebar) — depends on Task 11
Task 13 (task header) — depends on Task 11
Task 14 (main panel) — depends on Task 11
Task 15 (new task modal) — depends on Tasks 5, 11
Task 16 (command palette) — depends on Task 11
Task 17 (shortcuts) — depends on Task 11
Task 18 (ActionBar/App.vue/useGc) — depends on Task 11
Task 19 (tag cleanup) — depends on Tasks 12, 13, 14, 15, 16, 17, 18
Task 20 (sidecar packaging) — depends on Task 9 (move early so kanna-cli is in PATH for testing)
Task 21 (E2E tests) — depends on Tasks 19, 20
```

**Parallelizable groups:**
- Group A (no deps): Tasks 0, 1, 4, 8
- Group B (after types): Tasks 2, 3, 6
- Group C (after loaders + schema): Tasks 5, 7, 9, 20
- Group D (after infra): Tasks 10, 11
- Group E (after engine): Tasks 12, 13, 14, 15, 16, 17, 18
- Group F (cleanup + tests): Tasks 19, 21
