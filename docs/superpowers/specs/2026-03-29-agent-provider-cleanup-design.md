# Agent Provider Cleanup

## Problem

Built-in agent definitions under `.kanna/agents` still advertise Claude compatibility and, in several cases, a Claude-specific `sonnet` model. That conflicts with the current desired policy for built-in agents: they should run on Codex or Copilot, not Claude.

The inconsistency is deeper than the markdown files. The app runtime already supports `codex`, but some authoring docs, parser types, validation rules, and tests still only allow or describe `claude | copilot`. Leaving those paths unchanged would make the built-in agent definitions inconsistent with the rest of the codebase and would keep steering newly-authored agent configs back toward Claude.

## Design

### Built-in Agent Definitions

Update every built-in agent under `.kanna/agents` so `agent_provider` is `codex, copilot`.

For agents that currently set `model: sonnet`, remove the `model` field instead of replacing it with a guessed Codex model name. That keeps the definitions provider-agnostic and lets each CLI use its configured default model.

Files:

- `.kanna/agents/implement/AGENT.md`
- `.kanna/agents/pr/AGENT.md`
- `.kanna/agents/merge/AGENT.md`
- `.kanna/agents/agent-factory/AGENT.md`
- `.kanna/agents/pipeline-factory/AGENT.md`

### Authoring Docs and Examples

Update the factory-agent instructions so examples and field descriptions describe `codex` and `copilot` as the supported providers for these built-in agent definitions.

This includes:

- frontmatter examples in `.kanna/agents/agent-factory/AGENT.md`
- provider descriptions in `.kanna/agents/agent-factory/AGENT.md`
- pipeline stage override descriptions in `.kanna/agents/pipeline-factory/AGENT.md`

The goal is that a user asking the built-in factory agents to create or document built-in Kanna agents is no longer pointed toward Claude.

### Parser and Type Cleanup

Extend config parsing paths that still only accept `claude | copilot` so they also accept `codex`.

Primary target:

- `packages/core/src/config/custom-tasks.ts`

Changes:

- widen `CustomTaskConfig.agentProvider` to include `codex`
- update `VALID_AGENT_PROVIDERS`
- update `NEW_CUSTOM_TASK_PROMPT` so generated guidance no longer presents Claude as the default or only first-class option

This keeps custom task parsing aligned with the runtime and avoids silently dropping `codex` from frontmatter.

### Tests

Update tests that currently encode Claude-only or Claude-first assumptions in the affected parsing/config areas.

Primary targets:

- `packages/core/src/config/custom-tasks.test.ts`
- any parser/loader tests that explicitly document provider allowlists or examples and need to include `codex`

The tests should verify that:

- `codex` is accepted as a valid provider in custom task frontmatter
- existing `copilot` behavior remains unchanged
- built-in agent frontmatter remains parseable after the provider/model edits

## Data Flow and Behavior

No runtime execution flow changes are required for pipeline stage resolution. The desktop store already resolves agent provider by stage override, then agent definition, then item default, and the PTY spawn path already supports `codex`.

This work is primarily a configuration and validation cleanup so the configured source-of-truth matches the supported runtime behavior.

## Error Handling

The main risk is partial cleanup: updating `.kanna/agents` without updating parsers/tests/docs would leave the repo internally inconsistent. The implementation should therefore change definitions, parsing constraints, and tests in one pass.

Removing `model: sonnet` also avoids a second class of failure where Codex or Copilot receives a Claude-specific model alias.

## Verification

Run targeted tests for the affected parsing layer after the edits:

- `packages/core` tests covering custom task parsing and agent loading

Also inspect the updated built-in agent files to confirm:

- every built-in agent now lists `codex, copilot`
- no built-in agent still pins `model: sonnet`
- no affected built-in factory docs still tell users to use Claude for these definitions

## Scope

### In scope

- Built-in `.kanna/agents` provider cleanup
- Removal of Claude-specific model pins from built-in agents
- Documentation/example updates in built-in factory agents
- Custom task parser/type updates to accept `codex`
- Targeted tests for the affected parser/config paths

### Out of scope

- Migrating historical database defaults from `claude`
- Changing app-wide default provider selection in preferences or new-task UI
- Renaming Claude-specific session/storage fields
- Refactoring the Claude SDK crate or provider-specific backend internals
