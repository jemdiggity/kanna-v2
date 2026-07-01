import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, basename, join, posix, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildRealE2eAgentEnv } from "./runEnv";
import { createInstanceConfig, type InstanceConfig } from "./runConfig";
import { pauseBeforeTestTarget, pauseForAppReady } from "./helpers/runSlowMode";
import { isRealTestTarget, shouldStartInitialInstances } from "./runPlan";
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

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
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

async function canConnectToApp(baseUrl: string): Promise<boolean> {
  const status = await fetch(`${baseUrl}/status`).catch(() => null);
  if (!status?.ok) return false;

  const session = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: {} }),
  }).then((response) => response.json()).catch(() => null);

  const sessionId = session?.value?.sessionId;
  if (!sessionId) return false;

  try {
    const vueCheck = await fetch(`${baseUrl}/session/${sessionId}/execute/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script: "return Boolean(window.__KANNA_E2E__ && window.__KANNA_E2E__.setupState);",
        args: [],
      }),
    }).then((response) => response.json());
    return Boolean(vueCheck?.value);
  } finally {
    await fetch(`${baseUrl}/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
  }
}

async function waitForApp(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectToApp(baseUrl)) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for app at ${baseUrl}`);
}

function needsSecondaryInstance(testTargets: string[]): boolean {
  return testTargets.some((target) =>
    /real\/local-transfer-.*\.test\.ts$/.test(target) ||
    /real\/cloud-task-sync\.test\.ts$/.test(target)
  );
}

function targetNeedsSecondaryInstance(testTarget: string): boolean {
  return needsSecondaryInstance([testTarget]);
}

function targetNeedsEmulators(testTarget: string): boolean {
  return /real\/cloud-task-sync\.test\.ts$/.test(testTarget) ||
    /real\/mobile-relay-auth-recovery\.test\.ts$/.test(testTarget) ||
    /real\/auth-indexeddb-fallback\.test\.ts$/.test(testTarget);
}

function targetNeedsRelay(testTarget: string): boolean {
  return /real\/cloud-task-sync\.test\.ts$/.test(testTarget) ||
    /real\/mobile-relay-auth-recovery\.test\.ts$/.test(testTarget);
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
  const realE2eAgentEnv = buildRealE2eAgentEnv(testTargets, process.env);

  const enableSecondary = needsSecondaryInstance(testTargets);
  const worktreeName = sanitizeSuffix(basename(repoRoot));
  const runSuffix = sanitizeSuffix(`${process.pid}-${Date.now()}`);
  const sessionName = `kanna-e2e-${worktreeName}-${runSuffix}`;
  const transferRegistryDir = join(repoRoot, ".kanna-transfer-registry-e2e", runSuffix);
  const primaryDevPort = await findFreePort();
  const primaryWebDriverPort = await findFreePort();
  const primaryTransferPort = await findFreePort();
  const primaryMobileServerPort = await findFreePort();
  const relayPort = await findFreePort();
  const firebaseAuthPort = await findFreePort();
  const firebaseFirestorePort = await findFreePort();
  const firebaseFunctionsPort = await findFreePort();
  const firebaseUiPort = await findFreePort();
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
    RUST_LOG: process.env.RUST_LOG ?? "kanna_server::ksp=warn",
  };
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const relayEnv = {
    KANNA_RELAY_PORT: String(relayPort),
    KANNA_RELAY_URL: relayUrl,
  };
  const primaryDbName = `test-${worktreeName}-${runSuffix}-primary.db`;
  const primaryDaemonDir = join(repoRoot, ".kanna-daemon-e2e", runSuffix);
  const realE2eRuntimeEnv = realE2eAgentEnv.KANNA_E2E_REAL_AGENT_PROVIDER === "codex"
    ? {
        ...realE2eAgentEnv,
        CODEX_HOME: await setupIsolatedCodexHome(join(primaryDaemonDir, "codex-home")),
      }
    : realE2eAgentEnv;
  const agentCliFixtureEnv = agentCliVersionFixtureEnv();
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

  const secondaryDevPort = enableSecondary ? await findFreePort() : null;
  const secondaryWebDriverPort = enableSecondary ? await findFreePort() : null;
  const secondaryTransferPort = enableSecondary ? await findFreePort() : null;
  const secondaryMobileServerPort = enableSecondary ? await findFreePort() : null;
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
      ...(targetNeedsAuthIndexedDbOpenFailure(testTarget)
        ? { KANNA_E2E_FIREBASE_AUTH_INDEXEDDB_OPEN_FAILURE: "1" }
        : {}),
    };
  }

  function buildTestEnv(
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
  ): Promise<RunningInstances> {
    const fixtureEnv = useAgentCliFixtures ? agentCliFixtureEnv : {};
    await runCommand(primary.startCommand, {
      cwd: repoRoot,
      env: { ...primary.env, ...runtimeEnv, ...fixtureEnv },
    });
    console.log(`[e2e] waiting for primary app at ${primary.baseUrl}`);
    await waitForApp(primary.baseUrl, 10 * 60_000);
    console.log(`[e2e] primary app ready at ${primary.baseUrl}`);
    await pauseForAppReady("primary");

    const secondaryInstance = withSecondary ? secondary : null;
    if (secondaryInstance) {
      await runCommand(secondaryInstance.startCommand, {
        cwd: repoRoot,
        env: { ...secondaryInstance.env, ...runtimeEnv, ...fixtureEnv },
      });
      console.log(`[e2e] waiting for secondary app at ${secondaryInstance.baseUrl}`);
      await waitForApp(secondaryInstance.baseUrl, 10 * 60_000);
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
    proc.stdout?.on("data", (chunk: Buffer) => {
      firebaseEmulatorOutput += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      firebaseEmulatorOutput += chunk.toString();
    });

    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    proc.once("exit", (code, signal) => {
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
    }
    await runCommand(["./kd", "emulators", "down"], {
      cwd: repoRoot,
      env: { ...primary.env, ...firebaseEnv },
    }).catch(() => undefined);
  }

  let relayProcess: ReturnType<typeof spawn> | null = null;
  let relayOutput = "";

  async function startRelay(): Promise<void> {
    if (relayProcess) return;

    relayOutput = "";
    const proc = spawn("pnpm", ["--dir", "services/relay", "run", "dev"], {
      cwd: repoRoot,
      env: {
        ...primary.env,
        ...firebaseEnv,
        ...relayEnv,
        PORT: String(relayPort),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    relayProcess = proc;
    proc.stdout?.on("data", (chunk: Buffer) => {
      relayOutput += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      relayOutput += chunk.toString();
    });

    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    proc.once("exit", (code, signal) => {
      exited = { code, signal };
      if (relayProcess === proc) relayProcess = null;
    });

    const healthUrl = `http://127.0.0.1:${relayPort}/health`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `Relay exited before readiness: ${exited.code ?? exited.signal}\n${relayOutput.trim()}`,
        );
      }
      const response = await fetch(healthUrl).catch(() => null);
      if (response?.ok) return;
      await sleep(250);
    }

    throw new Error(`timed out waiting for relay at ${healthUrl}\n${relayOutput.trim()}`);
  }

  async function stopRelay(): Promise<void> {
    const proc = relayProcess;
    relayProcess = null;
    if (!proc?.pid) return;

    try {
      process.kill(-proc.pid, "SIGINT");
    } catch {
      proc.kill("SIGINT");
    }
    const exited = await Promise.race([
      new Promise<boolean>((resolveExit) => proc.once("exit", () => resolveExit(true))),
      sleep(5_000).then(() => false),
    ]);
    if (!exited) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
  }

  let runningInstances: RunningInstances | null = null;
  let lastTargetWasReal = false;
  const cleanupAppDataHooks: Array<() => Promise<void>> = [];

  try {
    if (shouldStartInitialInstances(testTargets[0])) {
      runningInstances = await startInstances(false, true);
    }

    for (const testTarget of testTargets) {
      const targetIsReal = isRealTestTarget(testTarget);
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
        );
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
    await stopFirebaseEmulators();
    if (secondary) {
      await rm(secondary.daemonDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(primary.daemonDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(transferRegistryDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
