/**
 * Global preload — runs before any E2E test file.
 * Checks that the Tauri app is running with WebDriver available.
 */

const WD_URL = "http://127.0.0.1:4445";

const status = await fetch(`${WD_URL}/status`).catch(() => null);
if (!status?.ok) {
  console.error("\n  WebDriver not available on port 4445.");
  console.error("  Start the app with:\n");
  console.error("    KANNA_DB_NAME=kanna-test.db bun tauri dev\n");
  process.exit(1);
}

// Quick check that Vue is mounted
const session = await fetch(`${WD_URL}/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ capabilities: {} }),
}).then((r) => r.json());

const sid = session.value?.sessionId;
if (!sid) {
  console.error("\n  Failed to create WebDriver session.\n");
  process.exit(1);
}

const vueCheck = await fetch(`${WD_URL}/session/${sid}/execute/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    script:
      'return !!document.getElementById("app").__vue_app__._instance.setupState',
    args: [],
  }),
}).then((r) => r.json());

if (!vueCheck.value) {
  await fetch(`${WD_URL}/session/${sid}`, { method: "DELETE" });
  console.error("\n  Vue app not mounted. Wait for the Tauri window to fully load.\n");
  process.exit(1);
}

// Verify the app is running with a test database — refuse to run tests against production data
const dbCheck = await fetch(`${WD_URL}/session/${sid}/execute/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    script:
      'const ctx = document.getElementById("app").__vue_app__._instance.setupState;' +
      'const v = ctx.dbName; return v && v.__v_isRef ? v.value : v;',
    args: [],
  }),
}).then((r) => r.json());

await fetch(`${WD_URL}/session/${sid}`, { method: "DELETE" });

const currentDb = dbCheck.value as string;
if (!currentDb || !currentDb.includes("test")) {
  console.error(`\n  REFUSING TO RUN: app is using database "${currentDb}", not a test DB.`);
  console.error("  Start the app with:\n");
  console.error("    KANNA_DB_NAME=kanna-test.db bun tauri dev\n");
  process.exit(1);
}
