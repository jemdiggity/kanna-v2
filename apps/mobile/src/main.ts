import { createApp } from "vue";
import { createPinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { createRemoteDbHandle } from "@kanna/db/remote-db";

declare global {
  const __KANNA_MOBILE__: boolean;
  const __KANNA_RELAY_URL__: string;
}

// Remote DB — routes SQL queries through the relay to kanna-server
const db = createRemoteDbHandle(
  (cmd, args) => invoke(cmd, args) as Promise<unknown>,
);

// Connect to relay, then mount the app
async function boot() {
  const relayUrl = __KANNA_RELAY_URL__;

  // Keep trying until relay is connected
  let connected = false;
  while (!connected) {
    try {
      await invoke("connect_relay", {
        relayUrl,
        idToken: "mobile-dev-token",
      });
      console.log("[mobile] Connected to relay at", relayUrl);
      connected = true;
    } catch (e) {
      console.warn("[mobile] Relay not ready, retrying in 2s:", e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Import App from desktop — shared Vue components
  // __KANNA_MOBILE__ gates desktop-only features
  const { default: App } = await import("@desktop/App.vue");

  const app = createApp(App);
  app.use(createPinia());
  app.provide("db", db);
  app.provide("dbName", "mobile");
  app.mount("#app");
}

boot();
