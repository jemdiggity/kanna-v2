import { fileURLToPath } from "node:url";
import { runCommand } from "./processes";
import {
  buffyStagingCredentialsFromEnv,
  stagingRemoteE2eSkipMessage
} from "./staging";

const args = process.argv.slice(2);
const staging = args.includes("--staging");
const mobileRelay = args.includes("--mobile-relay");
const desktopPairing = args.includes("--desktop-pairing");
const dev = args.includes("--dev") || !staging;
const supportedArgs = new Set([
  "--dev",
  "--staging",
  "--mobile-relay",
  "--desktop-pairing"
]);

const unsupportedArg = args.find((arg) => !supportedArgs.has(arg));
if (unsupportedArg) {
  throw new Error(`remote-e2e does not support ${unsupportedArg}`);
}

if (staging && dev && args.includes("--dev")) {
  throw new Error("remote-e2e accepts only one of --dev or --staging");
}

if (staging) {
  if (mobileRelay || desktopPairing) {
    throw new Error("Layer C/D staging remote-e2e lanes are human-gated.");
  }
  const credentials = buffyStagingCredentialsFromEnv(process.env);
  if (!credentials.ok) {
    console.log(stagingRemoteE2eSkipMessage(credentials.missing));
    process.exit(0);
  }
}

if (!mobileRelay && !desktopPairing) {
  const testFiles = staging
    ? ["src/staging-smoke.e2e.test.ts"]
    : [
        "src/remote-harness.smoke.test.ts",
        "src/cloud-pairing-auth-discovery.e2e.test.ts",
        "src/terminal-flow.e2e.test.ts",
        "src/task-listing-actions.e2e.test.ts"
      ];
  for (const testFile of testFiles) {
    await runCommand("pnpm", [
      "exec",
      "vitest",
      "run",
      "--no-file-parallelism",
      testFile
    ], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        KANNA_APP_ENV: process.env.KANNA_APP_ENV || "dev",
        KANNA_REMOTE_E2E_ENV: staging ? "staging" : "dev"
      }
    });
  }
}

if (mobileRelay) {
  await runCommand("pnpm", ["--dir", "apps/mobile", "run", "test:e2e:relay"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      ...process.env,
      KANNA_APP_ENV: process.env.KANNA_APP_ENV || "dev",
      KANNA_REMOTE_E2E_ENV: "dev"
    }
  });
}

if (desktopPairing) {
  await runCommand("pnpm", [
    "--dir",
    "apps/desktop",
    "exec",
    "tsx",
    "tests/e2e/run.ts",
    "real/mobile-pairing-ui.test.ts"
  ], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      ...process.env,
      KANNA_APP_ENV: process.env.KANNA_APP_ENV || "dev",
      KANNA_REMOTE_E2E_ENV: "dev"
    }
  });
}
