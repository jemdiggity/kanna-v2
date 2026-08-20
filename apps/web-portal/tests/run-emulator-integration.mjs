import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../../..");
const firebaseConfig = JSON.parse(readFileSync(join(repoRoot, "firebase.json"), "utf8"));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "kanna-portal-emulator-"));
const configPath = join(temporaryDirectory, "firebase.json");
const authPort = Number(process.env.KANNA_FIREBASE_AUTH_PORT || process.env.VITE_FIREBASE_AUTH_EMULATOR_PORT || "9099");

writeFileSync(configPath, JSON.stringify({
  ...firebaseConfig,
  emulators: {
    auth: { host: "127.0.0.1", port: authPort },
    ui: { enabled: false }
  }
}));

try {
  const result = spawnSync("pnpm", [
    "exec",
    "firebase",
    "emulators:exec",
    "--project",
    "kanna-local",
    "--only",
    "auth",
    "--config",
    configPath,
    "pnpm --dir apps/web-portal exec vitest run tests/emulator.integration.test.ts --maxWorkers=1"
  ], {
    cwd: repoRoot,
    env: { ...process.env, KANNA_RUN_WEB_PORTAL_EMULATOR_INTEGRATION: "1" },
    stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
