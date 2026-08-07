import { setTimeout as sleep } from "node:timers/promises";

import { buildGlobalKeydownScript } from "./keyboard";

export interface StartupOverlayClient {
  executeSync<T = unknown>(script: string, args?: unknown[]): Promise<T>;
  waitForNoElement(css: string, timeoutMs?: number): Promise<void>;
}

const STARTUP_SHORTCUTS_POLL_INTERVAL_MS = 100;
// A bound on a deterministic signal, not a guess at how long the modal takes to
// paint: App.vue raises `ready` several awaited settings reads and a transfer
// sidecar warmup before it decides whether to show the startup shortcuts modal,
// so `waitForAppReady()` returning says nothing about that decision.
const STARTUP_OVERLAYS_SETTLED_TIMEOUT_MS = 30_000;

const STARTUP_OVERLAYS_SETTLED_SCRIPT =
  "return Boolean(window.__KANNA_E2E__?.startupOverlaysSettled);";
const SHORTCUTS_MODAL_VISIBLE_SCRIPT =
  "return Boolean(window.__KANNA_E2E__?.setupState?.showShortcutsModal);";

async function waitForStartupOverlaysSettled(
  client: StartupOverlayClient,
): Promise<void> {
  const deadline = Date.now() + STARTUP_OVERLAYS_SETTLED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await client.executeSync<boolean>(STARTUP_OVERLAYS_SETTLED_SCRIPT)) return;
    await sleep(STARTUP_SHORTCUTS_POLL_INTERVAL_MS);
  }

  throw new Error(
    `startup overlays never settled within ${STARTUP_OVERLAYS_SETTLED_TIMEOUT_MS}ms`,
  );
}

export async function dismissStartupShortcutsModal(
  client: StartupOverlayClient,
): Promise<void> {
  await waitForStartupOverlaysSettled(client);
  const visible = await client.executeSync<boolean>(SHORTCUTS_MODAL_VISIBLE_SCRIPT);
  if (!visible) return;
  await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  await client.waitForNoElement(".shortcuts-modal", 5000);
}
