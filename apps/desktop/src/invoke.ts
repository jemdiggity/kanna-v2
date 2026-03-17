import { isTauri, mockInvoke } from "./tauri-mock";

export const invoke: <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T> =
  isTauri
    ? (await import("@tauri-apps/api/core")).invoke
    : (cmd: string, args?: any) => Promise.resolve(mockInvoke(cmd, args));
