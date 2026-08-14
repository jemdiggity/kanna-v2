# Atomic, Attributed Task Input Implementation Plan

> **For Codex:** Follow the repository's test-first and verification skills while executing this plan. Do not delegate because this task's active instructions prohibit sub-agents.

**Goal:** Serialize every terminal-bound input producer through a server-owned per-session-incarnation queue, expose durable source/boundary attribution, reject unresolved quick-action templates, and disambiguate live Codex placeholders in task logs.

**Architecture:** Add a coordinator owned by `AppState`. It discovers and fences the live PTY PID, gives raw human drafts an exclusive logical turn through Enter/Ctrl-C, and delivers complete messages as indivisible text-delay-Enter transactions. Existing producers call the coordinator with an explicit `TaskInputSource`; KSP terminal input joins the same queue. Successful or uncertain boundaries append `task.input` events used by the event and log APIs.

**Tech stack:** Rust/Tokio/Axum/rusqlite, Vue/TypeScript stream client, React Native transports, Vitest, Rust integration tests.

---

### Task 1: Specify input source and validation

**Files:**
- Create: `crates/kanna-server/src/task_input_queue.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Test: `crates/kanna-server/src/task_input_queue.rs`
- Modify: `packages/stream-client/src/index.ts`
- Test: `packages/stream-client/src/stream-client.test.ts`

1. Add failing Rust tests for the closed source vocabulary, API default, unresolved `{identifier}` rejection for `quick_action`, and acceptance of the reported legitimate phrases.
2. Add failing TypeScript tests for the same structural quick-action validation.
3. Implement `TaskInputSource`, serde/default behavior, and a shared client validator without phrase blacklists.
4. Run the focused Rust and Vitest tests.

### Task 2: Add the per-incarnation input coordinator

**Files:**
- Modify: `crates/kanna-server/src/task_input_queue.rs`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Test: `crates/kanna-server/src/task_input_queue.rs`

1. Add failing actor tests proving complete messages are text/Enter atomic, a partial human draft blocks later logical messages, Enter releases them FIFO, Ctrl-C cancels the draft, and a stale/uncertain incarnation is never replayed.
2. Implement the coordinator registry keyed by `(session_id, pid)`, one worker channel per key, and monotonic admission sequences.
3. Implement acknowledged PID-fenced daemon writes, the 150 ms Enter policy, deferred logical FIFO while a human draft is active, and poisoned-worker failure.
4. Add the coordinator to `AppState` and expose narrow submit/operator methods.
5. Run focused Rust tests.

### Task 3: Route API, KSP, and server producers through the queue

**Files:**
- Modify: `crates/kanna-server/src/http_api/task_input.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/signal_agent.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/transfer_engine/finalize.rs`
- Modify: `crates/kanna-server/src/commands.rs`
- Test: existing adjacent Rust test modules

1. Update focused tests first so HTTP omission expects `api`, explicit mobile input expects `human`, KSP raw input enters the coordinator, and each internal producer supplies its source.
2. Replace direct two-write helpers with coordinator submissions while preserving typed `SessionNotFound`, `Other`, and `Uncertain` outcomes.
3. Keep task-mutation admission and live-PID discovery behavior; do not queue input for a later run.
4. Leave resize on the existing terminal-control connection and route only `TermInput` through the coordinator.
5. Run affected server tests.

### Task 4: Persist and expose input attribution

**Files:**
- Modify: `crates/kanna-server/src/db/task_events.rs`
- Modify: `crates/kanna-server/src/http_api/task_logs.rs`
- Modify: `docs/kanna-server-boundary.md`
- Test: `crates/kanna-server/src/http_api/tests/input.rs`
- Test: `crates/kanna-server/src/http_api/tests/task_logs.rs` or adjacent module

1. Add failing tests for `task.input` event payloads and the input-audit task-log section.
2. Add `TaskEventKind::InputSubmitted` and append delivered/uncertain/cancelled boundaries with bounded logical text.
3. Render an input-audit section from event rows without pretending raw terminal bytes are an edited-text transcript.
4. Document source, ordering, session fencing, and no-retry semantics.
5. Run task-event and task-log tests.

### Task 5: Mark mobile input human and reserve quick-action origin

**Files:**
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Test: `apps/mobile/src/lib/transports/remoteTransport.test.ts`

1. Change tests to require `{ input, source: "human" }` on LAN and relay HTTP invokes.
2. Update both transports.
3. Run focused mobile transport tests and TypeScript checking.

### Task 6: Disambiguate Codex composer placeholders

**Files:**
- Modify: `crates/kanna-server/src/http_api/task_logs.rs`
- Test: adjacent task-log tests

1. Add failing tests using structural Codex footer snapshots: the current composer line is labelled non-submitted, an identical earlier transcript line is unchanged, and other providers are untouched.
2. Implement provider-aware final-composer annotation after ANSI stripping, with no phrase matching.
3. Run focused task-log tests.

### Task 7: Cross-boundary concurrency regression

**Files:**
- Test: `crates/kanna-server/src/http_api/tests/input.rs` or `crates/kanna-server/tests/task_input_concurrency.rs`

1. Build a recording fake daemon and real test router/KSP connection.
2. Type a partial desktop-terminal human draft, then deterministically admit a mobile-human HTTP message, an API-default HTTP message, and a completion notification before sending terminal Enter.
3. Assert four distinct Enter-delimited submissions in admission order with no mixed bytes.
4. Assert `task.input` events have matching sequence, source, PID, and boundary values.
5. Run the regression repeatedly to detect timing dependence.

### Task 8: Full verification

1. Run `cargo fmt --all`.
2. Run focused Rust tests, affected Vitest suites, and `pnpm exec tsc --noEmit`.
3. Run `cargo clippy` for affected workspace crates and the repository's practical test command from `docs/dev/testing.md`.
4. Inspect `git diff --check`, `git status`, and the final diff for unrelated changes.
