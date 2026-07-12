# Scripted Agent Enter Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve discrete Enter bytes in the remote E2E scripted agent so menu selection and submitted input complete instead of timing out.

**Architecture:** Keep the production input path unchanged. Adjust only the scripted PTY terminal mode so carriage returns are not translated into newlines before the character reader captures them.

**Tech Stack:** TypeScript, shell script embedded in TypeScript, Vitest, pnpm

---

### Task 1: Preserve carriage return in the scripted agent

**Files:**
- Modify: `tests/remote-e2e/src/scriptedAgent.test.ts`
- Modify: `tests/remote-e2e/src/scriptedAgent.ts:31`

- [ ] **Step 1: Write the failing source regression assertion**

Add this assertion to the existing menu simulation test:

```ts
expect(source).toContain("stty -icanon min 1 time 0 -echo -icrnl");
```

Replace the weaker assertion for the same `stty` command so the test requires carriage-return preservation.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir tests/remote-e2e exec vitest run src/scriptedAgent.test.ts
```

Expected: FAIL because the generated source contains `stty -icanon min 1 time 0 -echo` without `-icrnl`.

- [ ] **Step 3: Implement the minimal terminal-mode fix**

Change the embedded shell command to:

```sh
stty -icanon min 1 time 0 -echo -icrnl
```

- [ ] **Step 4: Run focused unit and remote E2E verification**

Run:

```bash
pnpm --dir tests/remote-e2e exec vitest run src/scriptedAgent.test.ts
pnpm --dir tests/remote-e2e test
```

Expected: the unit test and remote E2E package pass, including terminal-flow menu selection and submitted-input cases.

- [ ] **Step 5: Run full verification**

Run:

```bash
pnpm test
```

Expected: all Turbo tasks pass.

- [ ] **Step 6: Commit the fix**

```bash
git add tests/remote-e2e/src/scriptedAgent.test.ts tests/remote-e2e/src/scriptedAgent.ts docs/superpowers/plans/2026-07-12-scripted-agent-enter-handling.md
git commit -m "test(remote-e2e): preserve enter in scripted agent"
```
