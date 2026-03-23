import { createApp } from "vue";
import { createPinia } from "pinia";
import i18n from "./i18n";
import { isTauri } from "./tauri-mock";
import { loadDatabase, runMigrations } from "./stores/db";
import App from "./App.vue";

if (isTauri) {
  const { invoke } = await import("@tauri-apps/api/core");

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

  window.addEventListener("error", (e) => {
    invoke("append_log", { message: `[UNCAUGHT] ${e.message} at ${e.filename}:${e.lineno}` }).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    invoke("append_log", { message: `[UNHANDLED_REJECTION] ${e.reason}` }).catch(() => {});
  });
} else {
  console.log("[kanna] Running in browser mode with mock Tauri APIs");
}

try {
  const { db, dbName } = await loadDatabase();
  await runMigrations(db);

  const app = createApp(App);
  app.use(createPinia());
  app.use(i18n);
  app.provide("db", db);
  app.provide("dbName", dbName);
  app.mount("#app");
} catch (e) {
  console.error("[init] fatal:", e);
  const el = document.getElementById("app");
  if (el) el.textContent = `Failed to initialize: ${e}`;
}
