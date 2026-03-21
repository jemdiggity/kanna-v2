# Custom Agent Tasks — Design Spec

## Motivation

Kanna has two hardcoded agent task types (PR and Merge) plus free-form prompt tasks. Users can't define reusable task templates with preset prompts, model settings, tool restrictions, or other configuration. Custom agent tasks let users create named, reusable agent configurations stored in the repo and shared via git.

## Requirements

- Users can define custom agent tasks as files in `.kanna/tasks/<taskname>/agent.md`
- Each task has YAML frontmatter for configuration and a markdown body for the agent prompt
- Custom tasks appear in the command palette as "Custom Task \<Name>"
- A "New Custom Task" command launches an agent that helps the user define a new custom task
- All configuration fields are optional — omitted fields use Kanna defaults
- Custom tasks follow the standard worktree-per-task model (no exceptions)
- Discovery is async and cancellable — only one scan in-flight per repo at a time
- Per-repo only — definitions live in the repo, not in app-level settings

## Storage Format

Each custom task lives in its own directory under `.kanna/tasks/`:

```
.kanna/tasks/
  ship/
    agent.md
  code-review/
    agent.md
  write-tests/
    agent.md
```

The `agent.md` file uses YAML frontmatter for configuration and markdown body for the prompt:

```markdown
---
name: Ship
description: Commit, push, and create a PR for the current work
model: sonnet
permission_mode: dontAsk
execution_mode: pty
allowed_tools: []
disallowed_tools: []
max_turns: null
max_budget_usd: null
setup: ["bun install"]
teardown: []
stage: in_progress
---

You are a shipping agent. Your job is to:

1. Review all uncommitted changes
2. Write a clear commit message
3. Push the branch
4. Create a GitHub PR with a summary

Always run tests before pushing.
```

### Storage rules

- Directory name is the slug — any directory containing a valid `agent.md` is accepted (no name validation). Convention is lowercase with hyphens (e.g. `ship`, `code-review`)
- `name` in frontmatter is the display name shown in the command palette
- If `name` is missing, derive from directory name (`code-review` → "Code Review")
- All frontmatter fields are optional — missing fields fall back to Kanna defaults
- Markdown body is the agent prompt (required — an `agent.md` with no body is skipped)
- Unknown frontmatter fields are ignored (forward compatibility)
- Type mismatches in frontmatter are logged and the field falls back to default

## Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | derived from dir | Display name in command palette |
| `description` | string | none | Short description for palette subtitle |
| `model` | string | Kanna default | Model override (e.g. `sonnet`, `opus`, `haiku`) |
| `permission_mode` | string | `dontAsk` | `dontAsk`, `acceptEdits`, or `default` |
| `execution_mode` | string | `pty` | `pty` (interactive) or `sdk` (headless) |
| `allowed_tools` | string[] | `[]` (all) | Restrict agent to these tools only |
| `disallowed_tools` | string[] | `[]` | Block these tools |
| `max_turns` | number\|null | null (unlimited) | Maximum conversation turns |
| `max_budget_usd` | number\|null | null (unlimited) | Maximum dollar spend |
| `setup` | string[] | `[]` | Commands run before the agent (after repo-level setup) |
| `teardown` | string[] | `[]` | Commands run on task close (before repo-level teardown) |
| `stage` | Stage | `in_progress` | Initial pipeline stage (`in_progress`, `pr`, `merge`, `done`). Invalid values fall back to `in_progress` |

## Discovery & Scanning

### Trigger

When the command palette opens, Kanna kicks off an async scan of `.kanna/tasks/*/agent.md` for the active repo.

### Scan behavior

1. Read the repo path from the selected repo
2. List subdirectories of `{repoPath}/.kanna/tasks/`
3. For each subdirectory, read `agent.md` if it exists
4. Parse YAML frontmatter and extract markdown body
5. Return `CustomTaskScanResult` with parsed tasks and any errors

### Cancellation

- Each scan is associated with a cancellation signal (e.g. `AbortController`)
- If the palette closes and reopens before a scan finishes, the old scan is cancelled
- Only one scan in-flight per repo at any time — new scan replaces old
- Results from a cancelled scan are discarded

### Error handling

- Missing `.kanna/tasks/` directory → empty list, no error surfaced
- Malformed `agent.md` (unparseable frontmatter) → skip that task, include in `errors` array
- Missing prompt body → skip that task
- Directory with no `agent.md` → skip silently

### Location

New module: `packages/core/src/config/custom-tasks.ts`

## Command Palette Integration

### New entries

- **"Custom Task \<Name>"** — one entry per discovered custom task, using `name` from frontmatter (or derived from directory). `description` shown as subtitle if present.
- **"New Custom Task"** — always present, launches the meta-prompt agent

### Palette behavior

- On open: start async scan, show cached results (if any) immediately
- When scan completes: update palette entries if still open
- Custom task entries are filterable/searchable like any other command
- If `.kanna/tasks/` doesn't exist or is empty, only "New Custom Task" appears

### Selecting a custom task

1. Calls the existing `createItem` flow from `usePipeline`
2. Prompt pre-filled from the `agent.md` markdown body
3. Config options (model, permission_mode, allowed_tools, etc.) passed to agent spawn
4. No user prompt dialog — task launches immediately
5. `display_name` set to the custom task's `name` — `createItem` is modified to accept and pass `displayName` to `insertPipelineItem`

### Command palette changes

