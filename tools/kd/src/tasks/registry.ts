import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readKannaRepoConfig } from "../config";
import { resolveKdContext, type KdContext } from "../context";
import { cleanWorkspace } from "../runtime/clean";
import { buildRelayProvisionPlan, deployFirebaseCloud } from "../runtime/cloud-deploy";
import {
  buildCloudEmulatorTestCommand,
  buildCloudSmokeCommand,
  buildCloudSmokeEnv,
  requireCloudSmokeEnv,
} from "../runtime/cloud-test";
import { buildLanLabPlan, parseLanLabInventory } from "../runtime/lan-lab";
import { buildLanLabScenarioCommand } from "../runtime/lan-lab-runner";
import { selectPreferredLanAddress } from "../runtime/lan-address";
import { buildDevPlan, buildProductionMobilePlan } from "../runtime/dev-plan";
import { resolveKdEnvironment } from "../runtime/environment";
import { assertNotProductionDb, resetSqliteDb, seedSqliteDb, type DevDbTarget } from "../runtime/db";
import { killWorkspaceDaemons } from "../runtime/daemon";
import { checkRequiredCommands } from "../runtime/doctor";
import { writeCargoConfig } from "../runtime/env-sync";
import { buildFirebaseCommandEnv, buildFirebaseEmulatorArgs, formatMissingFirebaseEmulators, resolveFirebaseEnvFromReference, writeFirebaseEmulatorConfig, type FirebasePortInput } from "../runtime/firebase";
import { resolveMobileServerUrl } from "../runtime/mobile";
import { buildMobileDeviceSmokeCommand, buildMobileTestCommand } from "../runtime/mobile-commands";
import {
  buildMobileDevicePrebuildCommand,
  buildMobileDeviceRunCommand,
  checkPhysicalDeviceRunPreflight,
  resolveMobileNativeIdentity,
  resolvePhysicalDevice
} from "../runtime/mobile-device";
import { buildConfigSchemaPages } from "../runtime/pages";
import { getPortStatuses } from "../runtime/port-status";
import { nodeCommandRunner, type CommandRunner } from "../runtime/process";
import { shipRelease } from "../runtime/release";
import { buildDesktopSidecars } from "../runtime/sidecars";
import { checkSetupPrerequisites, installSetupDependencies } from "../runtime/setup";
import { getDevStatus } from "../runtime/status";
import { captureTmuxLog, startTmuxSession, stopTmuxSession, stopTmuxWindow } from "../runtime/tmux";
import { readDesktopBundleIdentifier, writeTauriLocalConfig } from "../runtime/tauri";
import type { KdPorts } from "../ports";
import type { TaskDefinition, TaskResult } from "./types";

export interface DevUpInput {
  mobile: boolean;
  emulators: boolean;
  seed: boolean;
  attach: boolean;
  deleteDb: boolean;
  killDaemon: boolean;
  db?: string;
  daemonDir?: string;
  transferRoot?: string;
  firebaseEnvFrom?: string;
}

export interface DevDownInput {
  killDaemon: boolean;
}

export interface MobileUpInput {
  production: boolean;
  staging: boolean;
}

export interface MobileRunInput {
  device: boolean;
}

export const devUpInputSchema = z.object({
  mobile: z.boolean().default(false),
  emulators: z.boolean().default(false),
  seed: z.boolean().default(false),
  attach: z.boolean().default(false),
  deleteDb: z.boolean().default(false),
  killDaemon: z.boolean().default(false),
  db: z.string().optional(),
  daemonDir: z.string().optional(),
  transferRoot: z.string().optional(),
  firebaseEnvFrom: z.string().optional()
});

const devDownInputSchema = z.object({
  killDaemon: z.boolean().default(false)
});

const mobileUpInputSchema = z.object({
  production: z.boolean().default(false),
  staging: z.boolean().default(false)
});

const mobileRunInputSchema = z.object({
  device: z.boolean().default(false)
});

const logInputSchema = z.object({
  window: z.string().default("desktop")
});

const seedInputSchema = z.object({
  deleteDb: z.boolean().default(false),
  db: z.string().optional()
});

const emulatorsExecInputSchema = z.object({
  extraArgs: z.array(z.string()).default([])
});

const emptyInputSchema = z.object({});

const lanLabInputSchema = z.object({
  hosts: z.string()
});

const setupInputSchema = z.object({
  check: z.boolean().default(false)
});

const cleanInputSchema = z.object({
  all: z.boolean().default(false),
  dry: z.boolean().default(false),
  sharedRustBuild: z.boolean().default(false)
});

const pagesBuildSchemaInputSchema = z.object({
  outDir: z.string()
});

const releaseShipInputSchema = z.object({
  major: z.boolean().default(false),
  minor: z.boolean().default(false),
  patch: z.boolean().default(false),
  arm64: z.boolean().default(false),
  x86_64: z.boolean().default(false),
  release: z.boolean().default(false),
  dryRun: z.boolean().default(false)
});

const cloudDeployInputSchema = z.object({
  staging: z.boolean().default(false),
  production: z.boolean().default(false),
  relay: z.boolean().default(false)
});

