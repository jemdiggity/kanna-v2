import { isTauri, mockInvoke } from "./tauri-mock";
import { normalizeAppError } from "./appError";
import { e2eAppMetrics } from "./e2eAppMetrics";
import { e2eInvokeHistory } from "./e2eInvokeHistory";

const tauriInvoke = isTauri
  ? (await import("@tauri-apps/api/core")).invoke
  : (cmd: string, args?: Record<string, unknown>) => Promise.resolve(mockInvoke(cmd, args));

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    if (import.meta.env.DEV && window.__KANNA_E2E__) {
      e2eAppMetrics.recordInvoke(cmd, args);
      e2eInvokeHistory.record(cmd, args);
      if (window.__KANNA_E2E__.failNextInvoke === cmd) {
        window.__KANNA_E2E__.failNextInvoke = undefined;
        throw new Error(`simulated one-shot E2E invoke failure: ${cmd}`);
      }
    }
    return await tauriInvoke<T>(cmd, args);
  } catch (error) {
    throw normalizeAppError(error);
  }
}
