import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  fetchStagingBuffyIdToken,
  stagingServerEnvironment,
  stagingServerTomlLines,
  type StagingBuffyCredentials
} from "./staging";
import type { RelayDesktopClient } from "../../../apps/mobile/src/lib/transports/relayClient";

export type RemoteHarnessEnvironment = "dev" | "staging";

export interface RemoteHarnessOptions {
  environment?: RemoteHarnessEnvironment;
  repoRoot?: string;
  keepArtifacts?: boolean;
  timeoutMs?: number;
}

export interface RemoteHarness {
  client: RelayDesktopClient;
  desktopId: string;
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
  restartServerWithIdentity(identity: { desktopId: string; desktopSecret?: string | null }): Promise<void>;
  relayUrl: string;
  getIdToken(): Promise<string>;
  startRelay(): Promise<void>;
  startServer(): Promise<void>;
  stopRelay(): Promise<void>;
  stopServer(): Promise<void>;
  waitForDesktop(desktopId?: string): Promise<void>;
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

async function writeRemoteHarnessFirebaseConfig(
  repoRoot: string,
  ports: RemoteHarness["ports"]
): Promise<string> {
  const configPath = writeFirebaseEmulatorConfig(repoRoot, firebasePortInput(ports));
  const eventarcPort = await findFreePort();
  const tasksPort = await findFreePort();
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const emulators = isRecord(config.emulators) ? config.emulators : {};
  config.emulators = {
    ...emulators,
    eventarc: { host: "127.0.0.1", port: eventarcPort },
    tasks: { host: "127.0.0.1", port: tasksPort }
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
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

async function waitForHttpUnavailable(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) }).catch(() => null);
    if (!response?.ok) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url} to stop responding`);
}

async function buildBinaries(repoRoot: string, environment: RemoteHarnessEnvironment): Promise<void> {
  if (environment === "dev") {
    await runCommand("pnpm", ["--dir", "services/firebase-functions", "build"], {
      cwd: repoRoot,
      env: process.env
    });
    await runCommand("pnpm", ["--dir", "services/relay", "build"], {
      cwd: repoRoot,
      env: process.env
    });
  }
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
  desktopSecret?: string | null;
  environment: RemoteHarnessEnvironment;
  stagingCredentials?: StagingBuffyCredentials;
  ports: RemoteHarness["ports"];
}): Promise<void> {
  await mkdir(dirname(input.configPath), { recursive: true });
  const lines = input.environment === "staging"
    ? stagingServerTomlLines({
        daemonDir: input.daemonDir,
        dbPath: input.dbPath,
        desktopId: input.desktopId,
        deviceToken: input.stagingCredentials?.deviceToken ?? "",
        lanPort: input.ports.server,
        pairingStorePath: join(input.daemonDir, "pairings.json")
      })
    : [
        `relay_url = "ws://127.0.0.1:${input.ports.relay}"`,
        `device_token = "${DEVICE_TOKEN}"`,
        `firebase_project_id = "kanna-local"`,
        `firebase_auth_emulator_url = "http://127.0.0.1:${input.ports.auth}"`,
        `firebase_firestore_emulator_host = "127.0.0.1:${input.ports.firestore}"`,
        `daemon_dir = "${shellTomlString(input.daemonDir)}"`,
        `db_path = "${shellTomlString(input.dbPath)}"`,
        `desktop_id = "${input.desktopId}"`,
        ...(input.desktopSecret ? [`desktop_secret = "${shellTomlString(input.desktopSecret)}"`] : []),
        `desktop_name = "${DESKTOP_NAME}"`,
        `server_version = "remote-e2e"`,
        `lan_host = "127.0.0.1"`,
        `lan_port = ${input.ports.server}`,
        `pairing_store_path = "${shellTomlString(join(input.daemonDir, "pairings.json"))}"`
      ];
  await writeFile(
    input.configPath,
    lines.join("\n")
  );
}

export async function startRemoteHarness(options: RemoteHarnessOptions = {}): Promise<RemoteHarness> {
  const environment = options.environment ?? "dev";
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const root = await mkdtemp(join(tmpdir(), "kanna-remote-e2e-"));
  const ports = await allocatePorts();
  const staging = environment === "staging" ? stagingServerEnvironment(process.env) : null;
  if (staging && !staging.ok) {
    throw new Error(`staging remote harness missing credentials: ${staging.missing.join(", ")}`);
  }
  const desktopId = staging?.desktopId ?? `remote-e2e-${process.pid}-${Date.now()}`;
  const configPath = join(root, "server.toml");
  const daemonDir = join(root, "daemon");
  const dbPath = join(root, "kanna.sqlite3");
  const processes: ManagedProcess[] = [];
  let relayProcess: ManagedProcess | null = null;
  let serverProcess: ManagedProcess | null = null;
  let client: RelayDesktopClient | null = null;
  let idToken: string | null = null;
  let stopped = false;
  let currentDesktopId = desktopId;
  let currentDesktopSecret: string | null = null;

  const startRelay = async () => {
    if (environment === "staging") {
      return;
    }
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
    processHandle.stop().catch(() => undefined);
  };

  const startServer = async () => {
    if (serverProcess?.process.exitCode === null && serverProcess.process.signalCode === null) {
      return;
    }
    serverProcess = startManagedProcess("kanna-server", join(repoRoot, ".build/debug/kanna-server"), [], {
      cwd: repoRoot,
      env: {
        ...process.env,
        KANNA_SERVER_CONFIG: configPath,
        ...(environment === "staging"
          ? {
              KANNA_CLOUD_ENV: "staging",
              KANNA_FIREBASE_PROJECT_ID: "kanna-staging",
              KANNA_RELAY_URL: "wss://relay-staging.kanna.build"
            }
          : {}),
        KANNA_E2E_TEST_SQL: "1",
        RUST_LOG: process.env.RUST_LOG ?? "info"
      }
    });
    processes.push(serverProcess);
    await waitForHttpOk(`http://127.0.0.1:${ports.server}/v1/status`, timeoutMs);
  };

  const stopServer = async () => {
    const processHandle = serverProcess;
    if (!processHandle) {
      return;
    }
    serverProcess = null;
    const index = processes.indexOf(processHandle);
    if (index >= 0) {
      processes.splice(index, 1);
    }
    await processHandle.stop();
    await waitForHttpUnavailable(`http://127.0.0.1:${ports.server}/v1/status`, timeoutMs);
  };

  const restartServerWithIdentity = async (identity: {
    desktopId: string;
    desktopSecret?: string | null;
  }) => {
    currentDesktopId = identity.desktopId;
    currentDesktopSecret = identity.desktopSecret ?? null;
    await stopServer();
    await writeServerConfig({
      configPath,
      daemonDir,
      dbPath,
      desktopId: currentDesktopId,
      desktopSecret: currentDesktopSecret,
      environment,
      stagingCredentials: staging?.credentials,
      ports
    });
    await startServer();
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
    await buildBinaries(repoRoot, environment);
    await createHarnessDatabase(repoRoot, dbPath);
    await writeServerConfig({
      configPath,
      daemonDir,
      dbPath,
      desktopId,
      environment,
      stagingCredentials: staging?.credentials,
      ports
    });

    if (environment === "dev") {
      const firebaseConfigPath = await writeRemoteHarnessFirebaseConfig(repoRoot, ports);
      processes.push(startManagedProcess(
        "firebase",
        "pnpm",
        buildFirebaseEmulatorArgs(firebaseConfigPath, []),
        {
          cwd: repoRoot,
          env: buildFirebaseCommandEnv(repoRoot, process.env)
        }
      ));
      idToken = await waitForBuffyIdToken(ports.auth, timeoutMs);
    } else if (staging) {
      idToken = await fetchStagingBuffyIdToken({
        repoRoot,
        credentials: staging.credentials
      });
    }

    await startRelay();

    processes.push(startManagedProcess("daemon", join(repoRoot, ".build/debug/kanna-daemon"), [], {
      cwd: repoRoot,
      env: {
        ...process.env,
        KANNA_DAEMON_DIR: daemonDir
      }
    }));
    await waitForFile(join(daemonDir, "daemon.pid"), timeoutMs);

    await startServer();

    const relayUrl = environment === "staging" ? "wss://relay-staging.kanna.build" : `ws://127.0.0.1:${ports.relay}`;
    client = createNodeRelayDesktopClient({
      relayUrl,
      getIdToken: async () => idToken
    });
    await waitForRelayDesktop({ client, desktopId, timeoutMs });

    const harness: RemoteHarness = {
      client,
      desktopId,
      repoRoot,
      paths: { configPath, daemonDir, dbPath, root },
      ports,
      restartServerWithIdentity,
      relayUrl,
      getIdToken: async () => {
        if (!idToken) {
          throw new Error("remote harness id token is not available");
        }
        return idToken;
      },
      startRelay,
      startServer,
      stopRelay,
      stopServer,
      waitForDesktop: (targetDesktopId = currentDesktopId) =>
        waitForRelayDesktop({ client: client!, desktopId: targetDesktopId, timeoutMs }),
      stop
    };
    return harness;
  } catch (error) {
    await stop();
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
