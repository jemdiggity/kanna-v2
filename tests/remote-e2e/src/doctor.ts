import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { getPortStatuses } from "../../../tools/kd/src/runtime/port-status";
import { nodeCommandRunner } from "../../../tools/kd/src/runtime/process";
import {
  fetchStagingBuffyIdToken,
  buffyStagingCredentialsFromEnv,
  STAGING_DEVICE_TOKEN,
  STAGING_DEVICE_TOKEN_ENV,
  STAGING_PASSWORD_ENV,
  STAGING_RELAY_URL
} from "./staging";

const args = process.argv.slice(2);
const staging = args.includes("--staging");
const relayPort = Number.parseInt(process.env.KANNA_RELAY_PORT ?? "9080", 10);
const checks: { name: string; ok: boolean; message: string }[] = [];
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function commandCheck(name: string): Promise<void> {
  const result = await nodeCommandRunner.run("command", ["-v", name]);
  checks.push({
    name,
    ok: result.exitCode === 0,
    message: result.stdout.trim() || result.stderr.trim() || `${name} not found`
  });
}

async function relayPortFree(): Promise<void> {
  const ok = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(relayPort, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
  checks.push({
    name: "relay-port",
    ok,
    message: ok ? `127.0.0.1:${relayPort} is free` : `127.0.0.1:${relayPort} is already in use`
  });
}

await Promise.all(["git", "pnpm", "cargo", "sqlite3", "java"].map(commandCheck));
await relayPortFree();

const emulatorPorts = {
  auth: Number.parseInt(process.env.KANNA_FIREBASE_AUTH_PORT ?? "9099", 10),
  firestore: Number.parseInt(process.env.KANNA_FIREBASE_FIRESTORE_PORT ?? "8080", 10),
  functions: Number.parseInt(process.env.KANNA_FIREBASE_FUNCTIONS_PORT ?? "5001", 10)
};
const statuses = await getPortStatuses(nodeCommandRunner, emulatorPorts);
for (const status of statuses) {
  checks.push({
    name: `emulator-${status.name}`,
    ok: true,
    message: status.listening
      ? `${status.name}:${status.port} is listening`
      : `${status.name}:${status.port} is free; harness will start it`
  });
}

if (staging) {
  const credentials = buffyStagingCredentialsFromEnv(process.env);
  for (const name of [STAGING_DEVICE_TOKEN_ENV, STAGING_PASSWORD_ENV]) {
    const value = process.env[name]?.trim();
    const tokenMismatch = name === STAGING_DEVICE_TOKEN_ENV && Boolean(value) && value !== STAGING_DEVICE_TOKEN;
    checks.push({
      name,
      ok: !tokenMismatch,
      message: value
        ? tokenMismatch
          ? "present; does not match the committed staging Buffy token"
          : "present"
        : "missing"
    });
  }
  await stagingRelayReachability();
  if (credentials.ok) {
    await stagingFirebaseSignIn(credentials.credentials);
  } else {
    checks.push({
      name: "staging-firebase-sign-in",
      ok: true,
      message: `skipped because ${credentials.missing.join(", ")} is missing`
    });
  }
}

console.log(JSON.stringify(checks, null, 2));
if (checks.some((check) => !check.ok)) {
  process.exit(1);
}

async function stagingRelayReachability(): Promise<void> {
  const healthUrl = STAGING_RELAY_URL.replace(/^ws/, "http") + "/health";
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) }).catch((error: unknown) => {
    checks.push({
      name: "staging-relay",
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  });
  if (!response) return;
  checks.push({
    name: "staging-relay",
    ok: response.ok,
    message: response.ok ? `${healthUrl} responded successfully` : `${healthUrl} returned HTTP ${response.status}`
  });
}

async function stagingFirebaseSignIn(credentials: { email: string; password: string }): Promise<void> {
  try {
    const idToken = await fetchStagingBuffyIdToken({
      repoRoot,
      credentials: {
        deviceToken: process.env[STAGING_DEVICE_TOKEN_ENV]?.trim() ?? "",
        email: credentials.email,
        password: credentials.password
      }
    });
    checks.push({
      name: "staging-firebase-sign-in",
      ok: idToken.length > 0,
      message: "Buffy staging sign-in returned an ID token"
    });
  } catch (error) {
    checks.push({
      name: "staging-firebase-sign-in",
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
