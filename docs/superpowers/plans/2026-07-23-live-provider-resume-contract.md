# Live Provider Resume Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add quota-gated live tests proving that Claude, Codex, OpenCode, Copilot, and Antigravity can resume a real persisted conversation and recover context from its first turn.

**Architecture:** Extend the existing CLI-contract helpers with one Antigravity runner and provider-session parsing utilities. A single live test file runs two separate processes per provider: the first stores a random nonce and exposes a stable session ID, and the second resumes that ID through the provider-native command used by a Kanna execution mode and must return the nonce.

**Tech Stack:** TypeScript, Node.js child processes and filesystem APIs, Vitest 4, installed provider CLIs.

---

## File Structure

- Create `tests/cli-contract/helpers/antigravity.ts`: locate and run `agy`, list its local conversation IDs, and classify unavailable authentication.
- Create `tests/cli-contract/helpers/provider-resume.ts`: common nonce/prompt helpers and pure provider session-ID extraction.
- Create `tests/cli-contract/tests/offline/provider-resume-helper.test.ts`: fast tests for the pure parsers and Antigravity before/after selection.
- Create `tests/cli-contract/tests/live/provider-resume.test.ts`: five real two-process resume contracts.
- Modify `tests/cli-contract/helpers/codex.ts`: expose `codex exec resume --json`.
- Modify `tests/cli-contract/helpers/opencode.ts`: expose `run --session` through the structured helper.
- Modify `docs/dev/testing.md`: identify the provider resume matrix in the live-suite description.
- Modify `docs/2026-07-05-revision-resume-e2e-note.md`: replace the stale “not covered” statement with the new provider-level coverage boundary.

### Task 1: Pure Session-ID and Diagnostic Helpers

**Files:**
- Create: `tests/cli-contract/helpers/provider-resume.ts`
- Create: `tests/cli-contract/tests/offline/provider-resume-helper.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create offline tests with these cases:

```ts
import { describe, expect, it } from "vitest";
import {
  extractCodexThreadId,
  extractOpenCodeSessionId,
  providerUnavailableReason,
  selectNewConversationId,
} from "../../helpers/provider-resume";

