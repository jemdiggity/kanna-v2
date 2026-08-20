import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, basename, join, posix, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { processInventoryPath, recordInventoryResource, removeInventoryResource } from "../../../../tools/kd/src/runtime/process-inventory";
import { fileURLToPath } from "node:url";
import { realE2eTierFiles } from "./realTiers";
import { buildRealE2eAgentEnv } from "./runEnv";
import { createInstanceConfig, type InstanceConfig } from "./runConfig";
import {
  buildAgentProviderIsolationEnv,
  composeInstanceStartEnv,
} from "./agentProviderIsolation";
import { pauseBeforeTestTarget, pauseForAppReady } from "./helpers/runSlowMode";
import {
  isRealTestTarget,
  relayStartupReportedListening,
  shouldStartInitialInstances,
  targetNeedsEmulators,
  targetNeedsIsolatedAgentProviders,
  targetNeedsPlaywrightChromium,
  targetNeedsRelay,
  targetNeedsRelayControl,
  targetNeedsSecondaryInstance,
  resolveRelayControlOperation,
} from "./runPlan";
import { assertPlaywrightChromiumAvailable } from "./playwrightPreflight";
import { createPortAllocator } from "./runPorts";
import {
  classifyAppStartup,
  describeAppStartupFailure,
  WRONG_URL_GRACE_MS,
  type AppStartupProbe,
} from "./runStartup";
import { APP_READY_SCRIPT } from "./helpers/appReady";
import {
  buildFirebaseCommandEnv,
  buildFirebaseEmulatorCommand,
  buildFirebaseEmulatorConfig,
  buildFirebaseEmulatorConfigPath,
} from "../../../../tools/kd/src/runtime/firebase";

interface CommandOptions {
  cwd: string;
  env: Record<string, string>;
}

interface RunningInstances {
  primary: InstanceConfig;
  secondary: InstanceConfig | null;
}

function sanitizeSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function agentCliVersionFixtureEnv(): Record<string, string> {
  return {
    KANNA_E2E_AGENT_CLI_VERSION_CLAUDE: "2.1.118 (Claude Code)\n",
    KANNA_E2E_AGENT_CLI_VERSION_COPILOT: "GitHub Copilot CLI 1.0.32.\nRun 'copilot update' to check for updates.\n",
    KANNA_E2E_AGENT_CLI_VERSION_CODEX: "codex-cli 0.125.0-beta.1+20260429\n",
    KANNA_E2E_AGENT_CLI_VERSION_OPENCODE: "1.4.3\n",
  };
}

async function setupIsolatedCodexHome(destination: string): Promise<string> {
  const source = process.env.CODEX_HOME || join(homedir(), ".codex");
  await rm(destination, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(destination, { recursive: true });

  for (const filename of ["auth.json", "config.toml", "models_cache.json"]) {
    await copyFile(join(source, filename), join(destination, filename)).catch(() => undefined);
  }

  let latestVersion = "0.0.0";
  try {
    const versionOutput = await new Promise<string>((resolveVersion) => {
      const proc = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      proc.once("exit", () => resolveVersion(output.trim()));
      proc.once("error", () => resolveVersion(""));
    });
    latestVersion = versionOutput.split(/\s+/).at(-1) || latestVersion;
  } catch {
    latestVersion = "0.0.0";
  }

  await writeFile(
    join(destination, "version.json"),
    JSON.stringify({
      latest_version: latestVersion,
      last_checked_at: new Date().toISOString(),
      dismissed_version: latestVersion,
    }),
  );

  return destination;
}

async function runCommand(
  command: string[],
  options: CommandOptions,
): Promise<void> {
  const [file, ...args] = command;
  const proc = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  await new Promise<void>((resolveCommand, reject) => {
    proc.once("error", reject);
    proc.once("exit", (exitCode, signal) => {
      if (exitCode === 0) {
        resolveCommand();
        return;
      }
      if (signal) {
        reject(new Error(`${command.join(" ")} exited with signal ${signal}`));
        return;
      }
      reject(new Error(`${command.join(" ")} exited with code ${exitCode ?? "unknown"}`));
    });
  });
}

function toSpawnEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...overrides };
}

async function resolveTestTargets(
  e2eRoot: string,
  suite?: string,
): Promise<string[]> {
  const normalized = suite?.replace(/\\/g, "/");
  if (!normalized) {
    return [
      ...(await resolveTestTargets(e2eRoot, "mock/")),
      ...(await resolveTestTargets(e2eRoot, "real/")),
    ];
  }
  if (normalized === "real-unattended" || normalized === "real-operator") {
    const tier = normalized === "real-unattended" ? "unattended" : "operator";
    return realE2eTierFiles(tier).map((file) => toDesktopRelativeTarget(`real/${file}`));
  }
  if (normalized.endsWith(".test.ts")) {
    return [toDesktopRelativeTarget(normalized)];
  }

  const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
  const files: string[] = [];
  const prefixPath = join(e2eRoot, prefix);
  await collectTestFiles(prefixPath, prefix, files).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  });
  files.sort();
  return files;
}

