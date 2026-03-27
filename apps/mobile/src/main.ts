import { createApp } from "vue";
import { invoke } from "@tauri-apps/api/core";
import App from "./App.vue";

declare global {
  const __KANNA_RELAY_URL__: string;
}

const el = document.getElementById("app")!;

function showStatus(msg: string) {
  el.style.cssText = "color:#888;font:14px/1.5 monospace;padding:env(safe-area-inset-top, 20px) 20px 20px";
  el.textContent = msg;
}

function showError(stage: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[mobile:${stage}]`, err);
  el.style.cssText = "color:#ff6b6b;font:14px/1.5 monospace;padding:env(safe-area-inset-top, 20px) 20px 20px;white-space:pre-wrap;word-break:break-all;background:#1a1a1a";
  el.textContent = `[${stage}] ${msg}`;
}

async function boot() {
  const relayUrl = __KANNA_RELAY_URL__;
  showStatus(`Connecting to ${relayUrl}...`);

  let connected = false;
  while (!connected) {
    try {
      await invoke("connect_relay", { relayUrl, idToken: "mobile-dev-token" });
      connected = true;
    } catch (e) {
      showStatus(`Connecting to ${relayUrl}...\n${e}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  showStatus("Connected. Mounting app...");

  const app = createApp(App);
  app.config.errorHandler = (err) => showError("vue", err);
  app.mount("#app");
}

boot().catch((e) => showError("boot", e));
