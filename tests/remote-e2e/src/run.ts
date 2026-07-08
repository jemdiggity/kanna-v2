import { fileURLToPath } from "node:url";
import { runCommand } from "./processes";

const args = process.argv.slice(2);
const staging = args.includes("--staging");
const dev = args.includes("--dev") || !staging;

if (staging && dev && args.includes("--dev")) {
  throw new Error("remote-e2e accepts only one of --dev or --staging");
}

if (staging) {
  throw new Error("Layer B staging remote-e2e is intentionally gated until staging credentials are supplied to this harness.");
}

await runCommand("pnpm", [
  "exec",
  "vitest",
  "run",
  "--no-file-parallelism",
  "src/remote-harness.smoke.test.ts",
  "src/terminal-flow.e2e.test.ts",
  "src/task-listing-actions.e2e.test.ts"
], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    KANNA_REMOTE_E2E_ENV: "dev"
  }
});
