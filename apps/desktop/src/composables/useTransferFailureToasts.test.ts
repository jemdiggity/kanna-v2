import { nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import type { PipelineItem } from "../types/kanna";
import { useTransferFailureToasts } from "./useTransferFailureToasts";

function item(overrides: Partial<PipelineItem>): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    stage: "in progress",
    ...overrides,
  } as PipelineItem;
}

describe("useTransferFailureToasts", () => {
  it("announces a failed transfer once, with the reason the engine recorded", async () => {
    const items = ref<PipelineItem[]>([]);
    const toastError = vi.fn();
    useTransferFailureToasts(items, toastError, () => "Task transfer failed");

    items.value = [
      item({
        transfer_status: "failed",
        transfer_error: "task task-1 resumes claude session s-1 but no transcript exists",
      }),
    ];
    await nextTick();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toContain("no transcript exists");
    expect(toastError.mock.calls[0][0]).toContain("Task transfer failed");

    // The snapshot reloads constantly; the same failure is not news twice.
    items.value = [...items.value];
    await nextTick();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  /**
   * A retry that fails for a new reason is new information, and the same task
   * failing the same way again after a successful retry is too — otherwise the
   * second outage is silent.
   */
  it("announces a new reason, and the same reason again after it clears", async () => {
    const items = ref<PipelineItem[]>([
      item({ transfer_status: "failed", transfer_error: "peer unreachable" }),
    ]);
    const toastError = vi.fn();
    useTransferFailureToasts(items, toastError, () => "Task transfer failed");
    expect(toastError).toHaveBeenCalledTimes(1);

    items.value = [item({ transfer_status: "failed", transfer_error: "no transcript exists" })];
    await nextTick();
    expect(toastError).toHaveBeenCalledTimes(2);

    // The retry succeeds — the row leaves `failed` — and then fails again the
    // same way. That is a second outage, not a repeat of the first.
    items.value = [item({ transfer_status: "pending", transfer_error: null })];
    await nextTick();
    items.value = [item({ transfer_status: "failed", transfer_error: "no transcript exists" })];
    await nextTick();
    expect(toastError).toHaveBeenCalledTimes(3);
  });

  it("says nothing about transfers that are in flight or have no reason", async () => {
    const items = ref<PipelineItem[]>([]);
    const toastError = vi.fn();
    useTransferFailureToasts(items, toastError, () => "Task transfer failed");

    items.value = [
      item({ id: "task-1", transfer_status: "pending", transfer_error: null }),
      item({ id: "task-2", transfer_status: "importing", transfer_error: null }),
      // `failed` with no reason has nothing to tell the operator that the
      // sidebar's own transfer state does not already show.
      item({ id: "task-3", transfer_status: "failed", transfer_error: "   " }),
      item({ id: "task-4" }),
    ];
    await nextTick();

    expect(toastError).not.toHaveBeenCalled();
  });
});
