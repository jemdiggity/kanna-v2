import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  buildFirebaseCommandEnv,
  buildFirebaseEmulatorArgs,
  writeFirebaseEmulatorConfig,
  type FirebasePortInput
} from "../../../tools/kd/src/runtime/firebase";
import { BUFFY_UID, waitForBuffyIdToken } from "./firebaseAuth";
import { createNodeRelayDesktopClient } from "./nodeRelayClient";
import { findFreePort, runCommand, startManagedProcess, waitForFile, waitForHttpOk, type ManagedProcess } from "./processes";
import { createHarnessDatabase } from "./sqlite";
import type { RelayDesktopClient } from "../../../apps/mobile/src/lib/transports/relayClient";

export interface RemoteHarnessOptions {
  repoRoot?: string;
  keepArtifacts?: boolean;
  timeoutMs?: number;
}

export interface RemoteHarness {
  client: RelayDesktopClient;
  desktopId: string;
  lanBaseUrl: string;
  repoRoot: string;
  paths: {
    configPath: string;
    daemonDir: string;
    dbPath: string;
    root: string;
  };
  ports: {
    auth: number;
    firestore: number;
    functions: number;
    relay: number;
    server: number;
    ui: number;
  };
  startRelay(): Promise<void>;
  stopRelay(): Promise<void>;
  waitForDesktop(): Promise<void>;
  stop(): Promise<void>;
}

const DEVICE_TOKEN = "e2e-token";
const DESKTOP_NAME = "Remote E2E Desktop";

function defaultRepoRoot(): string {
  return resolve(fileURLToPath(new URL("../../..", import.meta.url)));
}

function shellTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

async function allocatePorts(): Promise<RemoteHarness["ports"]> {
  return {
    auth: await findFreePort(),
    firestore: await findFreePort(),
    functions: await findFreePort(),
    relay: await findFreePort(),
    server: await findFreePort(),
    ui: await findFreePort()
  };
}

function firebasePortInput(ports: RemoteHarness["ports"]): FirebasePortInput {
  return {
    KANNA_FIREBASE_AUTH_PORT: ports.auth,
    KANNA_FIREBASE_FIRESTORE_PORT: ports.firestore,
    KANNA_FIREBASE_FUNCTIONS_PORT: ports.functions,
    KANNA_FIREBASE_UI_PORT: ports.ui
  };
}

async function waitForRelayDesktop(input: {
  client: RelayDesktopClient;
  desktopId: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const status = await Promise.race([
        input.client.invokeDesktop({
          desktopId: input.desktopId,
          method: "GET",
          path: "/v1/status",
          body: null
        }),
        sleep(2_000).then(() => {
          throw new Error("desktop status invoke timed out");
        })
      ]);
      if (
        status &&
        typeof status === "object" &&
        "desktopId" in status &&
        status.desktopId === input.desktopId
      ) {
        return;
      }
      lastError = `unexpected status response ${JSON.stringify(status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for relay desktop ${input.desktopId}: ${lastError}`);
}

async function buildBinaries(repoRoot: string): Promise<void> {
  await runCommand("pnpm", ["--dir", "services/firebase-functions", "build"], {
    cwd: repoRoot,
    env: process.env
  });
  await runCommand("pnpm", ["--dir", "services/relay", "build"], {
    cwd: repoRoot,
    env: process.env
  });
  await runCommand("cargo", ["build", "-p", "kanna-server", "-p", "kanna-daemon"], {
    cwd: repoRoot,
    env: process.env
  });
}

async function writeServerConfig(input: {
  configPath: string;
  daemonDir: string;
  dbPath: string;
  desktopId: string;
  ports: RemoteHarness["ports"];
}): Promise<void> {
  await mkdir(dirname(input.configPath), { recursive: true });
  await writeFile(
    input.configPath,
    [
      `relay_url = "ws://127.0.0.1:${input.ports.relay}"`,
      `device_token = "${DEVICE_TOKEN}"`,
      `firebase_project_id = "kanna-local"`,
      `firebase_auth_emulator_url = "http://127.0.0.1:${input.ports.auth}"`,
      `firebase_firestore_emulator_host = "127.0.0.1:${input.ports.firestore}"`,
      `daemon_dir = "${shellTomlString(input.daemonDir)}"`,
      `db_path = "${shellTomlString(input.dbPath)}"`,
      `desktop_id = "${input.desktopId}"`,
      `desktop_name = "${DESKTOP_NAME}"`,
      `server_version = "remote-e2e"`,
      `lan_host = "127.0.0.1"`,
      `lan_port = ${input.ports.server}`,
      `pairing_store_path = "${shellTomlString(join(input.daemonDir, "pairings.json"))}"`
    ].join("\n")
  );
}

