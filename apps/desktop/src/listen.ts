import { isTauri, mockListen } from "./tauri-mock";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { e2eAppMetrics } from "./e2eAppMetrics";
import { e2eEventHistory } from "./e2eEventHistory";

type EventHandler = Parameters<typeof mockListen>[1];

const baseListen: (event: string, handler: EventHandler) => Promise<UnlistenFn> =
  isTauri
    ? (await import("@tauri-apps/api/event")).listen
    : mockListen;

const baseListenCurrentWebviewWindow: (event: string, handler: EventHandler) => Promise<UnlistenFn> =
  isTauri
    ? async (event, handler) => {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        return getCurrentWebviewWindow().listen(event, handler);
      }
    : mockListen;

function wrapUnlisten(event: string, unlisten: UnlistenFn): UnlistenFn {
  if (!import.meta.env.DEV || !window.__KANNA_E2E__) {
    return unlisten;
  }
  const recordUnlisten = e2eAppMetrics.recordListen(event);
  return () => {
    recordUnlisten();
    unlisten();
  };
}

export const listen: (event: string, handler: EventHandler) => Promise<UnlistenFn> =
  async (event, handler) => {
    const trackedHandler: EventHandler = import.meta.env.DEV && window.__KANNA_E2E__
      ? (payload) => {
          e2eEventHistory.record(event, payload);
          return handler(payload);
        }
      : handler;
    return wrapUnlisten(event, await baseListen(event, trackedHandler));
  };

export const listenCurrentWebviewWindow: (event: string, handler: EventHandler) => Promise<UnlistenFn> =
  async (event, handler) => wrapUnlisten(event, await baseListenCurrentWebviewWindow(event, handler));
