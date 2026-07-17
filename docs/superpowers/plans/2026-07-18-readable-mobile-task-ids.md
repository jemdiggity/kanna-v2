# Readable Mobile Task IDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every newly generated mobile task ID exactly eight lowercase hexadecimal characters without changing creation retry semantics.

**Architecture:** Keep mobile-generated IDs as the durable idempotency key sent to the existing task PUT endpoint. Narrow each entropy source in `generateTaskCreationId()` to 32 bits, and preserve the frozen `PendingTaskCreation.taskId` across persistence and retries.

**Tech Stack:** TypeScript, React Native/Expo, Vitest, pnpm

---

### Task 1: Specify the readable ID contract

**Files:**
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/appModel.taskCreation.test.ts`

- [x] **Step 1: Add a deterministic native-crypto test**

Stub `globalThis.crypto.randomUUID()` to return
`01234567-89ab-cdef-0123-456789abcdef`, create a task through
`createMobileController()`, and assert the submitted task ID is `01234567`.

- [x] **Step 2: Update generated-ID assertions**

Change assertions for production-generated task IDs and PUT paths from 32 hex
characters to eight. Leave explicit injected test IDs alone because those
exercise frozen-attempt behavior rather than production generation.

- [x] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test src/state/mobileController.test.ts src/appModel.taskCreation.test.ts
```

Expected: failures show that production generation still returns 32 hex
characters and that the deterministic UUID path submits the full normalized
UUID.

### Task 2: Implement eight-character generation

**Files:**
- Modify: `apps/mobile/src/state/mobileController.ts:87-125`

- [x] **Step 1: Narrow the UUID path**

After validating the normalized UUID, return its first eight hexadecimal
characters.

- [x] **Step 2: Narrow the random-byte path**

Request four bytes rather than sixteen and keep the existing two-digit hex
encoding.

- [x] **Step 3: Narrow the React Native fallback**

Mix the low 32 bits of `Date.now()`, a process-local counter, and one 32-bit
`Math.random()` sample with unsigned XOR/`Math.imul`, then pad the unsigned
result to eight lowercase hexadecimal characters.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test src/state/mobileController.test.ts src/appModel.taskCreation.test.ts
```

Expected: both files pass, including existing retry/recovery coverage.

### Task 3: Make 32-bit collisions recoverable

**Files:**
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/api/client.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`

- [x] **Step 1: Add failing collision-classification tests**

Prove the LAN transport preserves the server's `taskId already exists with
different task data` response and the client classifies that precise error as
`not-created` rather than `unknown`.

- [x] **Step 2: Preserve LAN error response detail**

Read the optional response text for failed LAN requests and append it to the
status/path error without changing behavior when no body is available.

- [x] **Step 3: Classify only confirmed task ID collisions**

In `createKannaClient`, convert the server's precise different-task-data
message to `TaskCreationError("not-created", ...)`. Leave other `409` responses
and generic failures classified as `unknown` so ambiguous creates retain their
frozen retry ID.

- [x] **Step 4: Run focused tests and verify GREEN**

```bash
pnpm --dir apps/mobile test src/lib/api/client.test.ts src/lib/transports/lanTransport.test.ts src/state/mobileController.test.ts
```

Expected: all focused tests pass, including existing definitely-not-created
controller cleanup coverage.

### Task 4: Verify the mobile package

**Files:**
- No additional source changes expected

- [x] **Step 1: Run the complete mobile unit suite**

```bash
pnpm --dir apps/mobile test
```

Expected: all mobile Vitest tests pass.

- [x] **Step 2: Run mobile type checking**

```bash
pnpm --dir apps/mobile typecheck
```

Expected: TypeScript exits successfully with no diagnostics.

- [x] **Step 3: Inspect the final diff**

```bash
git diff --check
git diff -- apps/mobile/src/state/mobileController.ts apps/mobile/src/state/mobileController.test.ts apps/mobile/src/appModel.taskCreation.test.ts docs/superpowers
```

Expected: no whitespace errors; changes remain limited to the generator,
collision handling, behavioral tests, and approved design/plan documents.