async function collectTestFiles(
  absoluteDir: string,
  relativeDir: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = posix.join(relativeDir.replace(/\\/g, "/"), entry.name);
    if (entry.isDirectory()) {
      await collectTestFiles(join(absoluteDir, entry.name), relativePath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(toDesktopRelativeTarget(relativePath));
    }
  }
}

function toDesktopRelativeTarget(path: string): string {
  return posix.join("tests", "e2e", path.replace(/\\/g, "/"));
}

async function probeApp(baseUrl: string): Promise<AppStartupProbe> {
  const status = await fetch(`${baseUrl}/status`).catch(() => null);
  if (!status?.ok) return { webdriverReady: false, url: null, appReady: false };

  const session = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: {} }),
  }).then((response) => response.json()).catch(() => null);

  const sessionId = session?.value?.sessionId;
  if (!sessionId) return { webdriverReady: true, url: null, appReady: false };

  try {
    const location = await fetch(`${baseUrl}/session/${sessionId}/url`)
      .then((response) => response.json())
      .catch(() => null);
    const vueCheck = await fetch(`${baseUrl}/session/${sessionId}/execute/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script: `return ${APP_READY_SCRIPT};`,
        args: [],
      }),
    }).then((response) => response.json());
    return {
      webdriverReady: true,
      url: typeof location?.value === "string" ? location.value : null,
      appReady: Boolean(vueCheck?.value),
    };
  } finally {
    await fetch(`${baseUrl}/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
  }
}

async function captureDesktopPane(sessionName: string): Promise<string> {
  return await new Promise<string>((resolveLog) => {
    const proc = spawn(
      "tmux",
      ["-L", sessionName, "capture-pane", "-p", "-S", "-200", "-t", `${sessionName}:desktop`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.once("error", () => resolveLog(""));
    proc.once("exit", () => resolveLog(output));
  });
}

async function waitForApp(instance: InstanceConfig, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let probe: AppStartupProbe | null = null;
  let wrongUrlSince: number | null = null;

  while (Date.now() < deadline) {
    probe = await probeApp(instance.baseUrl);
    const state = classifyAppStartup(probe, instance.devUrl);
    if (state === "ready") return;
    if (state === "wrong-url") {
      wrongUrlSince ??= Date.now();
      if (Date.now() - wrongUrlSince >= WRONG_URL_GRACE_MS) {
        throw new Error(
          describeAppStartupFailure({
            baseUrl: instance.baseUrl,
            expectedUrl: instance.devUrl,
            probe,
            reason: "wrong-url",
            paneLog: await captureDesktopPane(instance.sessionName),
          }),
        );
      }
    } else {
      wrongUrlSince = null;
    }
    await sleep(1000);
  }

  throw new Error(
    describeAppStartupFailure({
      baseUrl: instance.baseUrl,
      expectedUrl: instance.devUrl,
      probe,
      reason: "timeout",
      paneLog: await captureDesktopPane(instance.sessionName),
    }),
  );
}

function needsSecondaryInstance(testTargets: string[]): boolean {
  return testTargets.some(targetNeedsSecondaryInstance);
}

function targetNeedsAuthIndexedDbOpenFailure(testTarget: string): boolean {
  return /real\/auth-indexeddb-fallback\.test\.ts$/.test(testTarget);
}

function targetNeedsStaleNativeWindowState(testTarget: string): boolean {
  return /real\/startup-window-size\.test\.ts$/.test(testTarget);
}

async function seedStaleNativeWindowStateForStartup(repoRoot: string): Promise<() => Promise<void>> {
  const windowStatePath = join(homedir(), "Library", "Application Support", "build.kanna", ".window-state.json");
  const backupPath = join(
    repoRoot,
    ".kanna-daemon-e2e",
    `window-state-backup-${process.pid}-${Date.now()}.json`,
  );
  await mkdir(dirname(windowStatePath), { recursive: true });
  await mkdir(dirname(backupPath), { recursive: true });

  let hadExistingState = true;
  await copyFile(windowStatePath, backupPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      hadExistingState = false;
      return;
    }
    throw error;
  });

  await writeFile(
    windowStatePath,
    JSON.stringify(
      {
        main: {
          width: 180,
          height: 120,
          x: 24,
          y: 24,
          prev_x: 24,
          prev_y: 24,
          maximized: false,
          visible: true,
          decorated: true,
          fullscreen: false,
        },
      },
      null,
      2,
    ),
  );

  return async () => {
    await rm(windowStatePath, { force: true }).catch(() => undefined);
    if (hadExistingState) {
      await copyFile(backupPath, windowStatePath).catch(() => undefined);
    }
    await rm(backupPath, { force: true }).catch(() => undefined);
  };
}