describe("provider resume helpers", () => {
  it("extracts the Codex thread ID from thread.started", () => {
    expect(extractCodexThreadId([
      { type: "thread.started", thread_id: "codex-thread" },
    ])).toBe("codex-thread");
  });

  it("extracts one stable OpenCode session ID", () => {
    expect(extractOpenCodeSessionId([
      { type: "step_start", sessionID: "ses_open" },
      { type: "text", sessionID: "ses_open" },
    ])).toBe("ses_open");
  });

  it("rejects conflicting OpenCode session IDs", () => {
    expect(() => extractOpenCodeSessionId([
      { type: "step_start", sessionID: "ses_one" },
      { type: "text", sessionID: "ses_two" },
    ])).toThrow(/multiple OpenCode session IDs/);
  });

  it("selects exactly one newly created Antigravity conversation", () => {
    expect(selectNewConversationId(
      new Set(["old-id"]),
      new Set(["old-id", "new-id"]),
    )).toBe("new-id");
  });

  it("rejects an ambiguous Antigravity conversation set", () => {
    expect(() => selectNewConversationId(
      new Set(["old-id"]),
      new Set(["old-id", "new-one", "new-two"]),
    )).toThrow(/expected one new Antigravity conversation/);
  });

  it("classifies only missing binaries and authentication failures", () => {
    expect(providerUnavailableReason("copilot binary not found")).toMatch(/binary/);
    expect(providerUnavailableReason("Please login to continue")).toMatch(/login/);
    expect(providerUnavailableReason("model timed out")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the offline test and verify RED**

Run:

```bash
pnpm --dir tests/cli-contract test -- tests/offline/provider-resume-helper.test.ts
```

Expected: FAIL because `../../helpers/provider-resume` does not exist.

- [ ] **Step 3: Implement the pure helpers**

Create `provider-resume.ts` with:

```ts
import { randomUUID } from "node:crypto";

export function createResumeNonce(provider: string): string {
  return `KANNA_${provider.toUpperCase()}_${randomUUID().replaceAll("-", "")}`;
}

export function rememberPrompt(nonce: string): string {
  return `Remember this opaque token for the next turn: ${nonce}. Reply with exactly READY.`;
}

export function recallPrompt(): string {
  return "Return only the opaque token I asked you to remember in the previous turn.";
}

export function providerUnavailableReason(output: string): string | null {
  const patterns = [
    /binary not found/i,
    /not logged in/i,
    /please log ?in/i,
    /failed to authenticate/i,
    /invalid authentication credentials/i,
    /does not have access/i,
  ];
  return patterns.find((pattern) => pattern.test(output))?.source ?? null;
}

export function extractCodexThreadId(
  lines: Array<Record<string, unknown>>,
): string {
  const event = lines.find((line) => line.type === "thread.started");
  if (typeof event?.thread_id !== "string" || event.thread_id.length === 0) {
    throw new Error("Codex did not emit a thread.started thread_id");
  }
  return event.thread_id;
}

export function extractOpenCodeSessionId(
  lines: Array<Record<string, unknown>>,
): string {
  const ids = new Set(
    lines
      .map((line) => line.sessionID)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  if (ids.size !== 1) {
    throw new Error(`expected one OpenCode session ID, found ${ids.size}; multiple OpenCode session IDs are invalid`);
  }
  return [...ids][0];
}

export function selectNewConversationId(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string {
  const created = [...after].filter((id) => !before.has(id));
  if (created.length !== 1) {
    throw new Error(
      `expected one new Antigravity conversation, found ${created.length}`,
    );
  }
  return created[0];
}
```

- [ ] **Step 4: Run the offline helper test and verify GREEN**

Run the same focused command. Expected: 6 tests pass.

- [ ] **Step 5: Commit the pure helpers**

```bash
git add tests/cli-contract/helpers/provider-resume.ts tests/cli-contract/tests/offline/provider-resume-helper.test.ts
git commit -m "test: add provider resume contract helpers"
```

### Task 2: Claude and Copilot Live Resume Contracts

**Files:**
- Create: `tests/cli-contract/tests/live/provider-resume.test.ts`
- Use: `tests/cli-contract/helpers/claude.ts`
- Use: `tests/cli-contract/helpers/copilot.ts`

- [ ] **Step 1: Add Claude and Copilot live tests**

Use `randomUUID()` session IDs and the shared prompts. Claude runs twice
through `runClaude`, first with `--session-id <uuid>` and then with
`--resume <uuid>`. Copilot runs twice through `runCopilot`, first with
`--session-id=<uuid>` and then with `--resume=<uuid>`.

Each test must:

```ts
const nonce = createResumeNonce("claude");
const sessionId = randomUUID();
const first = await runClaude({
  prompt: rememberPrompt(nonce),
  flags: ["--session-id", sessionId, "--permission-mode", "dontAsk"],
  timeoutMs: 120_000,
});
expect(first.exitCode).toBe(0);

const resumed = await runClaude({
  prompt: recallPrompt(),
  flags: ["--resume", sessionId, "--permission-mode", "dontAsk"],
  timeoutMs: 120_000,
});
expect(resumed.exitCode).toBe(0);
expect(resumed.stdout).toContain(nonce);
```

The Copilot variant uses `runCopilot`, its own nonce, and the two equals-form
flags. Both tests catch missing-binary errors and inspect combined stdout and
stderr with `providerUnavailableReason`; Vitest's per-test `skip(reason)` is
used only for a recognized unavailable reason. Claude additionally retains
`isClaudeUnavailable`. No successful exit may be skipped.

- [ ] **Step 2: Run the focused live file**

Run:

```bash
KANNA_RUN_LIVE_AGENT_CLI_CONTRACTS=1 pnpm --dir tests/cli-contract exec vitest run --config vitest.live.config.ts tests/live/provider-resume.test.ts
```

Expected: the two tests run real CLIs and pass. Any failure must retain the
provider name, exit code, and bounded stderr; a rejected resume flag or missing
nonce is a provider-contract failure, not grounds to weaken the assertion.

- [ ] **Step 3: Verify the tests use production resume flags**

Compare the spawned arguments with
`crates/kanna-server/src/task_creator/commands.rs`: Claude must use
`--resume <uuid>` and Copilot must use `--resume=<uuid>`. If the installed CLI
rejects either form, stop and treat it as a production command bug. Do not
substitute `--continue` or loosen the nonce assertion.

- [ ] **Step 4: Re-run Claude and Copilot to GREEN**

Expected: both pass, or an unavailable provider is explicitly skipped with its
authentication/missing-binary reason.

- [ ] **Step 5: Commit**

```bash
git add tests/cli-contract/tests/live/provider-resume.test.ts
git commit -m "test: exercise live Claude and Copilot resume"
```

### Task 3: Codex and OpenCode Structured Resume Contracts

**Files:**
- Modify: `tests/cli-contract/helpers/codex.ts`
- Modify: `tests/cli-contract/helpers/opencode.ts`
- Modify: `tests/cli-contract/tests/live/provider-resume.test.ts`

- [ ] **Step 1: Add failing Codex and OpenCode tests**

Codex starts with `runCodexExec`, extracts `thread_id`, then invokes a new
`runCodexExecResume` helper with that ID. OpenCode starts with
`runOpenCodeJson`, extracts `sessionID`, then calls the same helper with
`flags: ["--session", sessionId]`.

```ts
const first = await runCodexExec({ prompt: rememberPrompt(nonce) });
const sessionId = extractCodexThreadId(first.lines);
const resumed = await runCodexExecResume({
  sessionId,
  prompt: recallPrompt(),
});
expect(resumed.exitCode).toBe(0);
expect(resumed.stdout).toContain(nonce);
```

- [ ] **Step 2: Run the focused live file and verify RED**

Expected: TypeScript/import failure because `runCodexExecResume` is not yet
exported.

- [ ] **Step 3: Add the Codex resume helper and OpenCode session forwarding**

Refactor the existing Codex JSON parser into a private result builder, and run:

```ts
[
  "exec", "resume", "--json",
  "--skip-git-repo-check",
  "--sandbox", "read-only",
  sessionId,
  prompt,
]
```

For OpenCode, preserve `--format json`, `--dangerously-skip-permissions`, and
`--dir`, while forwarding `["--session", sessionId]` before the prompt.

- [ ] **Step 4: Re-run the focused live file to GREEN**

Expected: Codex and OpenCode both return their first-turn nonce from a separate
process.

- [ ] **Step 5: Commit**

```bash
git add tests/cli-contract/helpers/codex.ts tests/cli-contract/helpers/opencode.ts tests/cli-contract/tests/live/provider-resume.test.ts
git commit -m "test: exercise live Codex and OpenCode resume"
```

### Task 4: Antigravity Live Resume Contract

**Files:**
- Create: `tests/cli-contract/helpers/antigravity.ts`
- Modify: `tests/cli-contract/tests/live/provider-resume.test.ts`

- [ ] **Step 1: Add a failing Antigravity live test**

The test snapshots conversation filenames, runs one real `agy --print` turn,
identifies its new UUID-named database, then invokes a separate process with
`--conversation <uuid> --print <recall prompt>`.

```ts
const before = await listAntigravityConversationIds();
const first = await runAntigravityPrint(rememberPrompt(nonce));
expect(first.exitCode).toBe(0);
const after = await listAntigravityConversationIds();
const sessionId = selectNewConversationId(before, after);
const resumed = await runAntigravityPrint(recallPrompt(), {
  conversationId: sessionId,
});
expect(resumed.exitCode).toBe(0);
expect(resumed.stdout).toContain(nonce);
```

- [ ] **Step 2: Run the focused live file and verify RED**

Expected: import failure because the Antigravity helper does not exist.

- [ ] **Step 3: Implement the Antigravity helper**

Resolve `agy` from `~/.local/bin`, PATH, and the installed app location. Read
UUID stems only from:

```text
~/.gemini/antigravity-cli/conversations/*.db
```

Run print mode as:

```ts
[
  "--dangerously-skip-permissions",
  "--print-timeout", "2m",
  ...(conversationId ? ["--conversation", conversationId] : []),
  "--print", prompt,
]
```

Use a 150-second process timeout. Missing directories return an empty set;
non-UUID filenames are ignored.

- [ ] **Step 4: Re-run the focused live file to GREEN**

Expected: Antigravity creates exactly one conversation and the resumed process
returns the nonce. Multiple newly created IDs fail as an ambiguous test run
rather than guessing.

- [ ] **Step 5: Commit**

```bash
git add tests/cli-contract/helpers/antigravity.ts tests/cli-contract/tests/live/provider-resume.test.ts
git commit -m "test: exercise live Antigravity resume"
```

### Task 5: Full Live Suite and Coverage Documentation

**Files:**
- Modify: `docs/dev/testing.md`
- Modify: `docs/2026-07-05-revision-resume-e2e-note.md`

- [ ] **Step 1: Run the five-provider matrix**

```bash
KANNA_RUN_LIVE_AGENT_CLI_CONTRACTS=1 pnpm --dir tests/cli-contract exec vitest run --config vitest.live.config.ts tests/live/provider-resume.test.ts
```

Expected: five passes, or explicit named skips only for missing/unauthenticated
providers. Record actual outcomes; do not summarize a skip as a pass.

- [ ] **Step 2: Run the complete live CLI compatibility suite**

```bash
pnpm test:agent-cli-compat
```

Expected: exit 0 with the new five-provider matrix included.

- [ ] **Step 3: Update testing documentation**

Document that `pnpm test:agent-cli-compat` now includes real two-process
conversation-resume contracts for all five providers, while the desktop
create/review/revision path remains covered by deterministic server/daemon
tests rather than a five-provider WebDriver run.

- [ ] **Step 4: Run canonical offline checks**

```bash
pnpm test
./kd test rust
git diff --check
```

Expected: all commands exit 0. The known `relay_error_event` dead-code warning
may remain; no new warning is accepted.

- [ ] **Step 5: Commit the coverage documentation**

```bash
git add docs/dev/testing.md docs/2026-07-05-revision-resume-e2e-note.md
git commit -m "docs: record live provider resume coverage"
```

- [ ] **Step 6: Inspect final history and worktree**

```bash
git status --short
git log -8 --oneline
```

Expected: clean worktree with separate design, plan, provider-test, and
verification/documentation commits.
