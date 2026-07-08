import { fileURLToPath } from "node:url";
import { runCommand } from "./processes";
import {
  buffyStagingCredentialsFromEnv,
  stagingRemoteE2eSkipMessage
} from "./staging";

const args = process.argv.slice(2);
const staging = args.includes("--staging");
const dev = args.includes("--dev") || !staging;

if (staging && dev && args.includes("--dev")) {
  throw new Error("remote-e2e accepts only one of --dev or --staging");
}

if (staging) {
  const credentials = buffyStagingCredentialsFromEnv(process.env);
  if (!credentials.ok) {
    console.log(stagingRemoteE2eSkipMessage(credentials.missing));
    process.exit(0);
  }
}

await runCommand("pnpm", [
  "exec",
  "vitest",
  "run",
  "--no-file-parallelism",
  ...(staging
    ? ["src/staging-smoke.e2e.test.ts"]
    : ["src/remote-harness.smoke.test.ts", "src/terminal-flow.e2e.test.ts"])
], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    KANNA_REMOTE_E2E_ENV: staging ? "staging" : "dev"
  }
});
