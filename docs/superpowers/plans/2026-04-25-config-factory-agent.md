# Config Factory Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in config-factory agent and command-palette command that helps users create or update `.kanna/config.json`.

**Architecture:** Follow the existing factory-command pattern in `App.vue`: the command creates a normal Kanna task with a prompt that resolves to a built-in agent. The built-in agent lives under `.kanna/agents/config-factory/AGENT.md` and references the public JSON Schema URL so the generated config can be editor-validated.

**Tech Stack:** Vue 3, Pinia store, Vitest, Kanna built-in resource packaging.

---

### Task 1: Add Config Command Coverage

**Files:**
- Modify: `apps/desktop/src/App.test.ts`

- [x] **Step 1: Write the failing test**

Add a test near the existing command-palette dynamic command tests:

```ts
it("adds Create Config to command palette commands and launches a config-factory task", async () => {
  const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
    CommandPaletteModal: CommandPaletteModalStub,
  });

  capturedKeyboardActions?.commandPalette();
  await flushPromises();

  const createConfigButton = wrapper.get('[data-command-id="create-config"]');
  expect(createConfigButton.text()).toBe("Create Config");

  await createConfigButton.trigger("click");
  await flushPromises();

  expect(store.loadAgent).toHaveBeenCalledWith("/tmp/repo", "config-factory");
  expect(store.createItem).toHaveBeenCalledWith(
    "repo-1",
    "/tmp/repo",
    "Help me create or update the .kanna/config.json for this repository.",
    "pty",
    expect.objectContaining({
      agentProvider: "codex",
      customTask: expect.objectContaining({
        agent: "config-factory",
        name: "Create Config",
        prompt: expect.stringContaining("https://schemas.kanna.build/config.schema.json"),
      }),
    }),
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/App.test.ts -t "Create Config"`

Expected: FAIL because the dynamic command does not exist yet.

- [x] **Step 3: Implement the command**

In `apps/desktop/src/App.vue`, add `handleCreateConfig()` next to the existing factory handlers, load `config-factory`, and push a `create-config` dynamic command next to `create-agent` and `create-workflow`.

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/App.test.ts -t "Create Config"`

Expected: PASS.

### Task 2: Add Built-In Config Agent

**Files:**
- Create: `.kanna/agents/config-factory/AGENT.md`

- [x] **Step 1: Create agent definition**

Create `.kanna/agents/config-factory/AGENT.md` with frontmatter:

```md
---
name: config-factory
description: Helps users create or update .kanna/config.json
agent_provider: codex, claude, copilot
permission_mode: default
---
```

The body must instruct the agent to inspect the repository, ask concise questions only when necessary, write `.kanna/config.json`, include `"$schema": "https://schemas.kanna.build/config.schema.json"`, and validate the file against `.kanna/config.schema.json` when available.

- [x] **Step 2: Verify resource path is packaged**

Run: `rg -n "agents/" apps/desktop/src-tauri/tauri.conf.json`

Expected: output includes the resource mapping for `../../../.kanna/agents/`.

### Task 3: Final Verification

**Files:**
- Check: `apps/desktop/src/App.vue`
- Check: `.kanna/agents/config-factory/AGENT.md`

- [x] **Step 1: Run focused tests**

Run: `cd apps/desktop && pnpm exec vitest run src/App.test.ts -t "Create Config"`

Expected: PASS.

- [x] **Step 2: Run TypeScript check**

Run: `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`

Expected: PASS.

- [x] **Step 3: Run Vue SFC type check**

Run: `cd apps/desktop && pnpm exec vue-tsc --noEmit`

Expected: PASS.
