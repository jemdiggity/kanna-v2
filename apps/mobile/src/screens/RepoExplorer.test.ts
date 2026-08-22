import { describe, expect, it, vi } from "vitest";
import { createLoiterRangeLoader } from "./repoExplorerLoiter";

describe("repository explorer loiter loading", () => {
  it("does not fetch while the viewport is flinging and caches a settled range", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const loader = createLoiterRangeLoader(load, 300);
    loader.observe(0);
    vi.advanceTimersByTime(100);
    loader.observe(200);
    vi.advanceTimersByTime(100);
    loader.observe(500);
    vi.advanceTimersByTime(299);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledWith(500);
    loader.observe(500);
    vi.advanceTimersByTime(300);
    expect(load).toHaveBeenCalledTimes(1);
    loader.observe(900);
    vi.advanceTimersByTime(300);
    loader.observe(500);
    vi.advanceTimersByTime(300);
    expect(load).toHaveBeenCalledTimes(2);
    loader.dispose();
    vi.useRealTimers();
  });
});