const cloudRelayProvisionInputSchema = z.object({
  staging: z.boolean().default(false),
  production: z.boolean().default(false)
});

export interface ExecutorInput {
  runner: CommandRunner;
  context: {
    repoRoot: string;
    tmux: KdContext["tmux"];
    ports: Partial<KdPorts>;
    env: NodeJS.ProcessEnv;
  };
}

export interface DevDownExecutionOptions {
  killProcess?: (pid: number) => void;
}

export interface MobileDeviceRunExecutionOptions {
  resolveLanAddress?: () => string | undefined;
}

async function readGitValue(args: string[], cwd?: string): Promise<string> {
  const result = await nodeCommandRunner.run("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

interface ResolveDefaultContextOptions {
  dbOverride?: string;
  daemonDirOverride?: string;
  transferRootOverride?: string;
  firebaseEnvFrom?: string;
}

async function resolveDefaultContext(env: NodeJS.ProcessEnv, options: ResolveDefaultContextOptions = {}): Promise<KdContext> {
  const repoRoot = await readGitValue(["rev-parse", "--show-toplevel"]);
  const branch = await readGitValue(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const commit = await readGitValue(["rev-parse", "--short", "HEAD"], repoRoot);
  const config = readKannaRepoConfig(repoRoot);
  const bundleIdentifier = readDesktopBundleIdentifier(repoRoot);
  const homeDir = env.HOME?.trim() || homedir();
  const resolvedEnv = options.firebaseEnvFrom
    ? { ...env, ...resolveFirebaseEnvFromReference(repoRoot, options.firebaseEnvFrom) }
    : env;
  return resolveKdContext({
    repoRoot,
    homeDir,
    env: resolvedEnv,
    branch,
    commit,
    bundleIdentifier,
    configPorts: config.ports,
    dbOverride: options.dbOverride,
    daemonDirOverride: options.daemonDirOverride,
    transferRootOverride: options.transferRootOverride
  });
}

export async function executeDevStatus(input: ExecutorInput): Promise<TaskResult> {
  const status = await getDevStatus(input.runner, input.context.tmux);
  return {
    ok: true,
    message: status.running ? "Kanna dev session is running." : "Kanna dev session is not running.",
    data: status
  };
}

async function executeDevUp(input: DevUpInput): Promise<TaskResult> {
  const context = await resolveDefaultContext(process.env, {
    dbOverride: input.db,
    daemonDirOverride: input.daemonDir,
    transferRootOverride: input.transferRoot,
    firebaseEnvFrom: input.firebaseEnvFrom
  });
  const dbTarget = devDbTarget(context);
  assertNotProductionDb(dbTarget);

  if (input.firebaseEnvFrom) {
    const statuses = await getPortStatuses(nodeCommandRunner, {
      auth: context.ports.KANNA_FIREBASE_AUTH_PORT,
      firestore: context.ports.KANNA_FIREBASE_FIRESTORE_PORT,
      functions: context.ports.KANNA_FIREBASE_FUNCTIONS_PORT,
      ui: context.ports.KANNA_FIREBASE_UI_PORT
    });
    const missing = formatMissingFirebaseEmulators(input.firebaseEnvFrom, statuses);
    if (missing) {
      throw new Error(missing);
    }
  }

  if (input.deleteDb) {
    await resetSqliteDb(nodeCommandRunner, dbTarget);
  }

  const firebaseConfigPath = writeFirebaseEmulatorConfig(context.repoRoot, context.ports);
  writeTauriLocalConfig(context.repoRoot, context.ports.KANNA_DEV_PORT);
  const plan = buildDevPlan({
    repoRoot: context.repoRoot,
    env: context.env,
    mobile: input.mobile,
    emulators: input.emulators,
    firebaseConfigPath,
    mobileServerUrl: resolveMobileServerUrl(context.env)
  });

  await startTmuxSession(nodeCommandRunner, context.tmux, plan.windows);
  if (input.seed) {
    await seedSqliteDb(nodeCommandRunner, context.repoRoot, context.env.KANNA_DB_PATH ?? "");
  }
  if (input.attach) {
    await nodeCommandRunner.run("tmux", ["-L", context.tmux.server, "attach", "-t", context.tmux.session]);
  }

  return {
    ok: true,
    message: `Started tmux session '${context.tmux.session}'.`,
    data: { windows: plan.windows.map((window) => window.name) }
  };
}

interface ProductionDesktopStatus {
  desktopId?: string;
  version?: string;
  relay_url?: string;
  relayUrl?: string;
  state?: string;
}

async function readProductionDesktopStatus(runner: CommandRunner): Promise<ProductionDesktopStatus> {
  const result = await runner.run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "http://127.0.0.1:48120/v1/status"
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        "Production desktop server is not reachable at http://127.0.0.1:48120/v1/status"
    );
  }

  try {
    return JSON.parse(result.stdout) as ProductionDesktopStatus;
  } catch {
    throw new Error("Production desktop server returned invalid JSON from /v1/status.");
  }
}

async function assertProductionServerConfig(runner: CommandRunner, env: NodeJS.ProcessEnv): Promise<string> {
  const homeDir = env.HOME?.trim() || homedir();
  const serverConfigPath = join(
    homeDir,
    "Library",
    "Application Support",
    "build.kanna",
    "Kanna",
    "server.toml"
  );
  const result = await runner.run("test", ["-f", serverConfigPath]);
  if (result.exitCode !== 0) {
    throw new Error(`Production mobile server config not found at ${serverConfigPath}`);
  }
  return serverConfigPath;
}

export async function executeProductionMobileUpWithContext(
  input: MobileUpInput,
  executor: ExecutorInput
): Promise<TaskResult> {
  if (input.production && input.staging) {
    throw new Error("mobile.up accepts only one of --production or --staging.");
  }
  if (!input.production && !input.staging) {
    throw new Error("mobile.up requires --production or --staging.");
  }

  if (input.staging) {
    const staging = resolveKdEnvironment("staging");
    const env = {
      ...executor.context.env,
      KANNA_CLOUD_ENV: "staging",
      KANNA_APP_ENV: executor.context.env.KANNA_APP_ENV ?? "staging"
    };
    writeTauriLocalConfig(executor.context.repoRoot, requireNumberPort(executor.context.ports, "KANNA_DEV_PORT"));
    const desktopPlan = buildDevPlan({
      repoRoot: executor.context.repoRoot,
      env,
      mobile: false,
      emulators: false,
      firebaseConfigPath: "",
      mobileServerUrl: resolveMobileServerUrl(env)
    });
    const mobilePlan = buildProductionMobilePlan({
      repoRoot: executor.context.repoRoot,
      env,
      environment: "staging"
    });
    const plan = { windows: [...desktopPlan.windows, ...mobilePlan.windows] };

    await startTmuxSession(executor.runner, executor.context.tmux, plan.windows);

    return {
      ok: true,
      message: "Started mobile against staging cloud environment.",
      data: {
        relayUrl: staging.relayUrl,
        windows: plan.windows.map((window) => window.name)
      }
    };
  }

  const [status, serverConfigPath] = await Promise.all([
    readProductionDesktopStatus(executor.runner),
    assertProductionServerConfig(executor.runner, executor.context.env)
  ]);
  const relayUrl = status.relay_url ?? status.relayUrl;
  const env = {
    ...executor.context.env,
    EXPO_PUBLIC_KANNA_RELAY_URL:
      executor.context.env.EXPO_PUBLIC_KANNA_RELAY_URL ?? relayUrl
  };
  const plan = buildProductionMobilePlan({
    repoRoot: executor.context.repoRoot,
    env,
    environment: "production"
  });

  await startTmuxSession(executor.runner, executor.context.tmux, plan.windows);

  const desktopId = status.desktopId ?? "unknown desktop";
  const version = status.version ?? "unknown version";
  return {
    ok: true,
    message: `Started mobile against production desktop ${desktopId} (${version}).`,
    data: {
      desktopId: status.desktopId,
      version: status.version,
      relayUrl,
      serverConfigPath,
      windows: plan.windows.map((window) => window.name)
    }
  };
}

async function executeProductionMobileUp(input: MobileUpInput): Promise<TaskResult> {
  const context = await resolveDefaultContext(process.env);
  return executeProductionMobileUpWithContext(input, {
    runner: nodeCommandRunner,
    context: {
      repoRoot: context.repoRoot,
      tmux: context.tmux,
      ports: context.ports,
      env: context.env
    }
  });
}

function requireMobileDeviceLanHost(
  options: MobileDeviceRunExecutionOptions = {}
): string {
  const lanHost = (options.resolveLanAddress ?? selectPreferredLanAddress)();
  if (!lanHost) {
    throw new Error(
      "Could not determine a Mac LAN IP address for physical-device mobile run. " +
        "Connect the Mac and iPhone to the same network before running kd mobile run --device."
    );
  }
  return lanHost;
}

function formatPhysicalDevicePreflight(checks: Awaited<ReturnType<typeof checkPhysicalDeviceRunPreflight>>["checks"]): string {
  return checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`).join("\n");
}

function requireNumberPort(ports: Partial<KdPorts>, key: keyof KdPorts): number {
  const port = ports[key];
  if (typeof port !== "number") {
    throw new Error(`${key} is required.`);
  }
  return port;
}

function requireMobileDeviceDevPorts(ports: Partial<KdPorts>): FirebasePortInput & { KANNA_DEV_PORT: number } {
  return {
    KANNA_DEV_PORT: requireNumberPort(ports, "KANNA_DEV_PORT"),
    KANNA_FIREBASE_AUTH_PORT: requireNumberPort(ports, "KANNA_FIREBASE_AUTH_PORT"),
    KANNA_FIREBASE_FIRESTORE_PORT: requireNumberPort(ports, "KANNA_FIREBASE_FIRESTORE_PORT"),
    KANNA_FIREBASE_FUNCTIONS_PORT: requireNumberPort(ports, "KANNA_FIREBASE_FUNCTIONS_PORT"),
    KANNA_FIREBASE_UI_PORT: requireNumberPort(ports, "KANNA_FIREBASE_UI_PORT")
  };
}

export async function executeMobileDeviceRunWithContext(
  input: MobileRunInput,
  executor: ExecutorInput,
  options: MobileDeviceRunExecutionOptions = {}
): Promise<TaskResult> {
  if (!input.device) {
    throw new Error("mobile.run requires --device.");
  }

  const lanHost = requireMobileDeviceLanHost(options);
  const device = await resolvePhysicalDevice(executor.runner, {
    requestedUdid: executor.context.env.KANNA_IOS_DEVICE_UDID?.trim() || undefined,
    requestedName: executor.context.env.KANNA_IOS_PHYSICAL_DEVICE_NAME?.trim() || undefined
  });
  const env: NodeJS.ProcessEnv = {
    ...executor.context.env,
    KANNA_APP_ENV: executor.context.env.KANNA_APP_ENV ?? "dev",
    KANNA_IOS_DEVICE_UDID: device.udid
  };
  const devPorts = requireMobileDeviceDevPorts(executor.context.ports);
  const firebaseConfigPath = writeFirebaseEmulatorConfig(executor.context.repoRoot, devPorts);
  writeTauriLocalConfig(executor.context.repoRoot, devPorts.KANNA_DEV_PORT);
  const plan = buildDevPlan({
    repoRoot: executor.context.repoRoot,
    env,
    mobile: true,
    emulators: true,
    firebaseConfigPath,
    mobileServerUrl: resolveMobileServerUrl(env),
    resolveLanAddress: () => lanHost
  });

  await startTmuxSession(executor.runner, executor.context.tmux, plan.windows);

  const metroPort = Number.parseInt(env.KANNA_MOBILE_PORT ?? "8081", 10);
  if (Number.isNaN(metroPort)) {
    throw new Error(`KANNA_MOBILE_PORT must be an integer, got: ${env.KANNA_MOBILE_PORT}`);
  }

  const nativeIdentity = resolveMobileNativeIdentity(env);
  const preflight = await checkPhysicalDeviceRunPreflight(executor.runner, {
    bundleId: nativeIdentity.bundleId,
    device,
    lanHost,
    metroPort
  });
  const prebuildCommand = buildMobileDevicePrebuildCommand({
    repoRoot: executor.context.repoRoot,
    nativeIdentity
  });
  const prebuildResult = await executor.runner.run(prebuildCommand.command, prebuildCommand.args, {
    cwd: prebuildCommand.cwd,
    env: { ...env, ...prebuildCommand.env },
    streamOutput: true
  });
  if (prebuildResult.exitCode !== 0) {
    return {
      ok: false,
      message:
        prebuildResult.stderr ||
        prebuildResult.stdout ||
        `Failed to prebuild Kanna mobile for ${nativeIdentity.bundleId}.`,
      data: {
        bundleId: nativeIdentity.bundleId,
        device,
        metroUrl: preflight.metroUrl,
        preflight,
        windows: plan.windows.map((window) => window.name)
      }
    };
  }

  const runCommand = buildMobileDeviceRunCommand({
    repoRoot: executor.context.repoRoot,
    deviceUdid: device.udid,
    lanHost,
    metroPort,
    nativeIdentity
  });
  const runResult = await executor.runner.run(runCommand.command, runCommand.args, {
    cwd: runCommand.cwd,
    env: { ...env, ...runCommand.env },
    streamOutput: true
  });

  return {
    ok: runResult.exitCode === 0,
    message:
      runResult.exitCode === 0
        ? `Launched Kanna mobile on ${device.name}. Metro: ${preflight.metroUrl}\n${formatPhysicalDevicePreflight(preflight.checks)}`
        : runResult.stderr || runResult.stdout || `Failed to launch Kanna mobile on ${device.name}. Metro: ${preflight.metroUrl}`,
    data: {
      bundleId: nativeIdentity.bundleId,
      device,
      metroUrl: preflight.metroUrl,
      preflight,
      windows: plan.windows.map((window) => window.name)
    }
  };
}

export async function executeMobileDeviceDoctorWithContext(
  input: MobileRunInput,
  executor: ExecutorInput,
  options: MobileDeviceRunExecutionOptions = {}
): Promise<TaskResult> {
  if (!input.device) {
    throw new Error("mobile.doctor requires --device.");
  }

  const lanHost = requireMobileDeviceLanHost(options);
  const device = await resolvePhysicalDevice(executor.runner, {
    requestedUdid: executor.context.env.KANNA_IOS_DEVICE_UDID?.trim() || undefined,
    requestedName: executor.context.env.KANNA_IOS_PHYSICAL_DEVICE_NAME?.trim() || undefined
  });
  const metroPort = Number.parseInt(executor.context.env.KANNA_MOBILE_PORT ?? "8081", 10);
  if (Number.isNaN(metroPort)) {
    throw new Error(`KANNA_MOBILE_PORT must be an integer, got: ${executor.context.env.KANNA_MOBILE_PORT}`);
  }
  const nativeIdentity = resolveMobileNativeIdentity({
    ...executor.context.env,
    KANNA_APP_ENV: executor.context.env.KANNA_APP_ENV ?? "dev"
  });
  const preflight = await checkPhysicalDeviceRunPreflight(executor.runner, {
    bundleId: nativeIdentity.bundleId,
    device,
    lanHost,
    metroPort
  });

  return {
    ok: preflight.ok,
    message: `Physical-device mobile doctor for ${device.name}. Metro: ${preflight.metroUrl}\n${formatPhysicalDevicePreflight(preflight.checks)}`,
    data: {
      bundleId: nativeIdentity.bundleId,
      device,
      metroUrl: preflight.metroUrl,
      preflight
    }
  };
}

async function executeMobileDeviceRun(input: MobileRunInput): Promise<TaskResult> {
  const context = await resolveDefaultContext(process.env);
  const dbTarget = devDbTarget(context);
  assertNotProductionDb(dbTarget);
  return executeMobileDeviceRunWithContext(input, {
    runner: nodeCommandRunner,
    context: {
      repoRoot: context.repoRoot,
      tmux: context.tmux,
      ports: context.ports,
      env: context.env
    }
  });
}

async function executeMobileDeviceDoctor(input: MobileRunInput): Promise<TaskResult> {
  const context = await resolveDefaultContext(process.env);
  return executeMobileDeviceDoctorWithContext(input, {
    runner: nodeCommandRunner,
    context: {
      repoRoot: context.repoRoot,
      tmux: context.tmux,
      ports: context.ports,
      env: context.env
    }
  });
}

export async function executeDevDownWithContext(
  input: DevDownInput,
  executor: ExecutorInput,
  options: DevDownExecutionOptions = {}
): Promise<TaskResult> {
  const stopped = await stopTmuxSession(executor.runner, executor.context.tmux);
  const daemonCleanup = input.killDaemon
    ? await killWorkspaceDaemons({
        repoRoot: executor.context.repoRoot,
        daemonDir: executor.context.env.KANNA_DAEMON_DIR ?? "",
        runner: executor.runner,
        killProcess: options.killProcess
      })
    : undefined;
  return {
    ok: true,
    message: stopped ? "Stopped." : "No session running.",
    data: { stopped, daemonCleanup }
  };
}

async function executeDevDown(input: DevDownInput): Promise<TaskResult> {
  return executeDevDownWithContext(
    input,
    { runner: nodeCommandRunner, context: await resolveDefaultContext(process.env) }
  );
}

async function executeDevSeed(input: z.infer<typeof seedInputSchema>): Promise<TaskResult> {
  const context = await resolveDefaultContext(process.env, { dbOverride: input.db });
  const dbTarget = devDbTarget(context);
  assertNotProductionDb(dbTarget);
  if (input.deleteDb) {
    await resetSqliteDb(nodeCommandRunner, dbTarget);
  }
  await seedSqliteDb(nodeCommandRunner, context.repoRoot, context.env.KANNA_DB_PATH ?? "");
  return {
    ok: true,
    message: `Seeded ${context.env.KANNA_DB_PATH ?? ""}`,
    data: { dbPath: context.env.KANNA_DB_PATH }
  };
}

async function executeEnvironmentPrint(): Promise<TaskResult> {
  const context = await resolveDefaultContext(process.env);
  return {
    ok: true,
    message: JSON.stringify(
      {
        repoRoot: context.repoRoot,
        isWorktree: context.isWorktree,
        worktreeName: context.worktreeName,
        tmux: context.tmux,
        ports: context.ports,
        env: {
          KANNA_DB_NAME: context.env.KANNA_DB_NAME,
          KANNA_DB_PATH: context.env.KANNA_DB_PATH,
          KANNA_DAEMON_DIR: context.env.KANNA_DAEMON_DIR,
          KANNA_TRANSFER_ROOT: context.env.KANNA_TRANSFER_ROOT
        }
      },
      null,
      2
    )
  };
}

function formatJsonResult(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

function devDbTarget(context: KdContext): DevDbTarget {
  return {
    dbName: context.env.KANNA_DB_NAME ?? "",
    dbPath: context.env.KANNA_DB_PATH ?? ""
  };
}

async function runBuiltCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<TaskResult> {
  const result = await nodeCommandRunner.run(command, args, { cwd, env });
  return {
    ok: result.exitCode === 0,
    message: result.exitCode === 0 ? result.stdout || `${command} ${args.join(" ")} completed.` : result.stderr,
    data: { command, args, exitCode: result.exitCode }
  };
}

async function waitForTcpPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolvePort) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePort(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolvePort(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolvePort(false);
      });
    });
    if (ok) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`timed out waiting for WebDriver tunnel on port ${port}`);
}

export const taskDefinitions = [
  {
    id: "dev.up",
    description: "Start the Kanna dev environment.",
    inputSchema: devUpInputSchema,
    execute: async (_context, input) => executeDevUp(devUpInputSchema.parse(input))
  },
  {
    id: "dev.down",
    description: "Stop the Kanna dev environment.",
    inputSchema: devDownInputSchema,
    execute: async (_context, input) => executeDevDown(devDownInputSchema.parse(input))
  },
  {
    id: "dev.restart",
    description: "Restart the Kanna dev environment.",
    inputSchema: devUpInputSchema,
    execute: async (_context, input) => {
      const parsed = devUpInputSchema.parse(input);
      await executeDevDown({ killDaemon: parsed.killDaemon });
      return executeDevUp(parsed);
    }
  },
  {
    id: "dev.status",
    description: "Show Kanna dev environment status.",
    inputSchema: emptyInputSchema,
    execute: async () => executeDevStatus({ runner: nodeCommandRunner, context: await resolveDefaultContext(process.env) })
  },
  {
    id: "dev.log",
    description: "Show recent tmux output for a Kanna dev window.",
    inputSchema: logInputSchema,
    execute: async (_context, input) => {
      const parsed = logInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      return {
        ok: true,
        message: await captureTmuxLog(nodeCommandRunner, context.tmux, parsed.window)
      };
    }
  },
  {
    id: "dev.seed",
    description: "Seed the Kanna dev database.",
    inputSchema: seedInputSchema,
    execute: async (_context, input) => executeDevSeed(seedInputSchema.parse(input))
  },
  {
    id: "mobile.up",
    description: "Start Kanna mobile against production or staging cloud.",
    inputSchema: mobileUpInputSchema,
    execute: async (_context, input) => executeProductionMobileUp(mobileUpInputSchema.parse(input))
  },
  {
    id: "mobile.run",
    description: "Build, install, and launch Kanna mobile on a physical iOS device.",
    inputSchema: mobileRunInputSchema,
    execute: async (_context, input) => executeMobileDeviceRun(mobileRunInputSchema.parse(input))
  },
  {
    id: "mobile.doctor",
    description: "Check physical iOS device mobile development readiness.",
    inputSchema: mobileRunInputSchema,
    execute: async (_context, input) => executeMobileDeviceDoctor(mobileRunInputSchema.parse(input))
  },
  {
    id: "emulators.up",
    description: "Start Firebase emulators for Kanna.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const configPath = writeFirebaseEmulatorConfig(context.repoRoot, context.ports);
      const build = await nodeCommandRunner.run("pnpm", ["--dir", "services/firebase-functions", "build"], {
        cwd: context.repoRoot,
        env: context.env,
      });
      if (build.exitCode !== 0) {
        return {
          ok: false,
          message: build.stderr || build.stdout || "Firebase functions build failed.",
          data: { configPath, exitCode: build.exitCode }
        };
      }
      const result = await nodeCommandRunner.run("pnpm", buildFirebaseEmulatorArgs(configPath, []), {
        cwd: context.repoRoot,
        env: buildFirebaseCommandEnv(context.repoRoot, context.env)
      });
      return {
        ok: result.exitCode === 0,
        message: result.exitCode === 0 ? result.stdout : result.stderr,
        data: { configPath }
      };
    }
  },
  {
    id: "emulators.exec",
    description: "Run a command with Firebase emulators.",
    inputSchema: emulatorsExecInputSchema,
    execute: async (_context, input) => {
      const parsed = emulatorsExecInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      const configPath = writeFirebaseEmulatorConfig(context.repoRoot, context.ports);
      const result = await nodeCommandRunner.run(
        "pnpm",
        ["exec", "firebase", "emulators:exec", "--project", "kanna-local", "--only", "auth,firestore,functions", "--config", configPath, parsed.extraArgs.join(" ")],
        { cwd: context.repoRoot, env: buildFirebaseCommandEnv(context.repoRoot, context.env) }
      );
      return {
        ok: result.exitCode === 0,
        message: result.exitCode === 0 ? result.stdout : result.stderr,
        data: { configPath }
      };
    }
  },
  {
    id: "emulators.down",
    description: "Stop Firebase emulators for Kanna.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const stopped = await stopTmuxWindow(nodeCommandRunner, context.tmux, "emulators");
      return {
        ok: true,
        message: stopped ? "Stopped Firebase emulator window." : "No Firebase emulator window is running.",
        data: { stopped }
      };
    }
  },
  {
    id: "emulators.status",
    description: "Show Firebase emulator status for Kanna.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const statuses = await getPortStatuses(nodeCommandRunner, {
        auth: context.ports.KANNA_FIREBASE_AUTH_PORT,
        firestore: context.ports.KANNA_FIREBASE_FIRESTORE_PORT,
        functions: context.ports.KANNA_FIREBASE_FUNCTIONS_PORT,
        ui: context.ports.KANNA_FIREBASE_UI_PORT
      });
      return {
        ok: true,
        message: formatJsonResult(statuses),
        data: { statuses }
      };
    }
  },
  {
    id: "mobile.test",
    description: "Run Kanna mobile tests.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const command = buildMobileTestCommand(context.repoRoot);
      return runBuiltCommand(command.command, command.args, context.repoRoot, context.env);
    }
  },
  {
    id: "mobile.device-smoke",
    description: "Run Kanna mobile physical-device smoke tests.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      context.env.KANNA_APP_ENV = context.env.KANNA_APP_ENV ?? "dev";
      context.env.KANNA_E2E_DESKTOP_SERVER_URL = resolveMobileServerUrl(context.env);
      const command = buildMobileDeviceSmokeCommand(context.repoRoot);
      return runBuiltCommand(command.command, command.args, context.repoRoot, context.env);
    }
  },
  {
    id: "env.print",
    description: "Print resolved Kanna development environment.",
    inputSchema: emptyInputSchema,
    execute: async () => executeEnvironmentPrint()
  },
  {
    id: "env.sync",
    description: "Sync Kanna development environment files.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const cargoConfig = writeCargoConfig(context.repoRoot, context.homeDir);
      return {
        ok: true,
        message: `Synced Kanna dev environment files.`,
        data: { cargoConfig }
      };
    }
  },
  {
    id: "build.sidecars",
    description: "Build Kanna desktop sidecars.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const staged = await buildDesktopSidecars(nodeCommandRunner, context.repoRoot);
      return {
        ok: true,
        message: `Built and staged ${staged.length} sidecars.`,
        data: { staged }
      };
    }
  },
  {
    id: "build.desktop",
    description: "Build the Kanna desktop app through the workspace build graph.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      return runBuiltCommand("pnpm", ["turbo", "build"], context.repoRoot, context.env);
    }
  },
  {
    id: "clean",
    description: "Clean Kanna build artifacts.",
    inputSchema: cleanInputSchema,
    execute: async (_context, input) => {
      const parsed = cleanInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      const result = cleanWorkspace({
        repoRoot: context.repoRoot,
        homeDir: context.homeDir,
        all: parsed.all,
        dry: parsed.dry,
        sharedRustBuild: parsed.sharedRustBuild
      });
      return {
        ok: true,
        message: result.removals.length === 0 ? "nothing to clean" : formatJsonResult(result.removals),
        data: result
      };
    }
  },
  {
    id: "setup",
    description: "Check Kanna prerequisites and install workspace dependencies.",
    inputSchema: setupInputSchema,
    execute: async (_context, input) => {
      const parsed = setupInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      const checks = await checkSetupPrerequisites(nodeCommandRunner, context.repoRoot);
      if (!checks.ok) {
        return { ok: false, message: formatJsonResult(checks.checks), data: checks };
      }
      if (!parsed.check) {
        await installSetupDependencies(nodeCommandRunner, context.repoRoot);
      }
      return { ok: true, message: formatJsonResult(checks.checks), data: checks };
    }
  },
  {
    id: "pages.build-schema",
    description: "Build the static config-schema Pages artifact.",
    inputSchema: pagesBuildSchemaInputSchema,
    execute: async (_context, input) => {
      const parsed = pagesBuildSchemaInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      const outputs = buildConfigSchemaPages({ repoRoot: context.repoRoot, outDir: resolve(context.repoRoot, parsed.outDir) });
      return { ok: true, message: outputs.join("\n"), data: { outputs } };
    }
  },
  {
    id: "release.ship",
    description: "Build, sign, notarize, and optionally publish a Kanna release.",
    inputSchema: releaseShipInputSchema,
    execute: async (_context, input) => {
      const parsed = releaseShipInputSchema.parse(input);
      const bump = parsed.major ? "major" : parsed.minor ? "minor" : "patch";
      const archLabels = [
        ...(parsed.arm64 ? ["arm64" as const] : []),
        ...(parsed.x86_64 ? ["x86_64" as const] : [])
      ];
      const context = await resolveDefaultContext(process.env);
      const result = await shipRelease({
        repoRoot: context.repoRoot,
        bump,
        archLabels: archLabels.length > 0 ? archLabels : ["arm64", "x86_64"],
        release: parsed.release,
        dryRun: parsed.dryRun,
        env: context.env,
        runner: nodeCommandRunner
      });
      return { ok: true, message: formatJsonResult(result), data: result };
    }
  },
  {
    id: "cloud.deploy",
    description: "Deploy Kanna Firebase cloud services.",
    inputSchema: cloudDeployInputSchema,
    execute: async (_context, input) => {
      const parsed = cloudDeployInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      if (parsed.staging && parsed.production) {
        return { ok: false, message: "cloud deploy accepts only one of --staging or --production." };
      }
      if (!parsed.staging && !parsed.production) {
        return { ok: false, message: "cloud deploy requires --staging or --production." };
      }
      const environment = parsed.staging ? "staging" : "production";
      try {
        const result = await deployFirebaseCloud({
          repoRoot: context.repoRoot,
          env: context.env,
          runner: nodeCommandRunner,
          environment,
          relay: parsed.relay
        });
        return { ok: true, message: formatJsonResult(result), data: result };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }
  },
  {
    id: "cloud.relay-provision",
    description: "Build the relay VM provisioning command plan.",
    inputSchema: cloudRelayProvisionInputSchema,
    execute: async (_context, input) => {
      const parsed = cloudRelayProvisionInputSchema.parse(input);
      if (parsed.staging && parsed.production) {
        return { ok: false, message: "cloud relay-provision accepts only one of --staging or --production." };
      }
      if (!parsed.staging && !parsed.production) {
        return { ok: false, message: "cloud relay-provision requires --staging or --production." };
      }
      const environment = parsed.staging ? "staging" : "production";
      const plan = buildRelayProvisionPlan({ environment });
      return {
        ok: true,
        message: formatJsonResult(plan),
        data: plan
      };
    }
  },
  {
    id: "test.app-update-bundle",
    description: "Run the full-bundle app update E2E test.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      return runBuiltCommand("bash", ["scripts/app-update-full-bundle-e2e.sh"], context.repoRoot, context.env);
    }
  },
  {
    id: "test.cloud-emulator",
    description: "Run cloud sync E2E against Firebase emulators.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const [command, args] = buildCloudEmulatorTestCommand();
      return runBuiltCommand(command, args, context.repoRoot, context.env);
    }
  },
  {
    id: "test.cloud-staging",
    description: "Run cloud sync E2E against staging cloud services.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      try {
        requireCloudSmokeEnv(context.env, "staging");
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      const [command, args] = buildCloudSmokeCommand();
      return runBuiltCommand(command, args, context.repoRoot, buildCloudSmokeEnv(context.env, "staging"));
    }
  },
  {
    id: "test.cloud-prod-smoke",
    description: "Run minimal cloud smoke against production cloud services.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      try {
        requireCloudSmokeEnv(context.env, "production");
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      const [command, args] = buildCloudSmokeCommand();
      return runBuiltCommand(command, args, context.repoRoot, buildCloudSmokeEnv(context.env, "production"));
    }
  },
  {
    id: "test.lan-lab",
    description: "Run LAN sync tests against physical Macs over SSH.",
    inputSchema: lanLabInputSchema,
    execute: async (_context, input) => {
      const parsed = lanLabInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      const inventory = parseLanLabInventory(await readFile(resolve(context.repoRoot, parsed.hosts), "utf8"));
      const runId = `run-${Date.now()}`;
      const plan = buildLanLabPlan({ runId, hosts: inventory.hosts, tunnelBasePort: 46000 });
      const results = [];
      for (const worker of plan.workers) {
        const result = await nodeCommandRunner.run("ssh", worker.startSshArgs, {
          cwd: context.repoRoot,
          env: context.env,
        });
        results.push({
          host: worker.host.name,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        });
        if (result.exitCode !== 0) {
          return {
            ok: false,
            message: `LAN lab worker ${worker.host.name} failed: ${result.stderr || result.stdout}`,
            data: { runId, results },
          };
        }
      }
      const tunnelProcesses = plan.workers.map((worker) =>
        spawn("ssh", worker.tunnelArgs, { stdio: "ignore" })
      );
      try {
        await Promise.all(plan.workers.map((worker) =>
          waitForTcpPort(worker.localWebDriverPort, 30_000)
        ));
        const [source, observer] = plan.workers;
        if (!source || !observer) {
          throw new Error("LAN lab requires at least two hosts");
        }
        const scenario = buildLanLabScenarioCommand({
          prompt: "LAN lab visible task",
          source: {
            repo: source.host.repo,
            peerId: source.peerId,
            displayName: source.host.name,
            localWebDriverPort: source.localWebDriverPort,
          },
          observer: {
            repo: observer.host.repo,
            peerId: observer.peerId,
            displayName: observer.host.name,
            localWebDriverPort: observer.localWebDriverPort,
          },
        });
        const scenarioResult = await nodeCommandRunner.run(scenario.command, scenario.args, {
          cwd: context.repoRoot,
          env: context.env,
        });
        if (scenarioResult.exitCode !== 0) {
          return {
            ok: false,
            message: scenarioResult.stderr || scenarioResult.stdout || "LAN lab scenario failed.",
            data: { runId, results, scenarioResult },
          };
        }
      } finally {
        for (const tunnel of tunnelProcesses) {
          tunnel.kill("SIGTERM");
        }
      }
      return {
        ok: true,
        message: `LAN lab run ${runId} passed.`,
        data: { runId, results },
      };
    }
  },
  {
    id: "daemon.kill",
    description: "Kill Kanna daemon processes for this workspace.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const result = await killWorkspaceDaemons({
        repoRoot: context.repoRoot,
        daemonDir: context.env.KANNA_DAEMON_DIR ?? "",
        runner: nodeCommandRunner
      });
      return {
        ok: true,
        message: formatJsonResult(result),
        data: result
      };
    }
  },
  {
    id: "doctor",
    description: "Check Kanna development prerequisites.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const result = await checkRequiredCommands(nodeCommandRunner, ["git", "pnpm", "tmux", "rustc", "cargo", "sqlite3"]);
      return {
        ok: result.ok,
        message: formatJsonResult(result.commands),
        data: result
      };
    }
  }
] satisfies TaskDefinition[];

export function getTaskDefinition(id: string): TaskDefinition {
  const definition = taskDefinitions.find((task) => task.id === id);
  if (!definition) {
    throw new Error(`Unknown kd task: ${id}`);
  }
  return definition;
}
