# Live Provider Resume Contract Design

**Date:** 2026-07-23
**Status:** Approved

## Goal

Prove that every agent provider for which Kanna emits a native resume command
can reopen a real conversation with the installed CLI. The test must exercise
the provider, not a fake executable, and must establish that context from the
first turn is available after resumption.

The supported matrix is Claude, Codex, OpenCode, Copilot, and Antigravity.

## Scope

Add quota-gated tests to the existing live CLI contract suite under
`tests/cli-contract/tests/live/`. These tests complement, rather than replace,
the server and daemon regression tests:

- server and daemon tests prove Kanna selects the previous workspace, carries
  the provider session ID through persistence, and emits the expected command;
- live CLI tests prove the installed provider accepts that resume contract and
  restores conversation context.

A five-provider desktop/WebDriver pipeline test is out of scope. It would
repeat the existing orchestration assertions while adding UI timing, model
latency, and TUI synchronization as unrelated failure modes.

## Test Contract

Each provider test performs two real turns:

1. Generate a unique nonce that cannot be inferred by the model.
2. Start a new conversation and instruct the agent to remember the nonce
   without repeating it.
3. Obtain the stable provider session ID, either by assigning it before the
   first turn or parsing the provider's structured output.
4. Start a separate CLI process using the same resume syntax Kanna emits.
5. Ask the resumed conversation to return the nonce exactly.
6. Assert successful process completion and the nonce in the second response.

The second process is essential: continuing within one process would not test
session persistence or Kanna's revision-resume dependency.

## Provider Matrix

- **Claude:** assign a UUID with `--session-id`, then use `--resume`.
- **Codex:** capture the thread ID from the initial structured run, then use
  the Codex resume subcommand.
- **OpenCode:** capture `sessionID` from the initial JSON run, then use
  `run --session`.
- **Copilot:** assign a UUID with `--session-id`, then use `--resume=`.
- **Antigravity:** obtain its conversation ID from the initial CLI contract,
  then use `--conversation`.

Provider-specific helpers may use a pseudoterminal when a command requires an
interactive terminal. They must preserve the production argument order and
resume flags. Shared logic is limited to nonce generation, bounded process
execution, authentication/unavailability classification, and response
assertions.

## Failure and Skip Policy

The suite remains opt-in through `pnpm test:agent-cli-compat` because it uses
installed CLIs, network access, authentication, and model quota.

- A missing CLI or a clearly unauthenticated provider is reported as an
  explicit skip with its reason.
- An installed and authenticated provider that rejects the resume command,
  loses the first-turn context, times out, or exits unsuccessfully fails.
- Output included in failures is bounded and redacted through the existing
  live-test helper conventions.
- Each provider gets an independent timeout so one unavailable service does
  not obscure the rest of the matrix.

## Verification

Development follows a red/green sequence:

1. Add the five-provider live test matrix and confirm it exposes any missing
   helper or incorrect production resume assumption.
2. Add only the provider-specific harness needed to run the contract.
3. Run the new live test file and record each provider's pass or explicit skip.
4. Run the complete `pnpm test:agent-cli-compat` suite.
5. Run the repository's canonical TypeScript and Rust checks if production or
   shared helper code changes.

Passing this matrix proves real provider-level resumption. Combined with the
existing revision orchestration tests, it gives evidence for the complete
Kanna behavior without claiming a full desktop pipeline E2E.
