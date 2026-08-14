# Main Header Port Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render task-header port badges in ascending numeric order in the main window.

**Architecture:** Keep the behavior local to `TaskHeader.vue`, where port badges are already derived from `item.port_env`. Add a focused component test that proves out-of-order JSON input renders ports in ascending numeric order, then implement the smallest computed-value change needed to make that test pass.

**Tech Stack:** Vue 3, TypeScript, Vitest, Vue Test Utils

---

### Task 1: Add Regression Coverage And Minimal Header Sort

**Files:**
- Create: `apps/desktop/src/components/__tests__/TaskHeader.test.ts`
- Modify: `apps/desktop/src/components/TaskHeader.vue`
- Test: `apps/desktop/src/components/__tests__/TaskHeader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "@kanna/db";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Fix port ordering",
    workflow: "default",
    stage: "in progress",
    stage_result: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: "task-1",
    closed_at: null,
    agent_type: null,
    agent_provider: "claude",
    agent_session_id: null,
    activity: "idle",
    activity_changed_at: null,
    unread_at: null,
    port_offset: null,
    display_name: "Fix port ordering",
    port_env: JSON.stringify({
      API_PORT: 3001,
      KANNA_DEV_PORT: 1421,
    }),
    pinned: 0,
    pin_order: null,
    base_ref: null,
    previous_stage: null,
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("TaskHeader", () => {
  it("renders port badges in ascending numeric order", async () => {
    const { default: TaskHeader } = await import("../TaskHeader.vue");
    const wrapper = mount(TaskHeader, {
      props: {
        item: makeItem(),
      },
    });

    expect(
      wrapper.findAll(".meta-item.port").map((node) => node.text().trim()),
    ).toEqual([":1421", ":3001"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest apps/desktop/src/components/__tests__/TaskHeader.test.ts`

Expected: FAIL because `TaskHeader.vue` currently preserves object iteration order and renders `:3001` before `:1421`.

- [ ] **Step 3: Write minimal implementation**

```ts
const ports = computed<number[]>(() => {
  if (!props.item.port_env) return [];
  try {
    const env = JSON.parse(props.item.port_env) as Record<string, string | number>;
    return Object.values(env)
      .map(Number)
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest apps/desktop/src/components/__tests__/TaskHeader.test.ts`

Expected: PASS

- [ ] **Step 5: Run TypeScript verification**

Run: `pnpm exec tsc --noEmit`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/TaskHeader.vue apps/desktop/src/components/__tests__/TaskHeader.test.ts docs/superpowers/plans/2026-04-20-main-header-port-sorting.md
git commit -m "fix: sort header ports numerically"
```