function buildInstanceConfig(input: {
  daemonDir: string;
  dbName: string;
  devPortEnvValue: number;
  effectiveWebDriverPort: number;
  envOverrides?: Record<string, string>;
  mobileServerPortEnvValue: number;
  sessionName: string;
  transferPortEnvValue: number;
  webDriverPortEnvValue: number;
}): InstanceConfig {
  const env = toSpawnEnv({
    KANNA_DAEMON_DIR: input.daemonDir,
    KANNA_DB_NAME: input.dbName,
    KANNA_DEV_PORT: String(input.devPortEnvValue),
    KANNA_MOBILE_SERVER_PORT: String(input.mobileServerPortEnvValue),
    KANNA_TMUX_SESSION: input.sessionName,
    KANNA_TRANSFER_PORT: String(input.transferPortEnvValue),
    KANNA_WEBDRIVER_PORT: String(input.webDriverPortEnvValue),
    ...input.envOverrides,
  });

  return createInstanceConfig({
    daemonDir: input.daemonDir,
    dbName: input.dbName,
    devPortEnvValue: input.devPortEnvValue,
    effectiveWebDriverPort: input.effectiveWebDriverPort,
    env,
    mobileServerPortEnvValue: input.mobileServerPortEnvValue,
    sessionName: input.sessionName,
    transferPortEnvValue: input.transferPortEnvValue,
    webDriverPortEnvValue: input.webDriverPortEnvValue,
  });
}

