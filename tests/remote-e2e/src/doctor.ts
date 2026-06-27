import { createServer } from "node:net";
import { getPortStatuses } from "../../../tools/kd/src/runtime/port-status";
import { nodeCommandRunner } from "../../../tools/kd/src/runtime/process";

const args = process.argv.slice(2);
const staging = args.includes("--staging");
const relayPort = Number.parseInt(process.env.KANNA_RELAY_PORT ?? "9080", 10);
const checks: { name: string; ok: boolean; message: string }[] = [];

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
  const required = ["KANNA_STAGING_FIREBASE_SERVICE_ACCOUNT", "KANNA_STAGING_RELAY_URL"];
  for (const name of required) {
    checks.push({
      name,
      ok: Boolean(process.env[name]?.trim()),
      message: process.env[name]?.trim() ? "present" : "missing"
    });
  }
}

console.log(JSON.stringify(checks, null, 2));
if (checks.some((check) => !check.ok)) {
  process.exit(1);
}
