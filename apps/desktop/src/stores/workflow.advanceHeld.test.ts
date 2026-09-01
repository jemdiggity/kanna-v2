// @vitest-environment happy-dom

import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "@kanna/db";
import { createWorkflowApi } from "./workflow";
import type { StoreContext } from "./state";

vi.mock("../services/desktopTaskActions", () => ({
  postDesktopTaskAction: vi.fn(async () => new Response(
    JSON.stringify({
      taskId: "task-1",
      inputDelivery: { status: "queued", reason: "input_held_by_draft" },
    }),
    { status: 202 },
  )),
}));

vi.mock("../services/desktopServerClient", () => ({
  fetchDesktopRepoWorkflowDefinition: vi.fn(async () => ({
    revision: "1",
    definition: {
      name: "default",
      stages: [{
        name: "in progress",
        agent: "implement",
        post: { name: "commit", agent: "commit" },
      }],
    },
  })),
  fetchDesktopRepoAgentDefinition: vi.fn(),
}));

describe("advanceStage held-draft feedback", () => {
  afterEach(() => vi.clearAllMocks());

  it("surfaces the server's accepted-but-queued result immediately", async () => {
    const item = {
      id: "task-1",
      repo_id: "repo-1",
      pipeline: "default",
      stage: "in progress",
      closed_at: null,
      has_running_post: 0,
      active_post_action: null,
    } as PipelineItem;
    const warning = vi.fn();
    const context = {
      state: {
        items: ref([item]),
        selectedItemId: ref("task-1"),
        selectedRepoId: ref("repo-1"),
        lastSelectedItemByRepo: ref({ "repo-1": "task-1" }),
        workflowCache: new Map(),
        agentCache: new Map(),
      },
      services: {
        selectedTaskId: ref("task-1"),
        sortedItemsForCurrentRepo: ref([item]),
        withOptimisticItemOverlay: async ({ run }: { run: () => Promise<unknown> }) => await run(),
        reloadSnapshot: vi.fn(async () => {
          item.has_running_post = 1;
          item.active_post_action = "commit";
        }),
        isItemHidden: () => false,
        selectItem: vi.fn(),
        persistSelection: vi.fn(),
      },
      toast: { warning, error: vi.fn() },
      tt: (key: string) => key,
    } as unknown as StoreContext;

    await expect(createWorkflowApi(context).advanceStage("task-1")).resolves.toBe("advanced");
    expect(warning).toHaveBeenCalledWith("toasts.advanceHeldByDraft");
  });
});
