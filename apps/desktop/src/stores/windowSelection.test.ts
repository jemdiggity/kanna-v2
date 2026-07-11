// @vitest-environment happy-dom

import { computed } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { WindowWorkspaceController } from "../windowWorkspace";
import { createStoreContext, createStoreState } from "./state";
import { isTaskSelectedInAnyWindow } from "./windowSelection";

describe("isTaskSelectedInAnyWindow", () => {
  it("recognizes the current durable task behind a noncanonical UI slot", async () => {
    const state = createStoreState();
    state.selectedItemId.value = "create:stable";
    const loadSnapshot = vi.fn(async () => ({ windows: [] }));
    const context = createStoreContext(state, {} as never, {
      selectedTaskId: computed(() => "task-durable"),
      windowWorkspace: { loadSnapshot } as WindowWorkspaceController,
    });

    await expect(isTaskSelectedInAnyWindow(context, "task-durable")).resolves.toBe(true);
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("continues to recognize durable task ids saved by another window", async () => {
    const state = createStoreState();
    state.selectedItemId.value = "create:stable";
    const context = createStoreContext(state, {} as never, {
      selectedTaskId: computed(() => "task-current"),
      windowWorkspace: {
        loadSnapshot: vi.fn(async () => ({
          windows: [{ selectedItemId: "task-other" }],
        })),
      } as unknown as WindowWorkspaceController,
    });

    await expect(isTaskSelectedInAnyWindow(context, "task-other")).resolves.toBe(true);
  });
});
