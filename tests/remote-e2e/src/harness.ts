import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { assertPortsAvailable, findFreePort, runCommand, startManagedProcess, waitForFile, waitForHttpOk, type ManagedProcess } from "./processes";
import { createHarnessDatabase } from "./sqlite";
import {
  fetchStagingBuffyIdToken,
  stagingServerEnvironment,
  stagingServerTomlLines,
  type StagingBuffyCredentials
} from "./staging";
import {
  createDesktopPairingSession as requestDesktopPairingSession,
  type DesktopPairingSession
} from "./desktopPairing";
import {
  writeScriptedAgentBinary,
  writeScriptedClaudeStatusAgentBinary
} from "./scriptedAgent";
import { AGENT_PROVIDER_SPECS } from "../../../packages/agent-protocol/src/index";
import type { RelayDesktopClient } from "../../../apps/mobile/src/lib/transports/relayClient";

export type RemoteHarnessEnvironment = "dev" | "staging";

export interface RemoteHarnessOptions {
  environment?: RemoteHarnessEnvironment;
  lanHost?: string;
  repoRoot?: string;
  keepArtifacts?: boolean;
  timeoutMs?: number;
}

export interface RemoteHarness {
  client: RelayDesktopClient;
  createDesktopPairingSession(): Promise<DesktopPairingSession>;
  desktopId: string;
  lanBaseUrl: string;
  repoRoot: string;
  paths: {
    configPath: string;
    daemonDir: string;
    dbPath: string;
    fakeAgentBinDir: string;
    root: string;
    zshStartupDir: string;
  };
  ports: {
    auth: number;
    firestore: number;
    functions: number;
    relay: number;
    server: number;
    transfer: number;
    ui: number;
  };
  relayUrl: string;
  serverLogs(): string;
  getIdToken(): Promise<string>;
  restartServerWithIdentity(identity: { desktopId: string; desktopSecret?: string | null }): Promise<void>;
  restartDaemon(): Promise<void>;
  startRelay(): Promise<void>;
  startAdditionalDesktop(): Promise<RemoteDesktop>;
  startServer(): Promise<void>;
  stopRelay(): Promise<void>;
  stopServer(): Promise<void>;
  waitForDesktop(desktopId?: string): Promise<void>;
  stop(): Promise<void>;
}

/** A second server/daemon pair sharing this harness's relay and Firebase account. */
export interface RemoteDesktop {
  client: RelayDesktopClient;
  desktopId: string;
  lanBaseUrl: string;
  repoRoot: string;
  paths: Pick<RemoteHarness["paths"], "dbPath" | "root">;
  serverLogs(): string;
  stop(): Promise<void>;
}

const DEVICE_TOKEN = "e2e-token";
const DESKTOP_NAME = "Remote E2E Desktop";
/** Every provider executable `kanna-server` probes; see `serverProviderPath`. */
const AGENT_PROVIDER_EXECUTABLES = AGENT_PROVIDER_SPECS.map(
  (spec) => spec.executable
);

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
    transfer: await findFreePort(),
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
  await runCommand("cargo", ["build", "-p", "kanna-server", "-p", "kanna-daemon", "-p", "kanna-cli"], {
    cwd: repoRoot,
    env: process.env
  });
}

export function remoteHarnessKannaCliPath(repoRoot: string): string {
  return join(repoRoot, ".build", "debug", process.platform === "win32" ? "kanna-cli.exe" : "kanna-cli");
}

export async function writeRemoteHarnessZshStartupFiles(zshStartupDir: string): Promise<void> {
  await mkdir(zshStartupDir, { recursive: true });
  const zshEnv = [
    "# Remote E2E zsh startup file.",
    "skip_global_compinit=1",
    "unsetopt GLOBAL_RCS"
  ].join("\n") + "\n";
  const emptyStartup = "# Remote E2E zsh startup file.\n";
  await Promise.all([
    writeFile(join(zshStartupDir, ".zshenv"), zshEnv),
    writeFile(join(zshStartupDir, ".zprofile"), emptyStartup),
    writeFile(join(zshStartupDir, ".zshrc"), emptyStartup),
    writeFile(join(zshStartupDir, ".zlogin"), emptyStartup)
  ]);
}

function prependPath(pathEntry: string, existingPath: string | undefined): string {
  return existingPath ? `${pathEntry}:${existingPath}` : pathEntry;
}

