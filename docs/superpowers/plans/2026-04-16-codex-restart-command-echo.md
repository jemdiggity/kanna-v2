# Codex Restart Command Echo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the saved task prompt when explicitly restarting a PTY task and print a truncated agent startup command in the terminal prelude.

**Architecture:** Keep the fix inside the existing store/composable seams. `undoClose()` should pass the persisted task prompt back into `spawnPtySession()`, and `buildTaskShellCommand()` should render a visible `$ <agent command>` line before launching the agent while truncating long prompts to keep the terminal readable.

**Tech Stack:** Vue 3, Pinia, Vitest, TypeScript

---

### Task 1: Cover Undo-Close Prompt Reuse

**Files:**
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("reuses the saved prompt when respawning a reopened PTY task", async () => {
  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-closed",
      branch: "task-closed",
      prompt: "continue e3d1fc75",
      closed_at: "2026-04-14T12:00:00.000Z",
      agent_type: "pty",
      agent_provider: "codex",
    }),
  ];
  const store = await createStore();

  await store.undoClose();

  expect(mockState.invokeMock).toHaveBeenCalledWith(
    "spawn_session",
    expect.objectContaining({
      sessionId: "item-closed",
      cwd: "/tmp/repo/.kanna-worktrees/task-closed",
      args: expect.arrayContaining([
        expect.stringContaining("continue e3d1fc75"),
      ]),
      agentProvider: "codex",
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts -t "reuses the saved prompt when respawning a reopened PTY task"`

Expected: FAIL because `undoClose()` currently passes an empty prompt string.

- [ ] **Step 3: Write minimal implementation**

```ts
await spawnPtySession(item.id, worktreePath, item.prompt || "", 80, 24, {
  agentProvider,
  portEnv,
  ...(item.claude_session_id ? { resumeSessionId: item.claude_session_id } : {}),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts -t "reuses the saved prompt when respawning a reopened PTY task"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/kanna.taskBaseBranch.test.ts apps/desktop/src/stores/kanna.ts
git commit -m "fix: preserve prompts when reopening PTY tasks"
```

### Task 2: Cover Visible Startup Command Echo

**Files:**
- Modify: `apps/desktop/src/composables/terminalSessionRecovery.test.ts`
- Modify: `apps/desktop/src/composables/terminalSessionRecovery.ts`
- Test: `apps/desktop/src/composables/terminalSessionRecovery.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("prints the agent command before launching it", () => {
  const command = buildTaskShellCommand("codex 'ship it'", ["bun test"]);

  expect(command).toContain("printf '\\033[2m$ %s\\033[0m\\n' 'codex '\\''ship it'\\'''");
  expect(command).toContain("codex 'ship it'");
});

it("truncates long visible agent commands", () => {
  const longPrompt = "x".repeat(220);
  const command = buildTaskShellCommand(`codex '${longPrompt}'`, []);

  expect(command).toContain("...");
  expect(command.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/terminalSessionRecovery.test.ts -t "buildTaskShellCommand"`

Expected: FAIL because the helper currently prints startup setup commands but not the agent command, and it has no truncation logic.

- [ ] **Step 3: Write minimal implementation**

```ts
function truncateVisibleShellCommand(command: string, maxLength = 120): string {
  if (command.length <= maxLength) return command;
  return `${command.slice(0, maxLength - 3)}...`;
}

const visibleAgentCmd = shellSingleQuote(truncateVisibleShellCommand(agentCmd));
commandParts.push(`printf '\\033[2m$ %s\\033[0m\\n' '${visibleAgentCmd}'`);
commandParts.push(agentCmd);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/terminalSessionRecovery.test.ts -t "buildTaskShellCommand"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/terminalSessionRecovery.test.ts apps/desktop/src/composables/terminalSessionRecovery.ts
git commit -m "feat: echo truncated agent startup commands"
```

### Task 3: Verify Combined Behavior

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/composables/terminalSessionRecovery.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/composables/terminalSessionRecovery.test.ts`

- [ ] **Step 1: Run the focused test set**

```bash
pnpm --dir apps/desktop exec vitest run \
  src/stores/kanna.taskBaseBranch.test.ts \
  src/composables/terminalSessionRecovery.test.ts
```

Expected: PASS

- [ ] **Step 2: Run TypeScript verification**

```bash
pnpm exec tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts \
  apps/desktop/src/stores/kanna.taskBaseBranch.test.ts \
  apps/desktop/src/composables/terminalSessionRecovery.ts \
  apps/desktop/src/composables/terminalSessionRecovery.test.ts \
  docs/superpowers/plans/2026-04-16-codex-restart-command-echo.md
git commit -m "fix: preserve restart prompts and echo startup commands"
```
