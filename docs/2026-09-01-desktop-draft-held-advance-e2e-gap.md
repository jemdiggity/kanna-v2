# Desktop draft-held advance E2E gap

The desktop/server boundary now represents a stage post accepted behind a typed terminal draft as HTTP `202 Accepted`. A full automated E2E must prove this sequence with a real PTY provider composer: type without submitting, invoke desktop advance, observe the 202-driven toast and persistent task banner, submit the draft, then observe the queued post release and banner clear.

The current desktop E2E harness can drive a terminal and stage advance, but it has no deterministic provider fixture that both renders a composer recognized by the daemon's attestation code and remains alive through a server-injected post. Mocking the HTTP response would only repeat the component test and would not prove the daemon/server boundary. A reusable composer-capable PTY fixture (or a deterministic mode in the CLI-contract fixture) would make this scenario reliable enough for CI.

Narrower coverage added meanwhile:

- a `kanna-server` integration test sends a prepared post to a daemon socket returning `LogicalInputHeldByDraft` and verifies that the main run closes, a running post is recorded, its completion binding advances, and the dispatch reports the held outcome;
- a desktop store test verifies that a `202` advance response produces the specific queued-draft warning;
- a `MainPanel` component test verifies persistent pending-post feedback from the existing running-post and typed-composer fields;
- the real worktree app was exercised manually with a typed draft and its rendered feedback was captured under the task's gitignored screenshot directory.