The existing `CommandPaletteModal.vue` uses a static `shortcuts` array from `useKeyboardShortcuts.ts` with a closed `ActionName` union type. To support dynamic custom task entries:

- Add a `dynamicCommands` prop (or inject from composable) that accepts an array of `{ label: string; description?: string; action: () => void }` entries
- Render dynamic commands alongside static shortcuts, searchable/filterable the same way
- Dynamic entries carry their own action callback (closing over the `CustomTaskConfig`), bypassing the `ActionName` type — no changes to the existing action system needed
- Show `description` as subtitle text beneath the command label

### Selecting "New Custom Task"

Launches a standard PTY task with the meta-prompt (see next section). The task runs in a worktree like all tasks. The agent writes `.kanna/tasks/<name>/agent.md` in the worktree. The custom task definition becomes available in the command palette after the worktree changes are merged to the main branch (or after the user manually copies the file).

## Meta-Prompt for "New Custom Task"

When "New Custom Task" is selected, a PTY task launches with this hardcoded prompt:

```
You are helping the user define a custom agent task for Kanna.

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
at .kanna/tasks/<taskname>/agent.md. Use a lowercase hyphenated directory name.
```

This prompt is stored as a constant in the codebase (e.g. `packages/core/src/config/custom-tasks.ts`), not as an `agent.md` file.

## Agent Spawn Changes

### `createItem` / `spawnPtySession` modifications

Accept an optional `CustomTaskConfig` parameter. The existing `createItem` signature uses `(repoId, repoPath, prompt, opts?)` where `opts` has `baseBranch` and `stage`. Add a new optional `customTask?: CustomTaskConfig` field to `opts`. When present:

- `customTask.prompt` overrides the `prompt` positional parameter
- `customTask.executionMode` maps to the existing `agentType` parameter (`pty` or `sdk`)
- `customTask.stage` maps to `opts.stage`
- `customTask.name` maps to `displayName` on the insert

Overlay custom task config values onto the defaults:

- `model` → `--model <model>` CLI flag (both PTY and SDK)
- `permission_mode` → replaces `--dangerously-skip-permissions` with `--permission-mode <value>`. Note: `spawnPtySession` currently hardcodes `--dangerously-skip-permissions` in the shell command string — this must be changed to use `--permission-mode` to support configurable permission modes.
- `allowed_tools` / `disallowed_tools` → `--allowedTools` / `--disallowedTools` CLI flags (both PTY and SDK)
- `max_turns` → `--max-turns` CLI flag (both PTY and SDK)
- `max_budget_usd` → `--max-budget-usd` CLI flag (both PTY and SDK)
- `setup` → appended after repo-level setup commands (custom runs second)
- `teardown` → prepended before repo-level teardown commands (custom runs first)
- `execution_mode` → routes to PTY or SDK spawn path
- `stage` → sets initial pipeline stage on the `pipeline_item` row

### SDK mode path

If `execution_mode` is `sdk`, route through the `agent.rs` headless path. Pass `system_prompt`, `model`, `allowed_tools`, `max_turns`, etc. via `SessionOptions`.

Required SDK changes:
- The existing `createItem` SDK invoke call currently omits `model`, `allowed_tools`, and `max_turns` — these must be added to the `invoke("create_agent_session", {...})` call
- `max_budget_usd` and `disallowed_tools` are not currently supported by the `create_agent_session` Rust command or the `SessionOptions` builder — both must be added to the Rust command signature and the SDK builder

### What doesn't change

- Worktree creation — always happens
- Hook system — same lifecycle events
- Port allocation — same logic
- Session ID = task ID — same pattern
- Activity state machine — same
- No DB schema changes — uses existing `pipeline_item` columns (`prompt`, `agent_type`, `display_name`)

## Type Definitions

New types in `packages/core/src/config/custom-tasks.ts`:

```typescript
interface CustomTaskConfig {
  name: string;
  description?: string;
  model?: string;
  permissionMode?: 'dontAsk' | 'acceptEdits' | 'default';
  executionMode?: 'pty' | 'sdk';
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setup?: string[];
  teardown?: string[];
  stage?: 'in_progress' | 'pr' | 'merge' | 'done';
  prompt: string;
}

interface CustomTaskScanResult {
  tasks: CustomTaskConfig[];
  errors: Array<{ path: string; error: string }>;
}
```

Frontmatter field names use `snake_case` in the YAML (user-facing, matches CLI conventions). TypeScript interface uses `camelCase` (code-facing). The parser maps between them.

## Testing Strategy

### Unit tests (`packages/core/`)

- **Frontmatter parsing** — valid YAML, missing fields (defaults applied), malformed YAML (skipped with error), empty body (skipped), unknown fields (ignored)
- **Directory scanning** — happy path, missing `.kanna/tasks/`, empty directory, mixed valid/invalid entries, directories without `agent.md`
- **Config merging** — custom task config overlaid on repo defaults, field precedence, setup/teardown ordering

### Integration tests

- **Scan cancellation** — verify in-flight scan is cancelled when new one starts, stale results discarded
- **`createItem` with `CustomTaskConfig`** — verify correct CLI flags produced for each config field
- **Meta-prompt task** — verify "New Custom Task" launches with correct prompt content

### Manual testing

- End-to-end: create a custom task via "New Custom Task", verify `agent.md` written correctly, verify it appears in palette on next open, verify launching it produces correct agent behavior with configured options

No E2E WebDriver tests — command palette interaction is difficult to drive through WebDriver, and unit + integration coverage is sufficient.
