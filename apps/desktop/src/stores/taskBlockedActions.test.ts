import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem, Repo } from "../types/kanna";
import { createTaskBlockedActions } from "./taskBlockedActions";
import type { StoreContext } from "./state";

const mocks = vi.hoisted(() => ({
  blockDesktopTask: vi.fn(async () => {}),
  unblockDesktopTask: vi.fn(async () => {}),
}));

vi.mock("../services/desktopServerClient", () => ({
  blockDesktopTask: mocks.blockDesktopTask,
  unblockDesktopTask: mocks.unblockDesktopTask,
}));

function item(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Ship it",
    pipeline: "default",
    stage: "in progress",
    stage_result: null,
    active_post_action: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: "task-task-1",
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: "2026-06-30T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    display_name: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    created_at: "2026-06-30T00:00:00.000Z",
    updated_at: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-1",
    path: "/repo",
    name: "Repo",
    default_branch: "main",
    hidden: 0,
    sort_order: 0,
    created_at: "2026-06-30T00:00:00.000Z",
    last_opened_at: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function context(items: PipelineItem[] = [item()]): StoreContext {
  const repos = [repo()];
  const reloadSnapshot = vi.fn(async () => {});
  const invalidateSharedData = vi.fn(async () => {});
  const selectItem = vi.fn(async () => {});
  return {
    state: {
      items: ref(items),
      repos: ref(repos),
      taskBlockers: ref([]),
      selectedRepoId: ref("repo-1"),
      selectedItemId: ref("task-1"),
    } as unknown as StoreContext["state"],
    services: {
      currentItem: computed(() => items[0] ?? null),
      selectedRepo: computed(() => repos[0] ?? null),
      isItemHidden: (candidate: PipelineItem) => candidate.closed_at !== null,
      reloadSnapshot,
      selectItem,
      windowWorkspace: {
        invalidateSharedData,
      } as unknown as StoreContext["services"]["windowWorkspace"],
    },
    toast: {
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
      dismiss: vi.fn(),
      toasts: ref([]),
    } as unknown as StoreContext["toast"],
    requireDb: () => {
      throw new Error("blocker actions must not use direct DB writes");
    },
    tt: (key: string) => key,
  } as StoreContext;
}

describe("createTaskBlockedActions", () => {
  beforeEach(() => {
    mocks.blockDesktopTask.mockClear();
    mocks.unblockDesktopTask.mockClear();
  });

  it("blocks the current task through the server", async () => {
    const ctx = context();
    const actions = createTaskBlockedActions(ctx);

    await actions.blockTask(["blocker-1"]);

    expect(mocks.blockDesktopTask).toHaveBeenCalledWith("task-1", ["blocker-1"]);
    expect(ctx.services.reloadSnapshot).toHaveBeenCalled();
    expect(ctx.services.windowWorkspace?.invalidateSharedData).toHaveBeenCalledWith("blockTask");
    expect(ctx.services.selectItem).toHaveBeenCalledWith("task-1");
  });

  it("replaces blockers through the server block action", async () => {
    const ctx = context();
    const actions = createTaskBlockedActions(ctx);

    await actions.editBlockedTask("task-1", ["blocker-2"]);

    expect(mocks.blockDesktopTask).toHaveBeenCalledWith("task-1", ["blocker-2"]);
    expect(mocks.unblockDesktopTask).not.toHaveBeenCalled();
    expect(ctx.services.reloadSnapshot).toHaveBeenCalled();
  });

  it("clears blockers through the server unblock action", async () => {
    const ctx = context();
    const actions = createTaskBlockedActions(ctx);

    await actions.editBlockedTask("task-1", []);

    expect(mocks.unblockDesktopTask).toHaveBeenCalledWith("task-1");
    expect(mocks.blockDesktopTask).not.toHaveBeenCalled();
    expect(ctx.services.reloadSnapshot).toHaveBeenCalled();
  });
});
