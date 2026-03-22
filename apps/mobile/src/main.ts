import { createApp } from "vue";
import { createPinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { createRemoteDbHandle } from "@kanna/db/remote-db";
import type { DbHandle } from "@kanna/db";

// Mark this as mobile build — used by shared components for conditional rendering
declare global {
  const __KANNA_MOBILE__: boolean;
}

// Log forwarding
function forwardLog(level: string, origFn: (...args: any[]) => void) {
  return (...args: any[]) => {
    origFn.apply(console, args);
    const msg = args.map(a => {
      try { return typeof a === "string" ? a : JSON.stringify(a); }
      catch { return String(a); }
    }).join(" ");
    invoke("append_log", { message: `[${level}] ${msg}` }).catch(() => {});
  };
}

console.log = forwardLog("LOG", console.log);
console.warn = forwardLog("WARN", console.warn);
console.error = forwardLog("ERROR", console.error);

// Mobile uses remote DB handle — queries go through relay to kanna-server
const db: DbHandle = createRemoteDbHandle(
  (cmd, args) => invoke(cmd, args) as Promise<unknown>
);

// Import App from desktop source — shared Vue components
// Mobile-specific rendering is controlled by __KANNA_MOBILE__ global
const { default: App } = await import("@desktop/App.vue");

const app = createApp(App);
app.use(createPinia());
app.provide("db", db);
app.provide("dbName", "remote");
app.mount("#app");
