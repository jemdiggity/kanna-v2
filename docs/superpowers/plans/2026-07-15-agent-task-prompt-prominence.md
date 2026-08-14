# Agent Task Prompt Prominence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> based on task coupling, subagent availability, and whether execution should
> stay in the current session.

**Goal:** Render generic agent guidance and the stage assignment as distinct
prompt sections so the actual task appears immediately below `## Your Task`
and remains the final section.

**Architecture:** The stage composer owns `## Agent Instructions` and
`## Your Task` while it still has the source bodies separately. Each trimmed
body receives one substitution pass, rendered-empty sections are omitted, and
then headings are added. Rust is the live implementation and TypeScript is its
behavioral mirror. Provider transports prepend Kanna runtime guidance without
duplicating outer sections, while still framing legacy raw prompts.

**Tech Stack:** Rust, TypeScript, Vitest, Cargo tests, Markdown documentation

---

This Kanna stage leaves commits to its later workflow step. Execute every
test-first step below, but do not create local commits.

## File Map

- `crates/kanna-server/src/task_creator/prompt.rs` — live stage composition,
  carried-task fallback, and one-pass substitution.
- `crates/kanna-server/src/task_creator/stages.rs` — live post continuation
  composition that keeps completion guidance before the task section.
- `crates/kanna-server/src/task_creator/tests/core.rs` — exact Rust composition,
  empty-section, carried-task, and substitution contracts.
- `crates/kanna-server/src/task_creator/tests/spawn.rs` — prepared provider
  prompt coverage.
- `crates/kanna-server/src/task_creator/tests/stage.rs` — stage transition and
  live-post delivery order.
- `crates/kanna-agent-protocol/src/adapter.rs` — idempotent runtime/user-prompt
  flattening for non-native system-prompt providers.
- `packages/core/src/workflow/prompt-builder.ts` — TypeScript composition,
  substitution, and flattening mirror.
- `packages/core/src/workflow/prompt-builder.test.ts` — exact TypeScript parity
  tests.
- `.kanna/agents/workflow-factory/AGENT.md` — workflow-author documentation.

### Task 1: Render Distinct Sections in Rust

**Files:**

- Modify: `crates/kanna-server/src/task_creator/prompt.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`

- [ ] Add exact failing tests for both sections, agent-only, stage-only,
  whitespace-only, and variable-rendered-empty bodies.
- [ ] Add a carried-task regression for an agent-less stage with no declared
  prompt. Its result must be `## Your Task\n\n<task>` and an inserted token in
  the task value must not be rescanned.
- [ ] Run `cargo test -p kanna-server build_stage_prompt_ -- --nocapture` and
  the carried-task test to capture the red state.
- [ ] Implement a section helper that trims each source template, substitutes
  it once from left to right, omits a rendered-whitespace body, and only then
  adds its heading.
- [ ] Route the agent-less/no-prompt carried assignment through the same stage
  composer with a literal `$TASK_PROMPT` template.
- [ ] Update existing exact expectations without changing reserved-variable
  precedence, unknown-variable behavior, or revision message construction.
- [ ] Rerun the focused Rust tests and confirm they pass.

### Task 2: Keep Provider Flattening Idempotent

**Files:**

- Modify: `crates/kanna-agent-protocol/src/adapter.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/spawn.rs`

- [ ] Add failing regressions showing that prompts whose first nonblank line is
  `## Agent Instructions` or `## Your Task` keep their outer framing, an
  agent-only prompt gains no empty task section, and a blank prompt gains no
  section.
- [ ] Pin the complementary raw-prompt behavior: an inner user-authored
  `## Your Task` heading does not make a raw prompt look outer-sectioned.
- [ ] Detect only the first nonblank outer marker. Preserve a sectioned prompt,
  emit only the preamble for blank input, and add compatibility
  `## Your Task` framing to other raw prompts.
- [ ] Update prepared Claude headless/PTY assertions and retain non-Claude
  ordering coverage.
- [ ] Run `cargo test -p kanna-agent-protocol` plus the four prepared-spawn
  regressions.

### Task 3: Keep Live Post Assignments Last

**Files:**

- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`

- [ ] Add a failing live-post assertion that the completion instruction occurs
  before `## Your Task` and the post assignment is the final message content.
- [ ] Compose a second live continuation from the post's original section
  inputs, adding the completion paragraph to agent instructions. Keep the
  fresh fallback prompt unchanged so its auto-stage Kanna preamble remains the
  sole completion policy.
- [ ] Assert the fallback user prompt does not contain the live-only
  `When this work is complete` paragraph.
- [ ] Run the post dispatch and task-creator suites.

### Task 4: Mirror Composition and Substitution in TypeScript

**Files:**

- Modify: `packages/core/src/workflow/prompt-builder.ts`
- Modify: `packages/core/src/workflow/prompt-builder.test.ts`

- [ ] Add the same exact section, rendered-empty, agent-only, blank-transport,
  nested-heading, and ordering tests as Rust.
- [ ] Add a red cross-token test proving an inserted `$PREV_RESULT` is not
  rescanned, plus parity cases for `${TASK_PROMPT}` and the unknown bare token
  `$TASK_PROMPT_SUFFIX`.
- [ ] Replace sequential replacement calls with one regex callback that
  recognizes Rust's braced syntax and bare-token boundaries, and never scans
  inserted values.
- [ ] Substitute each source body once before deciding whether to emit its
  heading. Preserve nonblank rendered bodies byte-for-byte after the existing
  outer template trim.
- [ ] Detect only outer prompt sections in runtime flattening and return the
  Kanna preamble alone for blank input.
- [ ] Run:

  ```bash
  pnpm --dir packages/core exec vitest run src/workflow/prompt-builder.test.ts --maxWorkers=2
  pnpm --dir packages/core exec tsc --noEmit
  pnpm --dir packages/core test
  ```

### Task 5: Document and Verify the Contract

**Files:**

- Modify: `.kanna/agents/workflow-factory/AGENT.md`
- Verify every file in the File Map.

- [ ] Document a stage `prompt` as the assignment rendered under
  `## Your Task` after `## Agent Instructions`, with variable bindings
  unchanged.
- [ ] Run `git diff --check` and inspect the complete tracked and untracked
  diff.
- [ ] Run canonical verification:

  ```bash
  pnpm test
  ./kd test rust
  ```

- [ ] Confirm that agent content precedes stage content, the actual assignment
  immediately follows the final task heading, raw compatibility remains,
  Claude's native Kanna system prompt stays native, live posts keep their task
  last, fresh post fallbacks do not duplicate completion guidance, revisions
  are untouched, and all work remains uncommitted for the Kanna workflow.
