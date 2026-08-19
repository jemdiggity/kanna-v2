import { vi } from "vitest";

/**
 * Raises the default ceiling on `vi.waitFor` / `vi.waitUntil`.
 *
 * Vitest hard-codes 1000ms and offers no config knob, so every one of the
 * ~200 bare `vi.waitFor(...)` calls in this repository is an implicit
 * sub-second wall-clock deadline. They are liveness polls — the assertion
 * inside the callback is what proves the behavior, and the ceiling only has to
 * catch a condition that never becomes true — but a box running four to six
 * worktrees' suites at once can stall a worker process for long enough to trip
 * one, producing a failure that passes on rerun.
 *
 * Raising the default costs nothing on a quiet machine: `waitFor` returns as
 * soon as its callback succeeds. A call site that genuinely wants a shorter or
 * longer bound still passes its own `options` and wins.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

type WaitOptions = { timeout?: number; interval?: number };

function withDefaultTimeout<T extends (callback: never, options?: number | WaitOptions) => unknown>(
  original: T,
): T {
  return ((callback: never, options?: number | WaitOptions) =>
    original(
      callback,
      typeof options === "number"
        ? options
        : { timeout: DEFAULT_WAIT_TIMEOUT_MS, ...options },
    )) as T;
}

vi.waitFor = withDefaultTimeout(vi.waitFor.bind(vi) as never) as typeof vi.waitFor;
vi.waitUntil = withDefaultTimeout(vi.waitUntil.bind(vi) as never) as typeof vi.waitUntil;
