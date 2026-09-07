/**
 * Polls `check` until it returns a value, then gives up.
 *
 * `check` is handed a `recordReason` callback: a probe that comes back empty
 * knows *why* — a status code, a connection error, a body that did not say
 * "running" — and that reason is the whole diagnosis. Without it every failure
 * here reads `Timed out while waiting for X`, which says only that the wait was
 * long, and the root cause has to be reconstructed from scratch. So the last
 * reason recorded travels into the timeout.
 */
export async function waitFor<T>(
  label: string,
  check: (recordReason: (reason: string) => void) => Promise<T | null>,
  options?: {
    intervalMs?: number;
    timeoutMs?: number;
  }
): Promise<T> {
  const intervalMs = options?.intervalMs ?? 500;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const startTime = Date.now();
  let lastReason = "";
  const recordReason = (reason: string): void => {
    lastReason = reason;
  };

  while (Date.now() - startTime < timeoutMs) {
    const result = await check(recordReason);
    if (result !== null) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms while waiting for ${label}` +
      (lastReason ? `; last attempt: ${lastReason}` : "")
  );
}
