import { fileURLToPath } from "node:url";
import { runCommand } from "./processes";

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
  throw new Error("Layer B staging remote-e2e is intentionally gated until staging credentials are supplied to this harness.");
}

if (!mobileRelay && !desktopPairing) {
  await runCommand("pnpm", [
    "exec",
    "vitest",
    "run",
    "--no-file-parallelism",
    "src/remote-harness.smoke.test.ts",
    "src/terminal-flow.e2e.test.ts"
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      KANNA_APP_ENV: process.env.KANNA_APP_ENV || "dev",
      KANNA_REMOTE_E2E_ENV: "dev"
    }
  });
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
