import { afterEach, describe, expect, it, vi } from "vitest";
import { createWaitingPromptPublishQueue } from "./waitingPromptPublishQueue";

describe("waiting prompt publish queue", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces task changes and publishes only the newest value", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.schedule("task-1", "first");
    await vi.advanceTimersByTimeAsync(4_000);
    queue.schedule("task-1", "newest");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith("task-1", "newest");
  });

  it("deduplicates seeded values and cancels pending tasks", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.seed("task-1", "published");
    queue.schedule("task-1", "published");
    queue.schedule("task-2", "pending");
    queue.cancel("task-2");
    queue.schedule("task-3", "reconciled");
    queue.seed("task-3", "reconciled");
    await vi.runAllTimersAsync();

    expect(publish).not.toHaveBeenCalled();
  });

  it("does not mark failed values as published", async () => {
    vi.useFakeTimers();
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const queue = createWaitingPromptPublishQueue({
      delayMs: 5_000,
      publish,
      onError,
    });

    queue.schedule("task-1", "retry me");
    await vi.runAllTimersAsync();
    queue.schedule("task-1", "retry me");
    await vi.runAllTimersAsync();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("retries one transient failure without starting a periodic write loop", async () => {
    vi.useFakeTimers();
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.schedule("task-1", "retry me");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("stops after one retry while Firestore remains unavailable", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {
      throw new Error("offline");
    });
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.schedule("task-1", "retry me");
    await vi.runAllTimersAsync();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses independent trailing timers per task", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.schedule("task-1", "one");
    await vi.advanceTimersByTimeAsync(2_000);
    queue.schedule("task-2", "two");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(publish).toHaveBeenCalledWith("task-1", "one");
    expect(publish).not.toHaveBeenCalledWith("task-2", "two");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(publish).toHaveBeenCalledWith("task-2", "two");
  });

  it("cancels a pending change when the value returns to the published value", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.seed("task-1", "A");
    queue.schedule("task-1", "B");
    queue.schedule("task-1", "A");
    await vi.runAllTimersAsync();
    expect(publish).not.toHaveBeenCalled();

    queue.schedule("task-1", "B");
    await vi.runAllTimersAsync();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith("task-1", "B");
  });

  it("corrects an in-flight value when the prompt returns to the published value", async () => {
    vi.useFakeTimers();
    let resolveFirstPublish: (() => void) | null = null;
    let remoteValue = "A";
    const firstPublish = new Promise<void>((resolve) => {
      resolveFirstPublish = resolve;
    });
    const publish = vi.fn(async (_taskId: string, value: string) => {
      if (value === "B") await firstPublish;
      remoteValue = value;
    });
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.seed("task-1", "A");
    queue.schedule("task-1", "B");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publish).toHaveBeenCalledWith("task-1", "B");

    queue.schedule("task-1", "A");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publish).toHaveBeenCalledTimes(1);

    resolveFirstPublish?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(publish).toHaveBeenNthCalledWith(2, "task-1", "A");
    expect(remoteValue).toBe("A");
  });
});