export async function startRemoteHarness(options: RemoteHarnessOptions = {}): Promise<RemoteHarness> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const root = await mkdtemp(join(tmpdir(), "kanna-remote-e2e-"));
  const ports = await allocatePorts();
  const desktopId = `remote-e2e-${process.pid}-${Date.now()}`;
  const configPath = join(root, "server.toml");
  const daemonDir = join(root, "daemon");
  const dbPath = join(root, "kanna.sqlite3");
  const processes: ManagedProcess[] = [];
  let relayProcess: ManagedProcess | null = null;
  let client: RelayDesktopClient | null = null;
  let stopped = false;

  const startRelay = async () => {
    if (relayProcess?.process.exitCode === null && relayProcess.process.signalCode === null) {
      return;
    }
    relayProcess = startManagedProcess("relay", "node", ["dist/index.js"], {
      cwd: join(repoRoot, "services/relay"),
      env: {
        ...process.env,
        FIREBASE_PROJECT_ID: "kanna-local",
        FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.auth}`,
        FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`,
        PORT: String(ports.relay)
      }
    });
    processes.push(relayProcess);
    await waitForHttpOk(`http://127.0.0.1:${ports.relay}/health`, timeoutMs);
  };

  const stopRelay = async () => {
    const processHandle = relayProcess;
    if (!processHandle) {
      return;
    }
    relayProcess = null;
    const index = processes.indexOf(processHandle);
    if (index >= 0) {
      processes.splice(index, 1);
    }
    await processHandle.stop();
  };

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    client?.close();
    for (const processHandle of [...processes].reverse()) {
      await processHandle.stop();
    }
    if (!options.keepArtifacts) {
      await rm(root, { recursive: true, force: true });
    }
  };

  try {
    await mkdir(daemonDir, { recursive: true });
    await buildBinaries(repoRoot);
    await createHarnessDatabase(repoRoot, dbPath);
    await writeServerConfig({ configPath, daemonDir, dbPath, desktopId, ports });

    const firebaseConfigPath = writeFirebaseEmulatorConfig(repoRoot, firebasePortInput(ports));
    processes.push(startManagedProcess(
      "firebase",
      "pnpm",
      buildFirebaseEmulatorArgs(firebaseConfigPath, []),
      {
        cwd: repoRoot,
        env: buildFirebaseCommandEnv(repoRoot, process.env)
      }
    ));
    const idToken = await waitForBuffyIdToken(ports.auth, timeoutMs);

    await startRelay();

    processes.push(startManagedProcess("daemon", join(repoRoot, ".build/debug/kanna-daemon"), [], {
      cwd: repoRoot,
      env: {
        ...process.env,
        KANNA_DAEMON_DIR: daemonDir
      }
    }));
    await waitForFile(join(daemonDir, "daemon.pid"), timeoutMs);

    processes.push(startManagedProcess("kanna-server", join(repoRoot, ".build/debug/kanna-server"), [], {
      cwd: repoRoot,
      env: {
        ...process.env,
        KANNA_SERVER_CONFIG: configPath,
        RUST_LOG: process.env.RUST_LOG ?? "info"
      }
    }));
    await waitForHttpOk(`http://127.0.0.1:${ports.server}/v1/status`, timeoutMs);

    client = createNodeRelayDesktopClient({
      relayUrl: `ws://127.0.0.1:${ports.relay}`,
      getIdToken: async () => idToken
    });
    await waitForRelayDesktop({ client, desktopId, timeoutMs });

    const harness: RemoteHarness = {
      client,
      desktopId,
      lanBaseUrl: `http://127.0.0.1:${ports.server}`,
      repoRoot,
      paths: { configPath, daemonDir, dbPath, root },
      ports,
      startRelay,
      stopRelay,
      waitForDesktop: () => waitForRelayDesktop({ client: client!, desktopId, timeoutMs }),
      stop
    };
    return harness;
  } catch (error) {
    await stop();
    throw error;
  }
}
