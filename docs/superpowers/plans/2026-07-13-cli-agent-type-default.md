# CLI Agent Type Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an omitted agent type resolve to CLI/PTY mode for every provider while preserving explicit headless mode requests.

**Architecture:** `kanna-agent-protocol` remains the source of truth for provider defaults. Change its canonical provider metadata, regenerate the committed TypeScript mirror, and verify the server resolver consumes that default while retaining explicit `agent`, `chat`, and `sdk` behavior.

**Tech Stack:** Rust, TypeScript, ts-rs, Cargo tests, Vitest, pnpm

---

### Task 1: Lock the PTY default into cross-layer tests

**Files:**
- Modify: `crates/kanna-agent-protocol/tests/providers.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `apps/desktop/src/stores/agent-provider.test.ts`

- [x] **Step 1: Write the failing protocol test**

Replace the provider-specific default assertions with a registry-wide assertion:

```rust
for provider in AgentProvider::ALL {
    assert_eq!(provider.default_session_type(), AgentSessionType::Pty);
}
```

- [x] **Step 2: Write the failing server resolver test**

Replace the OpenCode default test with coverage for the new default and the explicit override:

```rust
#[test]
fn resolve_agent_type_defaults_to_pty_but_allows_explicit_agent() {
    assert!(matches!(
        resolve_agent_type(None, AgentProvider::Opencode),
        Ok(AgentSessionType::Pty)
    ));
    assert!(matches!(
        resolve_agent_type(Some("agent"), AgentProvider::Opencode),
        Ok(AgentSessionType::Agent)
    ));
}
```

- [x] **Step 3: Write the failing generated-registry frontend test**

Change the registry expectation to:

```typescript
expect(getAgentProviderSpec("opencode").default_session_type).toBe("pty");
```

- [x] **Step 4: Run tests to verify the expected failures**

Run:

```bash
cargo test -p kanna-agent-protocol --test providers provider_metadata_matches_runtime_contracts
cargo test -p kanna-server resolve_agent_type_defaults_to_pty_but_allows_explicit_agent
pnpm --dir apps/desktop test -- src/stores/agent-provider.test.ts
```

Expected: each focused test fails because OpenCode still advertises and resolves to `agent` by default.

### Task 2: Change the canonical default and regenerate metadata

**Files:**
- Modify: `crates/kanna-agent-protocol/src/providers.rs`
- Modify: `packages/agent-protocol/src/generated/AgentProviderRegistry.ts`

- [x] **Step 1: Implement the minimal canonical default**

Replace the provider-specific match with:

```rust
pub const fn default_session_type(self) -> AgentSessionType {
    AgentSessionType::Pty
}
```

- [x] **Step 2: Regenerate the TypeScript provider registry**

Run:

```bash
./scripts/generate-agent-protocol-types.sh
```

Expected: `packages/agent-protocol/src/generated/AgentProviderRegistry.ts` records `"default_session_type": "pty"` for all five providers.

- [x] **Step 3: Run the focused tests to verify green**

Run:

```bash
cargo test -p kanna-agent-protocol --test providers provider_metadata_matches_runtime_contracts
cargo test -p kanna-server resolve_agent_type_defaults_to_pty_but_allows_explicit_agent
pnpm --dir apps/desktop test -- src/stores/agent-provider.test.ts
```

Expected: all focused tests pass.

### Task 3: Verify generated artifacts and affected packages

**Files:**
- Verify only; no additional files expected.

- [x] **Step 1: Check the generated TypeScript mirror**

Run:

```bash
./scripts/check-agent-protocol-types.sh
```

Expected: `agent-protocol TypeScript types are up to date`.

- [x] **Step 2: Run the complete protocol and server unit tests for the touched behavior**

Run:

```bash
cargo test -p kanna-agent-protocol --test providers
cargo test -p kanna-server task_creator::tests
```

Expected: both suites pass.

- [x] **Step 3: Run desktop provider tests and repository hygiene checks**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/agent-provider.test.ts
git diff --check
git status --short
```

Expected: the test passes, `git diff --check` is silent, and status lists only the intended plan, Rust source, Rust tests, generated registry, server test, and desktop test changes. Product changes remain uncommitted because this Kanna workflow performs committing after the user advances the stage.
