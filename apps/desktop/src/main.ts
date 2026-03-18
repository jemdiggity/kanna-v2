import { createApp } from "vue";
import { isTauri } from "./tauri-mock";
// TEMP: swap to PtyTest for debugging
import App from "./PtyTest.vue";

if (isTauri) {
  const { invoke } = await import("@tauri-apps/api/core");

  const LOG_FILE = "/tmp/kanna-webview.log";

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

createApp(App).mount("#app");
