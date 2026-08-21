import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../../..");
const firebaseConfig = JSON.parse(readFileSync(join(repoRoot, "firebase.json"), "utf8"));
const configPath = join(repoRoot, `.firebase-account-deletion-${process.pid}.json`);
const authPort = Number(process.env.KANNA_FIREBASE_AUTH_PORT || "9099");
const firestorePort = Number(process.env.KANNA_FIREBASE_FIRESTORE_PORT || "8080");
const functionsPort = Number(process.env.KANNA_FIREBASE_FUNCTIONS_PORT || "5001");
const secretPath = join(repoRoot, "services/firebase-functions/.secret.local");
const previousSecret = existsSync(secretPath) ? readFileSync(secretPath, "utf8") : null;

writeFileSync(configPath, JSON.stringify({
  firestore: { rules: "firestore.rules" },
  functions: {
    ...firebaseConfig.functions,
    source: "services/firebase-functions",
  },
  emulators: {
    auth: { host: "127.0.0.1", port: authPort },
    firestore: { host: "127.0.0.1", port: firestorePort },
    functions: { host: "127.0.0.1", port: functionsPort },
    ui: { enabled: false },
  },
}));

try {
  writeFileSync(secretPath, "STRIPE_SECRET_KEY=sk_test_emulator_not_live\n");
  const build = spawnSync("pnpm", ["--dir", "services/firebase-functions", "build"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exitCode = build.status ?? 1;
  } else {
    const command = "pnpm --dir apps/web-portal exec vitest run tests/accountDeletion.emulator.integration.test.ts --maxWorkers=1";
    const result = spawnSync("pnpm", [
      "exec",
      "firebase",
      "emulators:exec",
      "--project",
      "kanna-local",
      "--only",
      "auth,firestore,functions",
      "--config",
      configPath,
      command,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        KANNA_RUN_WEB_PORTAL_ACCOUNT_DELETION_INTEGRATION: "1",
        KANNA_FIREBASE_AUTH_PORT: String(authPort),
        KANNA_FIREBASE_FIRESTORE_PORT: String(firestorePort),
        KANNA_FIREBASE_FUNCTIONS_PORT: String(functionsPort),
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "sk_test_emulator_not_live",
      },
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(configPath, { force: true });
  if (previousSecret === null) rmSync(secretPath, { force: true });
  else writeFileSync(secretPath, previousSecret);
}
