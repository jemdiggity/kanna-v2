# Agent Provider Resolution

## Problem

`agent_provider` currently behaves inconsistently with the intended semantics.

- When an `AGENT.md` file lists multiple providers, the runtime simply picks the first entry instead of the first provider that is actually available in Kanna.
- Several launch paths silently fall back to `claude` when no provider is specified or when upstream resolution did not choose one.
- This hides misconfiguration and makes provider selection less predictable than the agent file suggests.

The desired behavior is stricter and clearer:

- `agent_provider` may be a single provider or an ordered list of providers.
- Kanna should choose the first provider in that list that is available.
- If no provider is specified, that is an error.
- If providers are specified but none are available, that is an error.
- These errors should be thrown, caught, and surfaced to the user with a toast.

## Design

### Provider Resolution Semantics

Treat every provider source as an ordered candidate list.

Resolution rules:

1. If a pipeline stage provides `stage.agent_provider`, use that candidate set.
2. Otherwise, if the referenced agent definition provides `agent.agent_provider`, use that candidate set.
3. Otherwise, if the existing task item already has `item.agent_provider`, use that single provider as the candidate set.
4. Otherwise, throw an error for missing `agent_provider`.

For any candidate set, iterate in order and select the first provider that is currently available in Kanna.

Examples:

- `agent_provider: codex, copilot` resolves to `codex` if Codex is available, otherwise `copilot` if Copilot is available.
- `agent_provider: copilot, codex` resolves to `copilot` first if both are available.
- `agent_provider: codex` throws if Codex is not available.
- omitted `agent_provider` throws unless a higher-precedence source already supplied one.

### Availability Check

Introduce a single runtime availability check used by provider resolution.

The check should answer whether each supported provider CLI is installed and callable by Kanna:

- `claude`
- `copilot`
- `codex`

The store already has UI-only CLI checks in `MainPanel.vue`, but provider resolution should not depend on that component state. The runtime path should use a shared availability helper that can be called from task creation and pipeline execution code.

### Launch Path Changes

Update task creation in `apps/desktop/src/stores/kanna.ts` so it no longer computes:

```ts
customTask.agentProvider ?? opts.agentProvider ?? "claude"
```

Instead, task creation should resolve an explicit provider from the available candidate set and throw if none can be resolved.

Update pipeline stage advance and stage rerun in the same file so they no longer use:

```ts
Array.isArray(agent.agent_provider) ? agent.agent_provider[0] : agent.agent_provider
```

Instead, they should pass the full candidate set through the shared resolver and use the first available provider.

### Spawn Guard

Keep a defensive guard in the PTY spawn path.

`spawnPtySession` should not silently default to `claude` when `options.agentProvider` is missing. If an unresolved provider reaches the spawn layer, it should throw immediately.

This keeps provider resolution centralized while still preventing accidental reintroduction of silent fallback behavior.

### Error Handling

Provider resolution errors should be normal application errors:

- resolver throws an `Error` with a user-readable message
- callers catch the error
- the desktop app shows the message with an error toast

Two main error cases:

- missing provider configuration
- configured providers are unavailable

Example messages:

- `No agent provider configured for this task or stage.`
- `None of the configured agent providers are available: codex, copilot.`

### Tests

Add targeted tests for provider resolution behavior.

Primary targets:

- store-level tests if they already exist for task creation/stage resolution
- otherwise focused unit tests around the new resolver helper

Required coverage:

- single provider resolves when available
- ordered provider list picks the first available entry
- ordered provider list skips unavailable entries
- missing provider throws
- all-unavailable provider list throws
- spawn path throws if called without a resolved provider

## Data Flow and Behavior

After this change, `agent_provider` becomes a capability-preference list rather than a static first-entry selection.

This affects:

- new task creation
- pipeline stage advancement
- stage reruns

It does not require changing the parser format. The existing support for single strings, comma-separated strings, and YAML arrays remains valid.

## Scope

### In scope

- runtime provider resolution in the desktop store
- ordered-list semantics for `agent_provider`
- removal of silent `claude` fallback from provider resolution and spawn
- catch-and-toast error handling for missing/unavailable providers
- targeted tests for the resolver behavior

### Out of scope

- changing the persisted database default for historical rows
- removing Claude support as a valid provider entirely
- redesigning the preferences UI
- changing the `agent_provider` file format
