import { afterEach, describe, expect, it, vi } from "vitest";
import { nextFrameOrTimeout } from "./animationFrame";

describe("nextFrameOrTimeout", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
    vi.useRealTimers();
  });

  it("resolves on the next animation frame when frames tick", async () => {
    let frameCallback: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();

    let resolved = false;
    const promise = nextFrameOrTimeout(10_000).then(() => {
      resolved = true;
    });
    expect(frameCallback).not.toBeNull();
    frameCallback?.(0);
    await promise;
    expect(resolved).toBe(true);
  });

  it("resolves via the timeout when animation frames never fire", async () => {
    vi.useFakeTimers();
    const cancelled: number[] = [];
    globalThis.requestAnimationFrame = (() => 7) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      cancelled.push(id);
    }) as typeof cancelAnimationFrame;

    let resolved = false;
    const promise = nextFrameOrTimeout(50).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
    expect(cancelled).toEqual([7]);
  });

  it("does not resolve twice when the frame fires after the timeout", async () => {
    vi.useFakeTimers();
    let frameCallback: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 3;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();

    let resolutions = 0;
    const promise = nextFrameOrTimeout(20).then(() => {
      resolutions += 1;
    });
    await vi.advanceTimersByTimeAsync(20);
    frameCallback?.(0);
    await promise;
    expect(resolutions).toBe(1);
  });
});