/**
 * PATH for the harness's `kanna-server`, with the host's own agent CLIs
 * removed.
 *
 * The server reports which providers it can spawn by resolving each provider
 * executable, and mobile builds its agent picker from that report. Inherited
 * unchanged, a developer's Homebrew or `~/.local/bin` Claude would make the
 * reported inventory depend on the machine running the suite, so the one thing
 * these specs assert would be untestable. Only directories that actually hold a
 * provider CLI are dropped, so ordinary tooling on the same PATH survives.
 */
export function serverProviderPath(
  fakeAgentBinDir: string,
  existingPath: string | undefined,
  isProviderExecutable: (candidate: string) => boolean = (candidate) =>
    existsSync(candidate)
): string {
  const hostEntries = (existingPath ?? "")
    .split(":")
    .filter((entry) => entry.length > 0 && entry !== fakeAgentBinDir)
    .filter((entry) =>
      !AGENT_PROVIDER_EXECUTABLES.some((executable) =>
        isProviderExecutable(join(entry, executable))
      )
    );
  return [fakeAgentBinDir, ...hostEntries].join(":");
}

/**
 * Providers the harness server will find no matter what PATH it is given.
 *
 * Executable resolution deliberately also probes `/usr/local/bin` and
 * `/opt/homebrew/bin` (`kanna_runtime_defaults::find_user_binary`), because a
 * Finder-launched Kanna must find CLIs installed there. A spawn would use them,
 * so the reported inventory must include them — which means a spec cannot
 * assert an exact inventory. It asserts the harness stub is present and that
 * providers *outside* this set are absent.
 */
export function hostInstalledAgentProviders(
  isProviderExecutable: (candidate: string) => boolean = (candidate) =>
    existsSync(candidate)
): string[] {
  return AGENT_PROVIDER_SPECS.filter((spec) =>
    ["/usr/local/bin", "/opt/homebrew/bin"].some((directory) =>
      isProviderExecutable(join(directory, spec.executable))
    )
  ).map((spec) => spec.id);
}

async function writeServerConfig(input: {
  configPath: string;
  daemonDir: string;
  dbPath: string;
  desktopId: string;
  environment: RemoteHarnessEnvironment;
  lanHost: string;
  repoRoot: string;
  stagingCredentials?: StagingBuffyCredentials;
  desktopSecret?: string | null;
  ports: RemoteHarness["ports"];
}): Promise<void> {
  await mkdir(dirname(input.configPath), { recursive: true });
  const lines = input.environment === "staging"
    ? stagingServerTomlLines({
        daemonDir: input.daemonDir,
        dbPath: input.dbPath,
        desktopId: input.desktopId,
        deviceToken: input.stagingCredentials?.deviceToken ?? "",
        kannaCliPath: remoteHarnessKannaCliPath(input.repoRoot),
        lanPort: input.ports.server,
        pairingStorePath: join(input.daemonDir, "pairings.json"),
        transferPort: input.ports.transfer
      })
    : [
        `relay_url = "ws://127.0.0.1:${input.ports.relay}"`,
        `device_token = "${DEVICE_TOKEN}"`,
        `firebase_project_id = "kanna-local"`,
        `firebase_auth_emulator_url = "http://127.0.0.1:${input.ports.auth}"`,
        `firebase_firestore_emulator_host = "127.0.0.1:${input.ports.firestore}"`,
        `daemon_dir = "${shellTomlString(input.daemonDir)}"`,
        `db_path = "${shellTomlString(input.dbPath)}"`,
        `kanna_cli_path = "${shellTomlString(remoteHarnessKannaCliPath(input.repoRoot))}"`,
        `desktop_id = "${input.desktopId}"`,
        ...(input.desktopSecret ? [`desktop_secret = "${shellTomlString(input.desktopSecret)}"`] : []),
        `desktop_name = "${DESKTOP_NAME}"`,
        `version = "remote-e2e"`,
        `environment = "development"`,
        `lan_host = "${shellTomlString(input.lanHost)}"`,
        `lan_port = ${input.ports.server}`,
        `transfer_port = ${input.ports.transfer}`,
        `pairing_store_path = "${shellTomlString(join(input.daemonDir, "pairings.json"))}"`
      ];
  await writeFile(
    input.configPath,
    lines.join("\n")
  );
}

