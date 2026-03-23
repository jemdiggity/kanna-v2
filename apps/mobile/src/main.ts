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

// Auto-connect to relay on startup
async function connectToRelay() {
  const relayUrl = __KANNA_RELAY_URL__;
  const idToken = "mobile-dev-token";

  try {
    await invoke("connect_relay", {
      relayUrl,
      idToken,
    });
    console.log("[mobile] Connected to relay at", relayUrl);
  } catch (e) {
    console.error("[mobile] Failed to connect to relay:", e);
    // Retry after 3 seconds
    setTimeout(connectToRelay, 3000);
  }
}

// Import App from desktop — shared Vue components
// __KANNA_MOBILE__ gates desktop-only features
import App from "@desktop/App.vue";

const app = createApp(App);
app.use(createPinia());
app.provide("db", db);
app.provide("dbName", "mobile");
app.mount("#app");

// Connect after app is mounted
connectToRelay();