async function main(): Promise<void> {
  const suite = process.argv[2];
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const desktopRoot = resolve(currentDir, "../..");
  const e2eRoot = join(desktopRoot, "tests", "e2e");
  const repoRoot = resolve(desktopRoot, "../..");
  const testTargets = await resolveTestTargets(e2eRoot, suite);
  if (testTargets.length === 0) {
    throw new Error(`no E2E tests matched ${suite ?? "default suites"}`);
  }
  if (testTargets.some(targetNeedsPlaywrightChromium)) {
    await assertPlaywrightChromiumAvailable();
  }
  const realE2eAgentEnv = buildRealE2eAgentEnv(testTargets, process.env);

  const enableSecondary = needsSecondaryInstance(testTargets);
  const worktreeName = sanitizeSuffix(basename(repoRoot));
  const runSuffix = sanitizeSuffix(`${process.pid}-${Date.now()}`);
  const sessionName = `kanna-e2e-${worktreeName}-${runSuffix}`;
  const transferRegistryDir = join(repoRoot, ".kanna-transfer-registry-e2e", runSuffix);
  const primaryCloudTransferRegistryDir = join(transferRegistryDir, "primary");
  const secondaryCloudTransferRegistryDir = join(transferRegistryDir, "secondary");
  const ports = createPortAllocator();
  const primaryDevPort = await ports.allocate("primary dev server", { reserveNextPort: true });
  const primaryWebDriverPort = await ports.allocate("primary webdriver");
  const primaryTransferPort = await ports.allocate("primary transfer");
  const primaryMobileServerPort = await ports.allocate("primary mobile server");
  const relayPort = await ports.allocate("relay");
  const relayControlPort = await ports.allocate("relay control");
  const relayControlCapability = randomBytes(32).toString("hex");
  const relayShutdownCapability = randomBytes(32).toString("hex");
  const firebaseAuthPort = await ports.allocate("firebase auth");
  const firebaseFirestorePort = await ports.allocate("firebase firestore");
  const firebaseFunctionsPort = await ports.allocate("firebase functions");
  const firebaseUiPort = await ports.allocate("firebase ui");
  const firebaseEnv = {
    KANNA_FIREBASE_AUTH_PORT: String(firebaseAuthPort),
    KANNA_FIREBASE_FIRESTORE_PORT: String(firebaseFirestorePort),
    KANNA_FIREBASE_FUNCTIONS_PORT: String(firebaseFunctionsPort),
    KANNA_FIREBASE_UI_PORT: String(firebaseUiPort),
    KANNA_FIREBASE_PROJECT_ID: "kanna-local",
    FIREBASE_PROJECT_ID: "kanna-local",
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${firebaseAuthPort}`,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firebaseFirestorePort}`,
    KANNA_E2E_DEVICE_TOKEN: "e2e-token",
    KANNA_E2E_AWAIT_CLOUD_PUBLISH: "1",
    KANNA_E2E_TEST_SQL: "1",
    RUST_LOG: process.env.RUST_LOG ?? "kanna_server::ksp=warn",
  };
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const relayEnv = {
    KANNA_RELAY_PORT: String(relayPort),
    KANNA_RELAY_URL: relayUrl,
  };
  const relayControlUrl =
    `http://127.0.0.1:${relayControlPort}/${relayControlCapability}`;
  const primaryDbName = `test-${worktreeName}-${runSuffix}-primary.db`;
  const primaryDaemonDir = join(repoRoot, ".kanna-daemon-e2e", runSuffix);
  const realE2eRuntimeEnv = realE2eAgentEnv.KANNA_E2E_REAL_AGENT_PROVIDER === "codex"
    ? {
        ...realE2eAgentEnv,
        CODEX_HOME: await setupIsolatedCodexHome(join(primaryDaemonDir, "codex-home")),
      }
    : realE2eAgentEnv;
  const agentCliVersionEnv = agentCliVersionFixtureEnv();
  const agentProviderIsolationEnv = testTargets.some(targetNeedsIsolatedAgentProviders)
    ? await buildAgentProviderIsolationEnv(join(primaryDaemonDir, "agent-provider-isolation"))
    : {};
  const primary = buildInstanceConfig({
    daemonDir: primaryDaemonDir,
    dbName: primaryDbName,
    devPortEnvValue: primaryDevPort,
    effectiveWebDriverPort: primaryWebDriverPort,
    envOverrides: {
      ...realE2eRuntimeEnv,
      ...firebaseEnv,
      ...relayEnv,
      KANNA_TRANSFER_DISCOVERY: "registry",
      KANNA_TRANSFER_DISPLAY_NAME: "Primary",
      KANNA_TRANSFER_PEER_ID: "peer-primary",
      KANNA_TRANSFER_REGISTRY_DIR: transferRegistryDir,
    },
    mobileServerPortEnvValue: primaryMobileServerPort,
    sessionName,
    transferPortEnvValue: primaryTransferPort,
    webDriverPortEnvValue: primaryWebDriverPort,
  });

  const secondaryDevPort = enableSecondary
    ? await ports.allocate("secondary dev server", { reserveNextPort: true })
    : null;
  const secondaryWebDriverPort = enableSecondary ? await ports.allocate("secondary webdriver") : null;
  const secondaryTransferPort = enableSecondary ? await ports.allocate("secondary transfer") : null;
  const secondaryMobileServerPort = enableSecondary
    ? await ports.allocate("secondary mobile server")
    : null;
  const secondaryDbName = enableSecondary ? `test-${worktreeName}-${runSuffix}-secondary.db` : null;
  const secondaryDaemonDir = enableSecondary
    ? join(repoRoot, ".kanna-daemon-e2e", `${runSuffix}-secondary`)
    : null;
  const secondary = enableSecondary &&
    secondaryDevPort !== null &&
    secondaryWebDriverPort !== null &&
    secondaryTransferPort !== null &&
    secondaryMobileServerPort !== null &&
    secondaryDbName !== null &&
    secondaryDaemonDir !== null
    ? buildInstanceConfig({
        daemonDir: secondaryDaemonDir,
        dbName: secondaryDbName,
        devPortEnvValue: secondaryDevPort,
        effectiveWebDriverPort: secondaryWebDriverPort,
        envOverrides: {
          ...realE2eRuntimeEnv,
          ...firebaseEnv,
          ...relayEnv,
          KANNA_TRANSFER_DISCOVERY: "registry",
          KANNA_TRANSFER_DISPLAY_NAME: "Secondary",
          KANNA_TRANSFER_PEER_ID: "peer-secondary",
          KANNA_TRANSFER_REGISTRY_DIR: transferRegistryDir,
        },
        mobileServerPortEnvValue: secondaryMobileServerPort,
        sessionName: `${sessionName}-secondary`,
        transferPortEnvValue: secondaryTransferPort,
        webDriverPortEnvValue: secondaryWebDriverPort,
      })
    : null;

  function buildPerfOutputPath(testTarget: string): string {
    const perfSuffix = sanitizeSuffix(testTarget.replace(/^tests\/e2e\//, ""));
    return join(primaryDaemonDir, `${perfSuffix}.perf.log`);
  }

  function realE2eRuntimeEnvForTarget(testTarget: string): Record<string, string> {
    return {
      ...realE2eRuntimeEnv,
      ...(/real\/cloud-task-transfer\.test\.ts$/.test(testTarget)
        ? {
            KANNA_TRANSFER_REGISTRY_DIR: primaryCloudTransferRegistryDir,
            KANNA_E2E_TARGET_TRANSFER_REGISTRY_DIR: secondaryCloudTransferRegistryDir,
          }
        : {}),
      ...(targetNeedsAuthIndexedDbOpenFailure(testTarget)
        ? { KANNA_E2E_FIREBASE_AUTH_INDEXEDDB_OPEN_FAILURE: "1" }
        : {}),
    };
  }

  function secondaryRealE2eRuntimeEnvForTarget(testTarget: string): Record<string, string> {
    return {
      ...realE2eRuntimeEnv,
      ...(/real\/cloud-task-transfer\.test\.ts$/.test(testTarget)
        ? { KANNA_TRANSFER_REGISTRY_DIR: secondaryCloudTransferRegistryDir }
        : {}),
    };
  }

  function buildTestEnv(
    testTarget: string,
    withSecondary: boolean,
    perfOutputPath: string,
    runtimeEnv: Record<string, string>,
  ): Record<string, string> {
    return toSpawnEnv({
      KANNA_DAEMON_DIR: primaryDaemonDir,
      KANNA_DB_NAME: primaryDbName,
      KANNA_DEV_PORT: String(primaryDevPort),
      KANNA_E2E_PERF_OUTPUT_PATH: perfOutputPath,
      ...relayEnv,
      ...(targetNeedsRelayControl(testTarget)
        ? { KANNA_E2E_RELAY_CONTROL_URL: relayControlUrl }
        : {}),
      KANNA_TRANSFER_REGISTRY_DIR: transferRegistryDir,
      KANNA_WEBDRIVER_PORT: String(primaryWebDriverPort),
      ...firebaseEnv,
      ...runtimeEnv,
      ...(withSecondary && secondary
        ? { KANNA_E2E_TARGET_WEBDRIVER_PORT: String(secondary.webDriverPort) }
        : {}),
    });
  }

  async function startInstances(
    withSecondary: boolean,
    useAgentCliFixtures: boolean,
    runtimeEnv: Record<string, string> = realE2eRuntimeEnv,
    isolateAgentProviders = false,
    secondaryRuntimeEnv: Record<string, string> = runtimeEnv,
  ): Promise<RunningInstances> {
    await Promise.all([
      ports.handoff(primary.devPort),
      ports.handoff(primary.webDriverPort),
      ports.handoff(primary.transferPort),
      ports.handoff(primary.mobileServerPort),
    ]);
    await runCommand(primary.startCommand, {
      cwd: repoRoot,
      env: composeInstanceStartEnv({
        baseEnv: primary.env,
        runtimeEnv,
        agentCliVersionEnv,
        agentProviderIsolationEnv,
        useAgentCliFixtures,
        isolateAgentProviders,
      }),
    });
    console.log(`[e2e] waiting for primary app at ${primary.baseUrl}`);
    await waitForApp(primary, 10 * 60_000);
    console.log(`[e2e] primary app ready at ${primary.baseUrl}`);
    await pauseForAppReady("primary");

    const secondaryInstance = withSecondary ? secondary : null;
    if (secondaryInstance) {
      await Promise.all([
        ports.handoff(secondaryInstance.devPort),
        ports.handoff(secondaryInstance.webDriverPort),
        ports.handoff(secondaryInstance.transferPort),
        ports.handoff(secondaryInstance.mobileServerPort),
      ]);
      await runCommand(secondaryInstance.startCommand, {
        cwd: repoRoot,
        env: composeInstanceStartEnv({
          baseEnv: secondaryInstance.env,
          runtimeEnv: secondaryRuntimeEnv,
          agentCliVersionEnv,
          agentProviderIsolationEnv,
          useAgentCliFixtures,
          isolateAgentProviders,
        }),
      });
      console.log(`[e2e] waiting for secondary app at ${secondaryInstance.baseUrl}`);
      await waitForApp(secondaryInstance, 10 * 60_000);
      console.log(`[e2e] secondary app ready at ${secondaryInstance.baseUrl}`);
      await pauseForAppReady("secondary");
    }

    return { primary, secondary: secondaryInstance };
  }

  async function stopInstances(instances: RunningInstances | null): Promise<void> {
    if (!instances) return;

    if (instances.secondary) {
      await runCommand(instances.secondary.stopCommand, {
        cwd: repoRoot,
        env: instances.secondary.env,
      }).catch(() => undefined);
    }
    await runCommand(instances.primary.stopCommand, {
      cwd: repoRoot,
      env: instances.primary.env,
    }).catch(() => undefined);
  }

  async function resetTransferRegistry(): Promise<void> {
    await rm(transferRegistryDir, { recursive: true, force: true }).catch(() => undefined);
  }

  let firebaseEmulatorProcess: ReturnType<typeof spawn> | null = null;
  let firebaseEmulatorOutput = "";

  async function startFirebaseEmulators(): Promise<void> {
    if (firebaseEmulatorProcess) return;

    await Promise.all([
      ports.handoff(firebaseAuthPort),
      ports.handoff(firebaseFirestorePort),
      ports.handoff(firebaseFunctionsPort),
      ports.handoff(firebaseUiPort),
    ]);

    firebaseEmulatorOutput = "";
    const configPath = buildFirebaseEmulatorConfigPath(repoRoot, firebaseFirestorePort);
    await writeFile(
      configPath,
      JSON.stringify(
        buildFirebaseEmulatorConfig({
          KANNA_FIREBASE_AUTH_PORT: firebaseAuthPort,
          KANNA_FIREBASE_FIRESTORE_PORT: firebaseFirestorePort,
          KANNA_FIREBASE_FUNCTIONS_PORT: firebaseFunctionsPort,
          KANNA_FIREBASE_UI_PORT: firebaseUiPort,
        }),
        null,
        2,
      ),
    );
    await runCommand(["pnpm", "--dir", "services/firebase-functions", "build"], {
      cwd: repoRoot,
      env: primary.env,
    });

    const emulatorCommand = buildFirebaseEmulatorCommand(configPath);
    const proc = spawn(emulatorCommand.command, emulatorCommand.args, {
      cwd: repoRoot,
      env: buildFirebaseCommandEnv(repoRoot, { ...primary.env, ...firebaseEnv }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    firebaseEmulatorProcess = proc;
    if (proc.pid) recordInventoryResource(processInventoryPath(repoRoot), { kind: "process", pid: proc.pid, label: "desktop-e2e-firebase" });
    proc.stdout?.on("data", (chunk: Buffer) => {
      firebaseEmulatorOutput += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      firebaseEmulatorOutput += chunk.toString();
    });

    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    proc.once("exit", (code, signal) => {
      if (proc.pid) removeInventoryResource(processInventoryPath(repoRoot), { kind: "process", pid: proc.pid, label: "desktop-e2e-firebase" });
      exited = { code, signal };
      if (firebaseEmulatorProcess === proc) firebaseEmulatorProcess = null;
    });

    const authSignInUrl = `http://127.0.0.1:${firebaseAuthPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`;
    const credentials = {
      email: "upvote.sieve.7t@icloud.com",
      password: "password123",
      returnSecureToken: true,
    };
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `Firebase emulators exited before readiness: ${exited.code ?? exited.signal}\n${firebaseEmulatorOutput.trim()}`,
        );
      }

      const signInResponse = await fetch(authSignInUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      }).catch(() => null);
      if (signInResponse?.ok) return;

      await sleep(500);
    }
    throw new Error(`timed out waiting for Firebase auth emulator\n${firebaseEmulatorOutput.trim()}`);
  }

  async function stopFirebaseEmulators(): Promise<void> {
    const proc = firebaseEmulatorProcess;
    firebaseEmulatorProcess = null;
    if (proc?.pid) {
      try {
        process.kill(-proc.pid, "SIGINT");
      } catch {
        proc.kill("SIGINT");
      }
      const exited = await Promise.race([
        new Promise<boolean>((resolveExit) => proc.once("exit", () => resolveExit(true))),
        sleep(10_000).then(() => false),
      ]);
      if (!exited) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      }
      removeInventoryResource(processInventoryPath(repoRoot), { kind: "process", pid: proc.pid, label: "desktop-e2e-firebase" });
    }
    await runCommand(["./kd", "emulators", "down"], {
      cwd: repoRoot,
      env: { ...primary.env, ...firebaseEnv },
    }).catch(() => undefined);
  }

  let relayProcess: ReturnType<typeof spawn> | null = null;
  let relayOutput = "";
  const relayHealthUrl = `http://127.0.0.1:${relayPort}/health`;

  async function relayHealthy(): Promise<boolean> {
    const response = await fetch(relayHealthUrl, {
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);
    return response?.ok === true;
  }

  async function relayPortOpen(): Promise<boolean> {
    return await new Promise<boolean>((resolveOpen) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: relayPort,
      });
      let settled = false;
      const finish = (open: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolveOpen(open);
      };
      socket.setTimeout(1_000, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  }

  async function waitForRelayPortClosed(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!await relayPortOpen()) return true;
      await sleep(100);
    }
    return !await relayPortOpen();
  }

  async function waitForRelayChildExit(
    proc: ReturnType<typeof spawn>,
    timeoutMs: number,
  ): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return true;
    return await new Promise<boolean>((resolveExit) => {
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        proc.off("exit", onExit);
        proc.off("error", onError);
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const onError = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      proc.once("exit", onExit);
      proc.once("error", onError);
    });
  }

  async function startRelay(): Promise<void> {
    if (relayProcess) return;

    await ports.handoff(relayPort);

    relayOutput = "";
    let startupOutput = "";
    const proc = spawn("pnpm", ["--dir", "services/relay", "run", "dev"], {
      cwd: repoRoot,
      env: {
        ...primary.env,
        ...firebaseEnv,
        ...relayEnv,
        PORT: String(relayPort),
        KANNA_E2E_RELAY_SHUTDOWN_TOKEN: relayShutdownCapability,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    relayProcess = proc;
    if (proc.pid) recordInventoryResource(processInventoryPath(repoRoot), { kind: "process", pid: proc.pid, label: "desktop-e2e-relay" });
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      startupOutput += text;
      relayOutput += text;
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      startupOutput += text;
      relayOutput += text;
    });

    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let spawnError: Error | null = null;
    proc.once("error", (error) => {
      if (proc.pid) removeInventoryResource(processInventoryPath(repoRoot), { kind: "process", pid: proc.pid, label: "desktop-e2e-relay" });
      spawnError = error;
      if (relayProcess === proc) relayProcess = null;
    });
    proc.once("exit", (code, signal) => {
      if (proc.pid) removeInventoryResource(processInventoryPath(repoRoot), { kind: "process", pid: proc.pid, label: "desktop-e2e-relay" });
      exited = { code, signal };
      if (relayProcess === proc) relayProcess = null;
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(
          `Relay failed to spawn: ${spawnError.message}\n${startupOutput.trim()}`,
        );
      }
      if (exited) {
        throw new Error(
          `Relay exited before readiness: ${exited.code ?? exited.signal}\n${startupOutput.trim()}`,
        );
      }
      if (
        relayStartupReportedListening(startupOutput, relayPort) &&
        await relayHealthy()
      ) {
        await sleep(100);
        if (exited) {
          throw new Error(
            `Relay exited after reporting readiness: ${exited.code ?? exited.signal}\n${startupOutput.trim()}`,
          );
        }
        if (await relayHealthy()) return;
      }
      await sleep(250);
    }

    throw new Error(
      `timed out waiting for owned relay listener at ${relayHealthUrl}\n${startupOutput.trim()}`,
    );
  }

  async function stopRelay(): Promise<void> {
    const proc = relayProcess;
    relayProcess = null;
    if (!proc?.pid) {
      // Before the relay is started this port is intentionally open through
      // the allocator's reservation. No managed child means there is nothing
      // for this lifecycle hook to stop.
      return;
    }

    const gracefulResponse = await fetch(
      `http://127.0.0.1:${relayPort}/__kanna_e2e_shutdown`,
      {
        method: "POST",
        headers: {
          "x-kanna-e2e-shutdown-token": relayShutdownCapability,
        },
        signal: AbortSignal.timeout(2_000),
      },
    ).catch(() => null);
    if (gracefulResponse?.status !== 204) {
      try {
        process.kill(-proc.pid, "SIGINT");
      } catch {
        proc.kill("SIGINT");
      }
    }
    let [childExited, portClosed] = await Promise.all([
      waitForRelayChildExit(proc, 5_000),
      waitForRelayPortClosed(5_000),
    ]);
    if (!childExited || !portClosed) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      [childExited, portClosed] = await Promise.all([
        waitForRelayChildExit(proc, 5_000),
        waitForRelayPortClosed(5_000),
      ]);
    }
    removeInventoryResource(processInventoryPath(repoRoot), { kind: "process", pid: proc.pid, label: "desktop-e2e-relay" });
    if (!childExited || !portClosed) {
      throw new Error(
        `relay shutdown incomplete (childExited=${childExited}, portClosed=${portClosed})`,
      );
    }
  }

  let relayControl = Promise.resolve();
  const relayControlServer = targetNeedsRelayControl(
    testTargets.find(targetNeedsRelayControl) ?? "",
  )
    ? createHttpServer((request, response) => {
      const requested = resolveRelayControlOperation(
        request.method,
        request.url,
        relayControlCapability,
      );
      const operation = requested === "disconnect"
        ? stopRelay
        : requested === "reconnect"
          ? startRelay
          : null;
      if (!operation) {
        response.writeHead(404).end();
        return;
      }
      relayControl = relayControl.catch(() => undefined).then(operation);
      void relayControl.then(
        () => response.writeHead(204).end(),
        (error: unknown) => {
          response.writeHead(500, { "Content-Type": "text/plain" });
          response.end(error instanceof Error ? error.message : "relay control failed");
        },
      );
    })
    : null;
  if (relayControlServer) {
    await ports.handoff(relayControlPort);
    await new Promise<void>((resolveListen, reject) => {
      relayControlServer.once("error", reject);
      relayControlServer.listen(relayControlPort, "127.0.0.1", resolveListen);
    });
  }

  let runningInstances: RunningInstances | null = null;
  let runningMockAgentProviderIsolation: boolean | null = null;
  let lastTargetWasReal = false;
  const cleanupAppDataHooks: Array<() => Promise<void>> = [];

  try {
    if (shouldStartInitialInstances(testTargets[0])) {
      const isolateAgentProviders = targetNeedsIsolatedAgentProviders(testTargets[0] ?? "");
      runningInstances = await startInstances(false, true, realE2eRuntimeEnv, isolateAgentProviders);
      runningMockAgentProviderIsolation = isolateAgentProviders;
    }

    for (const testTarget of testTargets) {
      const targetIsReal = isRealTestTarget(testTarget);
      const isolateAgentProviders = targetNeedsIsolatedAgentProviders(testTarget);
      const needsSecondaryForTarget = targetNeedsSecondaryInstance(testTarget);
      const needsEmulatorsForTarget = targetNeedsEmulators(testTarget);
      if (targetIsReal) {
        if (!lastTargetWasReal) {
          console.log("\n[e2e] restarting app instances before real test isolation\n");
        } else {
          console.log("\n[e2e] restarting app instances between real tests\n");
        }
        await stopInstances(runningInstances);
        await resetTransferRegistry();
        if (needsEmulatorsForTarget) await startFirebaseEmulators();
        if (targetNeedsRelay(testTarget)) await startRelay();
        if (targetNeedsStaleNativeWindowState(testTarget)) {
          cleanupAppDataHooks.push(await seedStaleNativeWindowStateForStartup(repoRoot));
        }
        runningInstances = await startInstances(
          needsSecondaryForTarget,
          false,
          realE2eRuntimeEnvForTarget(testTarget),
          isolateAgentProviders,
          secondaryRealE2eRuntimeEnvForTarget(testTarget),
        );
        runningMockAgentProviderIsolation = null;
      } else if (runningMockAgentProviderIsolation !== isolateAgentProviders) {
        await stopInstances(runningInstances);
        runningInstances = await startInstances(
          false,
          true,
          realE2eRuntimeEnv,
          isolateAgentProviders,
        );
        runningMockAgentProviderIsolation = isolateAgentProviders;
      } else if (runningInstances?.secondary && !needsSecondaryForTarget) {
        await stopInstances(runningInstances);
        runningInstances = await startInstances(false, !targetIsReal);
      }
      await pauseBeforeTestTarget(testTarget);
      console.log(`\n[e2e] running ${testTarget}\n`);
      const perfOutputPath = buildPerfOutputPath(testTarget);
      await rm(perfOutputPath, { force: true }).catch(() => undefined);
      try {
        await runCommand(
          ["pnpm", "exec", "vitest", "run", "--config", "./tests/e2e/vitest.config.ts", testTarget],
          {
            cwd: desktopRoot,
            env: buildTestEnv(
              testTarget,
              needsSecondaryForTarget,
              perfOutputPath,
              realE2eRuntimeEnvForTarget(testTarget),
            ),
          },
        );
      } finally {
        const perfSummary = await readFile(perfOutputPath, "utf8").catch(() => "");
        if (perfSummary.trim()) {
          process.stdout.write(`${perfSummary.trimEnd()}\n`);
        }
        if (targetNeedsStaleNativeWindowState(testTarget)) {
          await stopInstances(runningInstances);
          runningInstances = null;
          while (cleanupAppDataHooks.length > 0) {
            const cleanup = cleanupAppDataHooks.pop();
            await cleanup?.().catch(() => undefined);
          }
        }
      }
      lastTargetWasReal = targetIsReal;
    }
  } catch (error) {
    console.error("\n[e2e] recent dev log:\n");
    await runCommand(["./kd", "dev", "log"], { cwd: repoRoot, env: primary.env }).catch(() => undefined);
    if (secondary) {
      await runCommand(["./kd", "dev", "log"], { cwd: repoRoot, env: secondary.env }).catch(() => undefined);
    }
    if (firebaseEmulatorOutput.trim()) {
      console.error("\n[e2e] recent Firebase emulator log:\n");
      console.error(firebaseEmulatorOutput.trimEnd());
    }
    if (relayOutput.trim()) {
      console.error("\n[e2e] recent relay log:\n");
      console.error(relayOutput.trimEnd());
    }
    throw error;
  } finally {
    await stopInstances(runningInstances);
    while (cleanupAppDataHooks.length > 0) {
      const cleanup = cleanupAppDataHooks.pop();
      await cleanup?.().catch(() => undefined);
    }
    await stopRelay();
    if (relayControlServer) {
      await new Promise<void>((resolveClose) => {
        relayControlServer.close(() => resolveClose());
      });
    }
    await stopFirebaseEmulators();
    if (secondary) {
      await rm(secondary.daemonDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(primary.daemonDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(transferRegistryDir, { recursive: true, force: true }).catch(() => undefined);
    await ports.releaseAll();
  }
}

await main();