export async function startRemoteHarness(options: RemoteHarnessOptions = {}): Promise<RemoteHarness> {
  const environment = options.environment ?? "dev";
  const lanHost = options.lanHost ?? "127.0.0.1";
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
  const fakeAgentBinDir = join(root, "fake-agent-bin");
  const zshStartupDir = join(root, "zsh");
  const processes: ManagedProcess[] = [];
  let relayProcess: ManagedProcess | null = null;
  let serverProcess: ManagedProcess | null = null;
  let daemonProcess: ManagedProcess | null = null;
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
      inventoryRoot: repoRoot,
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

  const startServer = async () => {
    if (serverProcess?.process.exitCode === null && serverProcess.process.signalCode === null) {
      return;
    }
    serverProcess = startManagedProcess("kanna-server", join(repoRoot, ".build/debug/kanna-server"), [], {
      cwd: repoRoot,
      inventoryRoot: repoRoot,
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
        KANNA_E2E_SHORT_CURSOR_TTL_SECS: "1",
        HOME: zshStartupDir,
        PATH: serverProviderPath(fakeAgentBinDir, process.env.PATH),
        RUST_LOG: process.env.RUST_LOG ?? "info",
        ZDOTDIR: zshStartupDir
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
      lanHost,
      repoRoot,
      stagingCredentials: staging?.credentials,
      ports
    });
    await startServer();
  };

  const launchDaemon = (): ManagedProcess => {
    const launched = startManagedProcess("daemon", join(repoRoot, ".build/debug/kanna-daemon"), [], {
      cwd: repoRoot,
      inventoryRoot: repoRoot,
      env: {
        ...process.env,
        KANNA_DAEMON_DIR: daemonDir,
        KANNA_SERVER_EXECUTABLE: join(repoRoot, ".build/debug/kanna-server"),
        HOME: zshStartupDir,
        PATH: prependPath(fakeAgentBinDir, process.env.PATH),
        ZDOTDIR: zshStartupDir
      }
    });
    processes.push(launched);
    return launched;
  };

  const restartDaemon = async (): Promise<void> => {
    const previous = daemonProcess;
    const replacement = launchDaemon();
    daemonProcess = replacement;
    const expectedPid = replacement.process.pid;
    if (!expectedPid) {
      throw new Error("replacement daemon has no pid");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const publishedPid = await readFile(join(daemonDir, "daemon.pid"), "utf8")
        .then((value) => Number(value.trim()))
        .catch(() => null);
      if (publishedPid === expectedPid) {
        return;
      }
      if (replacement.process.exitCode !== null || replacement.process.signalCode !== null) {
        throw new Error("replacement daemon exited before publishing its pid");
      }
      await sleep(100);
    }
    throw new Error(
      `replacement daemon ${expectedPid} did not publish after daemon ${String(previous?.process.pid)}`
    );
  };

  const startAdditionalDesktop = async (): Promise<RemoteDesktop> => {
    const desktopRoot = join(root, `desktop-${randomUUID()}`);
    const desktopId = `remote-e2e-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const desktopPorts = await allocatePorts();
    const desktopDaemonDir = join(desktopRoot, "daemon");
    const desktopDbPath = join(desktopRoot, "kanna.sqlite3");
    const desktopConfigPath = join(desktopRoot, "server.toml");
    let desktopServer: ManagedProcess | null = null;
    let desktopDaemon: ManagedProcess | null = null;
    await mkdir(desktopDaemonDir, { recursive: true });
    await createHarnessDatabase(repoRoot, desktopDbPath);
    await writeServerConfig({
      configPath: desktopConfigPath,
      daemonDir: desktopDaemonDir,
      dbPath: desktopDbPath,
      desktopId,
      environment,
      lanHost,
      repoRoot,
      stagingCredentials: staging?.credentials,
      // The second desktop deliberately shares the first desktop's relay and
      // Firebase emulators; only its server/transfer ports are independent.
      ports: { ...desktopPorts, relay: ports.relay, auth: ports.auth, firestore: ports.firestore, functions: ports.functions, ui: ports.ui }
    });
    desktopDaemon = launchDaemonFor(desktopDaemonDir);
    processes.push(desktopDaemon);
    await waitForFile(join(desktopDaemonDir, "daemon.pid"), timeoutMs);
    desktopServer = startServerFor(desktopConfigPath);
    processes.push(desktopServer);
    await waitForHttpOk(`http://127.0.0.1:${desktopPorts.server}/v1/status`, timeoutMs);
    await waitForRelayDesktop({ client: client!, desktopId, timeoutMs });
    return {
      client: client!,
      desktopId,
      lanBaseUrl: `http://127.0.0.1:${desktopPorts.server}`,
      repoRoot,
      paths: { dbPath: desktopDbPath, root: desktopRoot },
      serverLogs: () => desktopServer?.logs() ?? "",
      stop: async () => {
        for (const processHandle of [desktopServer, desktopDaemon]) {
          if (!processHandle) continue;
          const index = processes.indexOf(processHandle);
          if (index >= 0) processes.splice(index, 1);
          await processHandle.stop();
        }
        if (!options.keepArtifacts) await rm(desktopRoot, { recursive: true, force: true });
      }
    };
  };

  const launchDaemonFor = (targetDaemonDir: string): ManagedProcess => startManagedProcess(
    "daemon",
    join(repoRoot, ".build/debug/kanna-daemon"), [], {
      cwd: repoRoot, inventoryRoot: repoRoot,
      env: { ...process.env, KANNA_DAEMON_DIR: targetDaemonDir,
        KANNA_SERVER_EXECUTABLE: join(repoRoot, ".build/debug/kanna-server"),
        HOME: zshStartupDir, PATH: prependPath(fakeAgentBinDir, process.env.PATH), ZDOTDIR: zshStartupDir }
    }
  );

  const startServerFor = (targetConfigPath: string): ManagedProcess => startManagedProcess(
    "kanna-server", join(repoRoot, ".build/debug/kanna-server"), [], {
      cwd: repoRoot, inventoryRoot: repoRoot,
      env: { ...process.env, KANNA_SERVER_CONFIG: targetConfigPath,
        ...(environment === "staging" ? { KANNA_CLOUD_ENV: "staging", KANNA_FIREBASE_PROJECT_ID: "kanna-staging", KANNA_RELAY_URL: "wss://relay-staging.kanna.build" } : {}),
        KANNA_E2E_TEST_SQL: "1", KANNA_E2E_SHORT_CURSOR_TTL_SECS: "1", HOME: zshStartupDir,
        PATH: serverProviderPath(fakeAgentBinDir, process.env.PATH), RUST_LOG: process.env.RUST_LOG ?? "info", ZDOTDIR: zshStartupDir }
    }
  );

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
    await mkdir(fakeAgentBinDir, { recursive: true });
    await Promise.all([
      writeScriptedAgentBinary(join(fakeAgentBinDir, "codex")),
      writeScriptedClaudeStatusAgentBinary(join(fakeAgentBinDir, "claude"))
    ]);
    await writeRemoteHarnessZshStartupFiles(zshStartupDir);
    await buildBinaries(repoRoot, environment);
    await createHarnessDatabase(repoRoot, dbPath);
    await writeServerConfig({
      configPath,
      daemonDir,
      dbPath,
      desktopId,
      environment,
      lanHost,
      repoRoot,
      stagingCredentials: staging?.credentials,
      ports
    });

    if (environment === "dev") {
      await assertPortsAvailable([
        { name: "Firebase Auth", port: ports.auth },
        { name: "Firebase Firestore", port: ports.firestore },
        { name: "Firebase Functions", port: ports.functions },
        { name: "Firebase UI", port: ports.ui },
      ]);
      const firebaseConfigPath = await writeRemoteHarnessFirebaseConfig(repoRoot, ports);
      processes.push(startManagedProcess(
        "firebase",
        "pnpm",
        buildFirebaseEmulatorArgs(firebaseConfigPath, []),
        {
          cwd: repoRoot,
          inventoryRoot: repoRoot,
          env: buildFirebaseCommandEnv(repoRoot, process.env)
        }
      ));
      idToken = await waitForBuffyIdToken(ports.auth, timeoutMs, { logDirectory: repoRoot });
    } else if (staging) {
      idToken = await fetchStagingBuffyIdToken({
        repoRoot,
        credentials: staging.credentials
      });
    }

    await startRelay();

    daemonProcess = launchDaemon();
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
      createDesktopPairingSession: () =>
        requestDesktopPairingSession(`http://127.0.0.1:${ports.server}`),
      desktopId,
      lanBaseUrl: `http://127.0.0.1:${ports.server}`,
      repoRoot,
      paths: { configPath, daemonDir, dbPath, fakeAgentBinDir, root, zshStartupDir },
      ports,
      relayUrl,
      serverLogs: () => serverProcess?.logs() ?? "",
      getIdToken: async () => {
        if (!idToken) {
          throw new Error("remote harness id token is not available");
        }
        return idToken;
      },
      restartServerWithIdentity,
      restartDaemon,
      startRelay,
      startAdditionalDesktop,
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
