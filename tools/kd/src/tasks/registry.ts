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
import { killWorkspaceDaemons, killWorkspaceDesktopDevProcesses, killWorkspaceServers } from "../runtime/daemon";
import { checkRequiredCommands } from "../runtime/doctor";
import { syncMachineLocalConfig, writeCargoConfig } from "../runtime/env-sync";
import { buildFirebaseCommandEnv, buildFirebaseEmulatorArgs, formatMissingFirebaseEmulators, resolveFirebaseEnvFromReference, writeFirebaseEmulatorConfig, type FirebasePortInput } from "../runtime/firebase";
import { resolveMobileServerUrl } from "../runtime/mobile";
import { buildMobileDeviceSmokeCommand, buildMobileTestCommand } from "../runtime/mobile-commands";
import { executeMobileIosArchiveWithContext } from "../runtime/mobile-archive";
import {
  buildMobileDeviceInstallAppCommand,
  buildMobileDeviceLaunchAppCommand,
  buildMobileDeviceListAppsCommand,
  buildMobileDevicePrebuildCommand,
  buildMobileDeviceReleaseBuildCommand,
  buildMobileDeviceRelaunchCommand,
  buildMobileDeviceRunCommand,
  buildMobileDeviceUninstallAppCommand,
  checkPhysicalDeviceRunPreflight,
  isMobileDeviceAppInstalled,
  mobileDeviceDerivedDataPath,
  resolveMobileIosWorkspace,
  resolveMobileNativeIdentity,
  resolveMobileReleaseAppPath,
  resolvePhysicalDevice,
  waitForPhysicalDeviceMetroReadiness,
  type PhysicalDeviceMetroReadinessInput
} from "../runtime/mobile-device";
import {
  executeProductionMobileQa,
  formatProductionMobileQaResult,
  isProductionMobileQaOk
} from "../runtime/mobile-qa";
import {
  executeMobileOtaDoctorWithContext,
  executeMobileOtaProvisionWithContext,
  executeMobileOtaProvisionSecretWithContext,
  executeMobileOtaPublishWithContext,
  executeMobileOtaStatusWithContext
} from "../runtime/mobile-ota";
import { buildConfigSchemaPages } from "../runtime/pages";
import { getPortStatuses } from "../runtime/port-status";
import { executeRemoteE2e } from "../runtime/remote-e2e";
import { executeStagingSmoke } from "../runtime/staging-smoke";
import { nodeCommandRunner, type CommandResult, type CommandRunner } from "../runtime/process";
import { readDevDesktopAuth, readStagingDesktopAuth } from "../runtime/developer-config";
import {
  listStagingRelayActiveDesktopIds,
  type StagingRelayActiveDesktopIdsInput
} from "../runtime/staging-relay";
import {
  cutReleaseBranch,
  releaseStatus,
  resetStagingLineage,
  shipRelease
} from "../runtime/release";
import { loadReleaseEnvironment } from "../runtime/release-env";
import {
  preflightNotarizationCredentials,
  setupNotarizationCredentials
} from "../runtime/notarization";
import {
  applyRustCacheEnvironment,
  getRustCacheStatus,
  installRustCache
} from "../runtime/rust-cache";
import { executeRustTests } from "../runtime/rust-test";
import { buildDesktopSidecars } from "../runtime/sidecars";
import { checkSetupPrerequisites, installSetupDependencies } from "../runtime/setup";
import { getDevStatus } from "../runtime/status";
import { executeTestAll } from "../runtime/test-all";
import { captureTmuxLog, respawnTmuxWindow, startTmuxSession, stopTmuxSession, stopTmuxWindow } from "../runtime/tmux";
import { readDesktopBundleIdentifier, writeTauriLocalConfig } from "../runtime/tauri";
import type { KdPorts } from "../ports";
import type { TaskDefinition, TaskResult } from "./types";

export { listStagingRelayActiveDesktopIds } from "../runtime/staging-relay";

export interface DevUpInput {
  mobile: boolean;
  emulators: boolean;
  remote?: boolean;
  seed: boolean;
  attach: boolean;
  deleteDb: boolean;
  killDaemon: boolean;
  withCredentials?: boolean;
  db?: string;
  daemonDir?: string;
  transferRoot?: string;
  firebaseEnvFrom?: string;
  staging?: boolean;
}

export type RestartComponent = "desktop" | "mobile" | "backend";

export interface DevRestartInput extends DevUpInput {
  component?: RestartComponent;
  staging: boolean;
  production: boolean;
  withCredentials?: boolean;
}

export interface DevDownInput {
  killDaemon: boolean;
}

export interface MobileUpInput {
  production: boolean;
  staging: boolean;
  withCredentials?: boolean;
}

export interface MobileRunInput {
  device: boolean;
  production?: boolean;
  staging?: boolean;
  install?: boolean;
  withCredentials?: boolean;
}

export interface MobileUninstallInput {
  device: boolean;
  production: boolean;
  staging: boolean;
  confirmBundle: string;
  confirmProduction: boolean;
}

export interface MobileQaInput {
  production: boolean;
  ota: boolean;
}

export const devUpInputSchema = z.object({
  mobile: z.boolean().default(false),
  emulators: z.boolean().default(false),
  remote: z.boolean().default(false),
  seed: z.boolean().default(false),
  attach: z.boolean().default(false),
  deleteDb: z.boolean().default(false),
  killDaemon: z.boolean().default(false),
  db: z.string().optional(),
  daemonDir: z.string().optional(),
  transferRoot: z.string().optional(),
  firebaseEnvFrom: z.string().optional(),
  staging: z.boolean().default(false),
  withCredentials: z.boolean().default(false)
});

const devRestartInputSchema = devUpInputSchema.extend({
  component: z.enum(["desktop", "mobile", "backend"]).optional(),
  staging: z.boolean().default(false),
  production: z.boolean().default(false),
  withCredentials: z.boolean().default(false)
});

const devDownInputSchema = z.object({
  killDaemon: z.boolean().default(false)
});

const mobileUpInputSchema = z.object({
  production: z.boolean().default(false),
  staging: z.boolean().default(false),
  withCredentials: z.boolean().default(false)
});

const mobileRunInputSchema = z.object({
  device: z.boolean().default(false),
  production: z.boolean().default(false),
  staging: z.boolean().default(false),
  install: z.boolean().default(false),
  withCredentials: z.boolean().default(false)
});

const mobileUninstallInputSchema = z.object({
  device: z.boolean().default(false),
  production: z.boolean().default(false),
  staging: z.boolean().default(false),
  confirmBundle: z.string(),
  confirmProduction: z.boolean().default(false)
});

const mobileQaInputSchema = z.object({
  production: z.boolean().default(false),
  ota: z.boolean().default(false)
});

const mobileArchiveInputSchema = z.object({
  production: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  upload: z.boolean().default(false),
  buildNumber: z.string().optional(),
  version: z.string().optional(),
  outDir: z.string().optional()
});

const mobileOtaPublishInputSchema = z.object({
  production: z.boolean().default(false),
  staging: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  rollbackTo: z.string().optional()
});

const mobileOtaStatusInputSchema = z.object({
  production: z.boolean().default(false),
  staging: z.boolean().default(false)
});

const mobileOtaDoctorInputSchema = z.object({
  production: z.boolean().default(false),
  staging: z.boolean().default(false)
});

const mobileOtaProvisionInputSchema = z.object({
  production: z.boolean().default(false),
  staging: z.boolean().default(false)
});

const mobileOtaProvisionSecretInputSchema = z.object({
  production: z.boolean().default(false),
  staging: z.boolean().default(false),
  keyPath: z.string()
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

const remoteE2eInputSchema = z.object({
  dev: z.boolean().default(true),
  staging: z.boolean().default(false),
  mobileRelay: z.boolean().default(false),
  desktopPairing: z.boolean().default(false),
  ifChanged: z.boolean().default(false)
});

const remoteDoctorInputSchema = z.object({
  staging: z.boolean().default(false)
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
  staging: z.boolean().default(false),
  production: z.boolean().default(false),
  release: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  rollbackTo: z.string().optional(),
  branch: z.string().optional()
});

const releasePromoteInputSchema = z.object({
  version: z.string(),
  arm64: z.boolean().default(false),
  x86_64: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  overrideSoak: z
    .string()
    .describe(
      "Explicit human reason for promoting before the release-policy soak window elapses. Waives only the soak gate."
    )
    .optional()
});

const releaseResetStagingInputSchema = z.object({
  to: z.string().describe("Branch the staging channel is handed to next: main or release/X.Y."),
  reason: z.string().describe("Why this staging lineage is being abandoned. Recorded on the desktop-staging release."),
  confirmAbandon: z
    .string()
    .describe("The exact active staging version being abandoned, as reported by kd release status."),
  dryRun: z.boolean().default(false)
});

const releaseCutInputSchema = z.object({
  major: z.boolean().default(false),
  minor: z.boolean().default(false),
  patch: z.boolean().default(false),
  version: z
    .string()
    .describe(
      "Explicit target series version X.Y.0. Names the intended next series directly instead of inferring it from origin/main's VERSION — the only way to skip a series that is being abandoned rather than released."
    )
    .optional(),
  abandonSeries: z
    .string()
    .describe(
      "Comma-separated release series (X.Y) this cut deliberately steps over. Each is recorded as an annotated abandoned/release/X.Y tag; the branch is kept, never deleted."
    )
    .optional(),
  reason: z.string().describe("Why no production release will come from the abandoned series.").optional()
});

const releaseStatusInputSchema = z.object({});

const releaseSetupNotarizationInputSchema = z.object({
  profile: z.string().optional(),
  keychain: z.string().optional()
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
  metroReadiness?: Pick<PhysicalDeviceMetroReadinessInput, "attempts" | "delayMs">;
  readInstalledStagingDesktopStatus?: (runner: CommandRunner) => Promise<ProductionDesktopStatus | null>;
  listStagingRelayActiveDesktopIds?: (input: StagingRelayActiveDesktopIdsInput) => Promise<Set<string> | null>;
}

export interface MobileDeviceUninstallExecutionOptions {
  writeOutput?: (message: string) => void;
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
  const context = resolveKdContext({
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
  // Every Cargo command kd spawns — sidecars, Rust tests, and the Tauri dev
  // window — inherits this environment. Release commands strip it again in
  // loadReleaseEnvironment.
  const cache = applyRustCacheEnvironment({ repoRoot, homeDir, env: context.env });
  return { ...context, env: cache.env };
}

export async function loadReleaseTaskEnvironment(
  context: Pick<KdContext, "homeDir" | "env">
): Promise<NodeJS.ProcessEnv> {
  return loadReleaseEnvironment({
    homeDir: context.homeDir,
    env: context.env
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

export async function executeDevUpWithContext(input: DevUpInput, executor: ExecutorInput): Promise<TaskResult> {
  const dbTarget = devDbTarget(executor.context);
  assertNotProductionDb(dbTarget);
  const devPorts = requireMobileDeviceDevPorts(executor.context.ports);

  if (input.firebaseEnvFrom) {
    const statuses = await getPortStatuses(executor.runner, {
      auth: devPorts.KANNA_FIREBASE_AUTH_PORT,
      firestore: devPorts.KANNA_FIREBASE_FIRESTORE_PORT,
      functions: devPorts.KANNA_FIREBASE_FUNCTIONS_PORT,
      ui: devPorts.KANNA_FIREBASE_UI_PORT
    });
    const missing = formatMissingFirebaseEmulators(input.firebaseEnvFrom, statuses);
    if (missing) {
      throw new Error(missing);
    }
  }

  if (input.deleteDb) {
    await resetSqliteDb(executor.runner, dbTarget);
  }

  const env: NodeJS.ProcessEnv = input.staging
    ? {
        ...executor.context.env,
        KANNA_CLOUD_ENV: "staging",
        KANNA_APP_ENV: executor.context.env.KANNA_APP_ENV ?? "staging"
      }
    : executor.context.env;
  const emulators = input.emulators ||
    input.remote === true ||
    (input.withCredentials === true && input.staging !== true && !input.firebaseEnvFrom);
  const firebaseConfigPath = writeFirebaseEmulatorConfig(executor.context.repoRoot, devPorts);
  writeTauriLocalConfig(executor.context.repoRoot, devPorts.KANNA_DEV_PORT);
  const plan = buildDevPlan({
    repoRoot: executor.context.repoRoot,
    env,
    desktopSecretEnv: desktopCredentialEnv(input, env, input.staging ? "staging" : "dev"),
    mobile: input.mobile,
    emulators,
    firebaseConfigPath,
    mobileServerUrl: resolveMobileServerUrl(env)
  });

  await startTmuxSession(executor.runner, executor.context.tmux, plan.windows);
  if (input.seed) {
    await seedSqliteDb(executor.runner, executor.context.repoRoot, env.KANNA_DB_PATH ?? "");
  }
  if (input.attach) {
    await executor.runner.run("tmux", ["-L", executor.context.tmux.server, "attach", "-t", executor.context.tmux.session]);
  }

  return {
    ok: true,
    message: `Started tmux session '${executor.context.tmux.session}'.`,
    data: { windows: plan.windows.map((window) => window.name), remote: input.remote }
  };
}

async function executeDevUp(input: DevUpInput): Promise<TaskResult> {
  const context = await resolveDefaultContext(process.env, {
    dbOverride: input.db,
    daemonDirOverride: input.daemonDir,
    transferRootOverride: input.transferRoot,
    firebaseEnvFrom: input.firebaseEnvFrom
  });
  return executeDevUpWithContext(input, {
    runner: nodeCommandRunner,
    context: {
      repoRoot: context.repoRoot,
      tmux: context.tmux,
      ports: context.ports,
      env: context.env
    }
  });
}

type ResolvedRestartEnvironment = "dev" | "staging" | "production";

function resolveRestartEnvironment(input: DevRestartInput): ResolvedRestartEnvironment {
  if (input.staging && input.production) {
    throw new Error("dev.restart accepts only one of --production or --staging.");
  }
  if (input.staging) {
    return "staging";
  }
  if (input.production) {
    return "production";
  }
  return "dev";
}

async function buildRestartWindow(
  input: DevRestartInput,
  executor: ExecutorInput,
  environment: ResolvedRestartEnvironment
) {
  const component = input.component;
  if (!component) {
    throw new Error("A restart component is required.");
  }

  if (component === "backend") {
    return undefined;
  }

  if (environment === "production" && component === "mobile") {
    const [status, serverConfigPath] = await Promise.all([
      readProductionDesktopStatus(executor.runner),
      assertProductionServerConfig(executor.runner, executor.context.env)
    ]);
    const env = {
      ...executor.context.env,
      EXPO_PUBLIC_KANNA_RELAY_URL:
        executor.context.env.EXPO_PUBLIC_KANNA_RELAY_URL ?? status.relay_url ?? status.relayUrl
    };
    const plan = buildProductionMobilePlan({
      repoRoot: executor.context.repoRoot,
      env,
      environment: "production"
    });
    return { window: plan.windows.find((window) => window.name === component), data: { serverConfigPath } };
  }

  const env: NodeJS.ProcessEnv = {
    ...executor.context.env,
    ...(environment === "dev"
      ? {}
      : {
          KANNA_CLOUD_ENV: environment,
          KANNA_APP_ENV: executor.context.env.KANNA_APP_ENV ?? environment
        })
  };

  if (environment !== "dev" && component === "mobile") {
    const plan = buildProductionMobilePlan({
      repoRoot: executor.context.repoRoot,
      env,
      environment
    });
    return { window: plan.windows.find((window) => window.name === component), data: {} };
  }

  if (component === "desktop") {
    writeTauriLocalConfig(executor.context.repoRoot, requireNumberPort(executor.context.ports, "KANNA_DEV_PORT"));
  }
  const firebaseConfigPath = input.emulators
    ? writeFirebaseEmulatorConfig(executor.context.repoRoot, requireMobileDeviceDevPorts(executor.context.ports))
    : "";
  const plan = buildDevPlan({
    repoRoot: executor.context.repoRoot,
    env,
    desktopSecretEnv: component === "desktop"
      ? desktopCredentialEnv(input, env, environment)
      : undefined,
    mobile: component === "mobile",
    emulators: input.emulators,
    firebaseConfigPath,
    mobileServerUrl: resolveMobileServerUrl(env)
  });
  return { window: plan.windows.find((window) => window.name === component), data: {} };
}

export async function executeDevRestartWithContext(
  input: DevRestartInput,
  executor: ExecutorInput
): Promise<TaskResult> {
  if (!input.component) {
    const stopped = await executeDevDownWithContext({ killDaemon: input.killDaemon }, executor);
    return {
      ok: false,
      message: "Whole-stack restart requires the default kd executor so dev up can resolve the current repo context.",
      data: stopped.data
    };
  }

  if (input.component === "backend") {
    return {
      ok: false,
      message: "Component restart for backend is not supported yet. Backend processes are owned by the desktop window; restart desktop instead.",
      data: { component: input.component }
    };
  }

  const environment = resolveRestartEnvironment(input);
  const restart = await buildRestartWindow(input, executor, environment);
  const window = restart?.window;
  if (!window) {
    return {
      ok: false,
      message: `Could not resolve ${input.component} restart plan.`,
      data: { component: input.component, environment }
    };
  }

  const desktopCleanup = input.component === "desktop"
    ? await killWorkspaceDesktopDevProcesses({
        repoRoot: executor.context.repoRoot,
        runner: executor.runner
      })
    : undefined;
  const restarted = await respawnTmuxWindow(executor.runner, executor.context.tmux, window);
  return {
    ok: restarted,
    message: restarted
      ? `Restarted ${input.component} tmux window.`
      : `No running ${input.component} tmux window found in session '${executor.context.tmux.session}'.`,
    data: {
      component: input.component,
      environment,
      desktopCleanup,
      ...restart.data
    }
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

async function readInstalledStagingDesktopStatus(runner: CommandRunner): Promise<ProductionDesktopStatus | null> {
  const result = await runner.run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "http://127.0.0.1:48121/v1/status"
  ]);
  if (result.exitCode !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout) as ProductionDesktopStatus;
    return parsed.desktopId ? parsed : null;
  } catch {
    return null;
  }
}

async function checkInstalledStagingDesktopRelayOwner(input: {
  runner: CommandRunner;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  readStatus?: (runner: CommandRunner) => Promise<ProductionDesktopStatus | null>;
  listActiveDesktopIds?: (input: StagingRelayActiveDesktopIdsInput) => Promise<Set<string> | null>;
}): Promise<TaskResult | null> {
  const staging = resolveKdEnvironment("staging");
  const status = await (input.readStatus ?? readInstalledStagingDesktopStatus)(input.runner);
  const desktopId = status?.desktopId?.trim();
  if (!desktopId) return null;

  let activeDesktopIds: Set<string> | null;
  try {
    activeDesktopIds = await (input.listActiveDesktopIds ?? listStagingRelayActiveDesktopIds)({
      repoRoot: input.repoRoot,
      env: input.env,
      relayUrl: staging.relayUrl
    });
  } catch (error) {
    return {
      ok: false,
      message:
        "Could not verify installed staging desktop relay status: " +
        `${error instanceof Error ? error.message : String(error)}`,
      data: {
        desktopId,
        relayUrl: staging.relayUrl
      }
    };
  }

  if (!activeDesktopIds) return null;
  if (activeDesktopIds.has(desktopId)) return null;

  return {
    ok: false,
    message:
      `Installed staging desktop ${desktopId} is not active in staging relay. ` +
      "Restart the installed Kanna Staging desktop/server before launching the staging mobile app; " +
      "otherwise task terminals owned by that desktop will report Desktop offline.",
    data: {
      desktopId,
      relayUrl: staging.relayUrl,
      activeDesktopIds: Array.from(activeDesktopIds)
    }
  };
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
    const mobilePlan = buildProductionMobilePlan({
      repoRoot: executor.context.repoRoot,
      env,
      environment: "staging"
    });

    await startTmuxSession(executor.runner, executor.context.tmux, mobilePlan.windows);
    const ownerCheck = await checkInstalledStagingDesktopRelayOwner({
      runner: executor.runner,
      repoRoot: executor.context.repoRoot,
      env
    });
    if (ownerCheck) return ownerCheck;

    return {
      ok: true,
      message: "Started mobile against staging cloud environment.",
      data: {
        relayUrl: staging.relayUrl,
        windows: mobilePlan.windows.map((window) => window.name)
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

function desktopCredentialEnv(
  input: { withCredentials?: boolean },
  env: NodeJS.ProcessEnv,
  environment: "dev" | "staging" | "production"
): NodeJS.ProcessEnv {
  if (!input.withCredentials) return {};
  if (environment === "production") return {};
  const home = env.HOME?.trim() || homedir();
  const credentials = environment === "staging"
    ? readStagingDesktopAuth(home)
    : readDevDesktopAuth(home);
  return {
    KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: credentials.email,
    KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD: credentials.password
  };
}

function isTransientExpoMetroFailure(result: { stdout: string; stderr: string }): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return (
    output.includes("Metro is not reachable") ||
    output.includes("No script URL provided") ||
    output.includes("Could not connect to development server")
  );
}

function formatPhysicalDeviceRunSuccess(input: {
  bundleId: string;
  deviceName: string;
  metroUrl: string;
  recoveryMessage?: string;
  checks: Awaited<ReturnType<typeof checkPhysicalDeviceRunPreflight>>["checks"];
}): string {
  return [
    `Launched Kanna mobile on ${input.deviceName}.`,
    `Bundle ID: ${input.bundleId}`,
    `Metro: ${input.metroUrl}`,
    "App: installed and launched.",
    ...(input.recoveryMessage ? [input.recoveryMessage] : []),
    formatPhysicalDevicePreflight(input.checks)
  ].join("\n");
}

function formatPhysicalDeviceRunFailure(input: {
  bundleId: string;
  deviceName: string;
  metroUrl: string;
  appState: string;
  reason: string;
}): string {
  return [
    `Failed to launch Kanna mobile on ${input.deviceName}.`,
    `Bundle ID: ${input.bundleId}`,
    `Metro: ${input.metroUrl}`,
    `App: ${input.appState}`,
    input.reason,
    "On the iPhone, allow Local Network for Kanna in Settings -> Privacy & Security -> Local Network."
  ].join("\n");
}

function formatPhysicalDeviceInstallSuccess(input: {
  bundleId: string;
  deviceName: string;
  environment: string;
}): string {
  return [
    `Installed and launched Kanna mobile on ${input.deviceName}.`,
    `Bundle ID: ${input.bundleId}`,
    `Environment: ${input.environment}`,
    "Metro is not required for this Release install because JavaScript is bundled into the app."
  ].join("\n");
}

// xcodebuild logs are streamed live and can run to megabytes; keep only the
// tail (where the failing step and signing errors appear) in the task result.
function tailCommandResult(result: CommandResult, lines: number): CommandResult {
  const tail = (text: string): string => text.split("\n").slice(-lines).join("\n");
  return { exitCode: result.exitCode, stdout: tail(result.stdout), stderr: tail(result.stderr) };
}

function formatPhysicalDeviceInstallFailure(input: {
  bundleId: string;
  deviceName: string;
  environment: string;
  phase: "prebuild" | "build" | "install" | "launch";
  result: CommandResult;
}): string {
  const output = [input.result.stderr.trim(), input.result.stdout.trim()].filter(Boolean).join("\n");
  return [
    `Failed to ${input.phase} Kanna mobile on ${input.deviceName}.`,
    `Bundle ID: ${input.bundleId}`,
    `Environment: ${input.environment}`,
    `Exit code: ${input.result.exitCode}`,
    output ? `Command output:\n${output}` : "Command output: <empty>"
  ].join("\n");
}

function physicalDeviceChecksWithMetroReadiness(input: {
  checks: Awaited<ReturnType<typeof checkPhysicalDeviceRunPreflight>>["checks"];
  metroMessage: string;
  metroOk: boolean;
}): Awaited<ReturnType<typeof checkPhysicalDeviceRunPreflight>>["checks"] {
  return input.checks.map((check) =>
    check.name === "metro-lan"
      ? { name: "metro-lan", ok: input.metroOk, message: input.metroMessage }
      : check
  );
}

export async function executeMobileDeviceRunWithContext(
  input: MobileRunInput,
  executor: ExecutorInput,
  options: MobileDeviceRunExecutionOptions = {}
): Promise<TaskResult> {
  if (!input.device) {
    throw new Error("mobile.run requires --device.");
  }
  if (input.production && input.staging) {
    throw new Error("mobile.run accepts only one of --production or --staging.");
  }

  const device = await resolvePhysicalDevice(executor.runner, {
    requestedUdid: executor.context.env.KANNA_IOS_DEVICE_UDID?.trim() || undefined,
    requestedName: executor.context.env.KANNA_IOS_PHYSICAL_DEVICE_NAME?.trim() || undefined
  });
  const buildEnv = mobileDeviceInstallEnv(input, executor, device.udid);
  if (input.install) {
    return executeMobileDeviceReleaseInstall(input, executor, device, buildEnv);
  }

  const lanHost = requireMobileDeviceLanHost(options);
  const launch = prepareMobileDeviceLaunch(input, executor, lanHost, buildEnv);
  await launch.resetTmux();
  await startTmuxSession(executor.runner, executor.context.tmux, launch.plan.windows);
  if (input.staging) {
    const ownerCheck = await checkInstalledStagingDesktopRelayOwner({
      runner: executor.runner,
      repoRoot: executor.context.repoRoot,
      env: launch.env,
      readStatus: options.readInstalledStagingDesktopStatus,
      listActiveDesktopIds: options.listStagingRelayActiveDesktopIds
    });
    if (ownerCheck) return ownerCheck;
  }

  const metroPort = Number.parseInt(launch.env.KANNA_MOBILE_PORT ?? "8081", 10);
  if (Number.isNaN(metroPort)) {
    throw new Error(`KANNA_MOBILE_PORT must be an integer, got: ${launch.env.KANNA_MOBILE_PORT}`);
  }

  const nativeIdentity = resolveMobileNativeIdentity(launch.env);
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
    env: { ...launch.env, ...prebuildCommand.env },
    streamOutput: true
  });
  if (prebuildResult.exitCode !== 0) {
    return {
      ok: false,
      message:
        prebuildResult.stderr ||
        prebuildResult.stdout ||
        formatPhysicalDeviceRunFailure({
          bundleId: nativeIdentity.bundleId,
          deviceName: device.name,
          metroUrl: preflight.metroUrl,
          appState: "not launched because prebuild failed.",
          reason: `Failed to prebuild Kanna mobile for ${nativeIdentity.bundleId}.`
        }),
      data: {
        bundleId: nativeIdentity.bundleId,
        device,
        metroUrl: preflight.metroUrl,
        preflight,
        windows: launch.plan.windows.map((window) => window.name)
      }
    };
  }

  const initialMetroReadiness = await waitForPhysicalDeviceMetroReadiness(executor.runner, {
    lanHost,
    metroPort,
    ...options.metroReadiness
  });
  if (!initialMetroReadiness.ok) {
    return {
      ok: false,
      message: formatPhysicalDeviceRunFailure({
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        metroUrl: initialMetroReadiness.metroUrl,
        appState: "not launched because Metro was not ready.",
        reason: `FAIL metro-lan: ${initialMetroReadiness.message}`
      }),
      data: {
        bundleId: nativeIdentity.bundleId,
        device,
        metroUrl: initialMetroReadiness.metroUrl,
        preflight,
        metroReadiness: initialMetroReadiness,
        windows: launch.plan.windows.map((window) => window.name)
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
    env: { ...launch.env, ...runCommand.env },
    streamOutput: true
  });
  const postLaunchMetroReadiness = await waitForPhysicalDeviceMetroReadiness(executor.runner, {
    lanHost,
    metroPort,
    ...options.metroReadiness
  });

  if (runResult.exitCode === 0 && postLaunchMetroReadiness.ok) {
    return {
      ok: true,
      message: formatPhysicalDeviceRunSuccess({
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        metroUrl: postLaunchMetroReadiness.metroUrl,
        checks: physicalDeviceChecksWithMetroReadiness({
          checks: preflight.checks,
          metroMessage: postLaunchMetroReadiness.message,
          metroOk: true
        })
      }),
      data: {
        bundleId: nativeIdentity.bundleId,
        device,
        metroUrl: postLaunchMetroReadiness.metroUrl,
        preflight,
        metroReadiness: {
          beforeLaunch: initialMetroReadiness,
          afterLaunch: postLaunchMetroReadiness
        },
        windows: launch.plan.windows.map((window) => window.name)
      }
    };
  }

  if (
    runResult.exitCode !== 0 &&
    postLaunchMetroReadiness.ok &&
    isTransientExpoMetroFailure(runResult)
  ) {
    const relaunchCommand = buildMobileDeviceRelaunchCommand({
      bundleId: nativeIdentity.bundleId,
      deviceUdid: device.udid,
      devClientScheme: nativeIdentity.devClientScheme,
      lanHost,
      metroPort
    });
    const relaunchResult = await executor.runner.run(relaunchCommand.command, relaunchCommand.args, {
      streamOutput: true
    });
    if (relaunchResult.exitCode === 0) {
      return {
        ok: true,
        message: formatPhysicalDeviceRunSuccess({
          bundleId: nativeIdentity.bundleId,
          deviceName: device.name,
          metroUrl: postLaunchMetroReadiness.metroUrl,
          recoveryMessage: `Recovered by relaunching ${nativeIdentity.bundleId} after Metro became reachable.`,
          checks: physicalDeviceChecksWithMetroReadiness({
            checks: preflight.checks,
            metroMessage: postLaunchMetroReadiness.message,
            metroOk: true
          })
        }),
        data: {
          bundleId: nativeIdentity.bundleId,
          device,
          metroUrl: postLaunchMetroReadiness.metroUrl,
          preflight,
          metroReadiness: {
            beforeLaunch: initialMetroReadiness,
            afterLaunch: postLaunchMetroReadiness
          },
          recovered: true,
          windows: launch.plan.windows.map((window) => window.name)
        }
      };
    }
    return {
      ok: false,
      message: formatPhysicalDeviceRunFailure({
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        metroUrl: postLaunchMetroReadiness.metroUrl,
        appState: "installed, but relaunch failed.",
        reason: relaunchResult.stderr || relaunchResult.stdout || "Failed to relaunch the installed iOS app."
      }),
      data: {
        bundleId: nativeIdentity.bundleId,
        device,
        metroUrl: postLaunchMetroReadiness.metroUrl,
        preflight,
        metroReadiness: {
          beforeLaunch: initialMetroReadiness,
          afterLaunch: postLaunchMetroReadiness
        },
        recovered: false,
        windows: launch.plan.windows.map((window) => window.name)
      }
    };
  }

  return {
    ok: false,
    message: formatPhysicalDeviceRunFailure({
      bundleId: nativeIdentity.bundleId,
      deviceName: device.name,
      metroUrl: postLaunchMetroReadiness.metroUrl,
      appState: runResult.exitCode === 0 ? "installed and launched, but Metro was not reachable afterward." : "install or launch failed.",
      reason:
        runResult.exitCode === 0
          ? `FAIL metro-lan: ${postLaunchMetroReadiness.message}`
          : runResult.stderr || runResult.stdout || "The iOS install or launch command failed."
    }),
    data: {
      bundleId: nativeIdentity.bundleId,
      device,
      metroUrl: postLaunchMetroReadiness.metroUrl,
      preflight,
      metroReadiness: {
        beforeLaunch: initialMetroReadiness,
        afterLaunch: postLaunchMetroReadiness
      },
      windows: launch.plan.windows.map((window) => window.name)
    }
  };
}

function mobileDeviceInstallEnv(
  input: MobileRunInput,
  executor: ExecutorInput,
  deviceUdid: string
): NodeJS.ProcessEnv {
  if (input.staging) {
    return {
      ...executor.context.env,
      KANNA_CLOUD_ENV: "staging",
      KANNA_APP_ENV: "staging",
      KANNA_IOS_DEVICE_UDID: deviceUdid
    };
  }

  if (input.production) {
    const production = resolveKdEnvironment("prod");
    return {
      ...executor.context.env,
      KANNA_APP_ENV: executor.context.env.KANNA_APP_ENV ?? "prod",
      KANNA_IOS_DEVICE_UDID: deviceUdid,
      EXPO_PUBLIC_KANNA_RELAY_URL:
        executor.context.env.EXPO_PUBLIC_KANNA_RELAY_URL ?? production.relayUrl
    };
  }

  return {
    ...executor.context.env,
    KANNA_APP_ENV: executor.context.env.KANNA_APP_ENV ?? "dev",
    KANNA_IOS_DEVICE_UDID: deviceUdid
  };
}

async function executeMobileDeviceReleaseInstall(
  input: MobileRunInput,
  executor: ExecutorInput,
  device: Awaited<ReturnType<typeof resolvePhysicalDevice>>,
  env: NodeJS.ProcessEnv
): Promise<TaskResult> {
  const nativeIdentity = resolveMobileNativeIdentity(env);
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
      message: formatPhysicalDeviceInstallFailure({
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        environment: nativeIdentity.appEnv,
        phase: "prebuild",
        result: prebuildResult
      }),
      data: {
        bundleId: nativeIdentity.bundleId,
        environment: nativeIdentity.appEnv,
        device
      }
    };
  }

  const workspace = resolveMobileIosWorkspace(executor.context.repoRoot);
  const derivedDataPath = mobileDeviceDerivedDataPath(
    executor.context.repoRoot,
    nativeIdentity.appEnv
  );
  const buildCommand = buildMobileDeviceReleaseBuildCommand({
    repoRoot: executor.context.repoRoot,
    deviceUdid: device.udid,
    derivedDataPath,
    nativeIdentity,
    workspace
  });
  const buildResult = await executor.runner.run(buildCommand.command, buildCommand.args, {
    cwd: buildCommand.cwd,
    env: { ...env, ...buildCommand.env },
    streamOutput: true
  });
  if (buildResult.exitCode !== 0) {
    return {
      ok: false,
      message: formatPhysicalDeviceInstallFailure({
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        environment: nativeIdentity.appEnv,
        phase: "build",
        result: tailCommandResult(buildResult, 80)
      }),
      data: {
        bundleId: nativeIdentity.bundleId,
        environment: nativeIdentity.appEnv,
        device
      }
    };
  }

  const appPath = resolveMobileReleaseAppPath(derivedDataPath);
  const installCommand = buildMobileDeviceInstallAppCommand({
    appPath,
    deviceUdid: device.udid
  });
  const installResult = await executor.runner.run(installCommand.command, installCommand.args, {
    streamOutput: true
  });
  if (installResult.exitCode !== 0) {
    return {
      ok: false,
      message: formatPhysicalDeviceInstallFailure({
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        environment: nativeIdentity.appEnv,
        phase: "install",
        result: installResult
      }),
      data: {
        bundleId: nativeIdentity.bundleId,
        environment: nativeIdentity.appEnv,
        device
      }
    };
  }

  const launchCommand = buildMobileDeviceLaunchAppCommand({
    bundleId: nativeIdentity.bundleId,
    deviceUdid: device.udid
  });
  const launchResult = await executor.runner.run(launchCommand.command, launchCommand.args, {
    streamOutput: true
  });
  if (launchResult.exitCode !== 0) {
    return {
      ok: false,
      message: formatPhysicalDeviceInstallFailure({
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        environment: nativeIdentity.appEnv,
        phase: "launch",
        result: launchResult
      }),
      data: {
        bundleId: nativeIdentity.bundleId,
        environment: nativeIdentity.appEnv,
        device,
        appPath
      }
    };
  }

  return {
    ok: true,
    message: formatPhysicalDeviceInstallSuccess({
      bundleId: nativeIdentity.bundleId,
      deviceName: device.name,
      environment: nativeIdentity.appEnv
    }),
    data: {
      bundleId: nativeIdentity.bundleId,
      environment: nativeIdentity.appEnv,
      device,
      appPath
    }
  };
}

function prepareMobileDeviceLaunch(
  input: MobileRunInput,
  executor: ExecutorInput,
  lanHost: string,
  env: NodeJS.ProcessEnv
): {
  env: NodeJS.ProcessEnv;
  plan: ReturnType<typeof buildDevPlan>;
  resetTmux: () => Promise<void>;
} {
  if (input.staging) {
    const mobilePlan = buildProductionMobilePlan({
      repoRoot: executor.context.repoRoot,
      env,
      environment: "staging"
    });
    return {
      env,
      plan: mobilePlan,
      resetTmux: () => stopTmuxWindow(executor.runner, executor.context.tmux, "mobile")
        .then(() => undefined)
    };
  }

  if (input.production) {
    const plan = buildProductionMobilePlan({
      repoRoot: executor.context.repoRoot,
      env,
      environment: "production"
    });
    return {
      env,
      plan,
      resetTmux: () => stopTmuxWindow(executor.runner, executor.context.tmux, "mobile")
        .then(() => undefined)
    };
  }

  const devPorts = requireMobileDeviceDevPorts(executor.context.ports);
  const firebaseConfigPath = writeFirebaseEmulatorConfig(executor.context.repoRoot, devPorts);
  writeTauriLocalConfig(executor.context.repoRoot, devPorts.KANNA_DEV_PORT);
  const plan = buildDevPlan({
    repoRoot: executor.context.repoRoot,
    env,
    desktopSecretEnv: desktopCredentialEnv(input, env, "dev"),
    mobile: true,
    emulators: true,
    firebaseConfigPath,
    mobileServerUrl: resolveMobileServerUrl(env),
    resolveLanAddress: () => lanHost
  });
  return {
    env,
    plan,
    resetTmux: () => stopTmuxWindow(executor.runner, executor.context.tmux, "mobile")
      .then(() => undefined)
  };
}

function formatMobileDeviceCommandFailure(input: {
  action: string;
  bundleId: string;
  deviceName: string;
  result: CommandResult;
}): string {
  const output = [input.result.stderr.trim(), input.result.stdout.trim()].filter(Boolean).join("\n");
  return [
    `Failed to ${input.action} ${input.bundleId} on ${input.deviceName}.`,
    `Exit code: ${input.result.exitCode}`,
    output ? `Command output:\n${output}` : "Command output: <empty>"
  ].join("\n");
}

export async function executeMobileDeviceUninstallWithContext(
  input: MobileUninstallInput,
  executor: ExecutorInput,
  options: MobileDeviceUninstallExecutionOptions = {}
): Promise<TaskResult> {
  if (!input.device) {
    throw new Error("mobile.uninstall requires --device.");
  }
  if (input.production === input.staging) {
    throw new Error("mobile.uninstall requires exactly one of --staging or --production.");
  }

  const environment = input.staging ? "staging" : "prod";
  const nativeIdentity = resolveMobileNativeIdentity({ KANNA_APP_ENV: environment });
  if (input.confirmBundle !== nativeIdentity.bundleId) {
    throw new Error(
      `mobile.uninstall confirmation mismatch: expected --confirm-bundle ${nativeIdentity.bundleId}.`
    );
  }
  if (input.production && !input.confirmProduction) {
    throw new Error(
      "mobile.uninstall refuses production without the separate --confirm-production flag."
    );
  }

  const device = await resolvePhysicalDevice(executor.runner, {
    requestedUdid: executor.context.env.KANNA_IOS_DEVICE_UDID?.trim() || undefined,
    requestedName: executor.context.env.KANNA_IOS_PHYSICAL_DEVICE_NAME?.trim() || undefined
  });
  const writeOutput = options.writeOutput ?? ((message: string) => process.stderr.write(message));
  writeOutput(
    [
      `Target device: ${device.name} (${device.udid})`,
      `Target bundle: ${nativeIdentity.bundleId}`,
      "Operation: uninstall only this bundle."
    ].join("\n") + "\n"
  );

  const listAppsCommand = buildMobileDeviceListAppsCommand({ deviceUdid: device.udid });
  const before = await executor.runner.run(listAppsCommand.command, listAppsCommand.args);
  if (before.exitCode !== 0) {
    return {
      ok: false,
      message: formatMobileDeviceCommandFailure({
        action: "inspect installed apps before uninstalling",
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        result: before
      }),
      data: { bundleId: nativeIdentity.bundleId, device, present: undefined, removed: false }
    };
  }

  if (!isMobileDeviceAppInstalled(before.stdout, nativeIdentity.bundleId)) {
    return {
      ok: true,
      message:
        `${nativeIdentity.bundleId} was not present on ${device.name} (${device.udid}). ` +
        "No app was removed.",
      data: { bundleId: nativeIdentity.bundleId, device, present: false, removed: false }
    };
  }

  const uninstallCommand = buildMobileDeviceUninstallAppCommand({
    bundleId: nativeIdentity.bundleId,
    deviceUdid: device.udid
  });
  const uninstall = await executor.runner.run(uninstallCommand.command, uninstallCommand.args, {
    streamOutput: true
  });
  if (uninstall.exitCode !== 0) {
    return {
      ok: false,
      message: formatMobileDeviceCommandFailure({
        action: "uninstall",
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        result: uninstall
      }),
      data: { bundleId: nativeIdentity.bundleId, device, present: true, removed: false }
    };
  }

  const after = await executor.runner.run(listAppsCommand.command, listAppsCommand.args);
  if (after.exitCode !== 0) {
    return {
      ok: false,
      message: formatMobileDeviceCommandFailure({
        action: "verify removal of",
        bundleId: nativeIdentity.bundleId,
        deviceName: device.name,
        result: after
      }),
      data: { bundleId: nativeIdentity.bundleId, device, present: true, removed: undefined }
    };
  }
  if (isMobileDeviceAppInstalled(after.stdout, nativeIdentity.bundleId)) {
    return {
      ok: false,
      message:
        `${nativeIdentity.bundleId} was present on ${device.name} (${device.udid}), ` +
        "but it is still reported as installed after the uninstall command.",
      data: { bundleId: nativeIdentity.bundleId, device, present: true, removed: false }
    };
  }

  return {
    ok: true,
    message:
      `${nativeIdentity.bundleId} was present and removed from ${device.name} (${device.udid}).`,
    data: { bundleId: nativeIdentity.bundleId, device, present: true, removed: true }
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

async function executeMobileDeviceUninstall(input: MobileUninstallInput): Promise<TaskResult> {
  const context = await resolveDefaultContext(process.env);
  return executeMobileDeviceUninstallWithContext(input, {
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

async function executeMobileQa(input: MobileQaInput): Promise<TaskResult> {
  if (!input.production) {
    return { ok: false, message: "mobile.qa requires --production." };
  }

  const context = await resolveDefaultContext(process.env);
  const qa = await executeProductionMobileQa({
    repoRoot: context.repoRoot,
    env: context.env,
    runner: nodeCommandRunner
  });
  const localOk = isProductionMobileQaOk(qa);
  const messages = [formatProductionMobileQaResult(qa)];
  const otaResults: TaskResult[] = [];

  if (localOk && input.ota) {
    const otaContext = {
      repoRoot: context.repoRoot,
      env: context.env,
      runner: nodeCommandRunner
    };
    const status = await executeMobileOtaStatusWithContext({ production: true, staging: false }, otaContext);
    otaResults.push(status);
    messages.push("", status.message);
    if (status.ok) {
      const doctor = await executeMobileOtaDoctorWithContext({ production: true, staging: false }, otaContext);
      otaResults.push(doctor);
      messages.push("", doctor.message);
    }
  } else if (localOk) {
    messages.push(
      "",
      "OTA production checks are not part of this run. For OTA-affecting releases, run `./kd mobile qa --production --ota` or `./kd mobile ota status --production` and `./kd mobile ota doctor --production`."
    );
  }

  return {
    ok: localOk && otaResults.every((result) => result.ok),
    message: messages.join("\n"),
    data: { qa, otaResults }
  };
}

export async function executeDevDownWithContext(
  input: DevDownInput,
  executor: ExecutorInput,
  options: DevDownExecutionOptions = {}
): Promise<TaskResult> {
  const stopped = await stopTmuxSession(executor.runner, executor.context.tmux);
  // Always stop the workspace kanna-server: the desktop app dies with the
  // tmux session, and an orphaned server would keep the port bound and serve
  // a stale binary across restarts. The daemon stays (unless asked) so PTY
  // sessions survive.
  const serverCleanup = await killWorkspaceServers({
    repoRoot: executor.context.repoRoot,
    runner: executor.runner,
    killProcess: options.killProcess
  });
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
    data: { stopped, serverCleanup, daemonCleanup }
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

function devDbTarget(context: { env: NodeJS.ProcessEnv }): DevDbTarget {
  return {
    dbName: context.env.KANNA_DB_NAME ?? "",
    dbPath: context.env.KANNA_DB_PATH ?? ""
  };
}

async function runBuiltCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<TaskResult> {
  const result = await nodeCommandRunner.run(command, args, { cwd, env });
  return {
    ok: result.exitCode === 0,
    message: result.exitCode === 0
      ? result.stdout || `${command} ${args.join(" ")} completed.`
      : result.stderr || result.stdout,
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
    description: "Restart the Kanna dev environment or one tmux component window.",
    inputSchema: devRestartInputSchema,
    execute: async (_context, input) => {
      const parsed = devRestartInputSchema.parse(input);
      if (!parsed.component) {
        await executeDevDown({ killDaemon: parsed.killDaemon });
        return executeDevUp(parsed);
      }
      const context = await resolveDefaultContext(process.env, {
        dbOverride: parsed.db,
        daemonDirOverride: parsed.daemonDir,
        transferRootOverride: parsed.transferRoot,
        firebaseEnvFrom: parsed.firebaseEnvFrom
      });
      return executeDevRestartWithContext(parsed, {
        runner: nodeCommandRunner,
        context: {
          repoRoot: context.repoRoot,
          tmux: context.tmux,
          ports: context.ports,
          env: context.env
        }
      });
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
    id: "mobile.uninstall",
    description: "Uninstall exactly one confirmed Kanna mobile bundle from a physical iOS device.",
    inputSchema: mobileUninstallInputSchema,
    execute: async (_context, input) =>
      executeMobileDeviceUninstall(mobileUninstallInputSchema.parse(input))
  },
  {
    id: "mobile.archive",
    description: "Build and optionally upload a production iOS archive for App Store Connect.",
    inputSchema: mobileArchiveInputSchema,
    execute: async (_context, input) => {
      const context = await resolveDefaultContext(process.env);
      return executeMobileIosArchiveWithContext(mobileArchiveInputSchema.parse(input), {
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner
      });
    }
  },
  {
    id: "mobile.doctor",
    description: "Check physical iOS device mobile development readiness.",
    inputSchema: mobileRunInputSchema,
    execute: async (_context, input) => executeMobileDeviceDoctor(mobileRunInputSchema.parse(input))
  },
  {
    id: "mobile.qa",
    description: "Run the repo-side production mobile QA gate.",
    inputSchema: mobileQaInputSchema,
    execute: async (_context, input) => executeMobileQa(mobileQaInputSchema.parse(input))
  },
  {
    id: "mobile.ota.publish",
    description: "Publish or roll back a Kanna mobile OTA update.",
    inputSchema: mobileOtaPublishInputSchema,
    execute: async (_context, input) => {
      const context = await resolveDefaultContext(process.env);
      return executeMobileOtaPublishWithContext(mobileOtaPublishInputSchema.parse(input), {
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner
      });
    }
  },
  {
    id: "mobile.ota.status",
    description: "Show the current Kanna mobile OTA channel pointer.",
    inputSchema: mobileOtaStatusInputSchema,
    execute: async (_context, input) => {
      const context = await resolveDefaultContext(process.env);
      return executeMobileOtaStatusWithContext(mobileOtaStatusInputSchema.parse(input), {
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner
      });
    }
  },
  {
    id: "mobile.ota.doctor",
    description: "Run read-only preflight checks for Kanna mobile OTA cloud and relay wiring.",
    inputSchema: mobileOtaDoctorInputSchema,
    execute: async (_context, input) => {
      const context = await resolveDefaultContext(process.env);
      return executeMobileOtaDoctorWithContext(mobileOtaDoctorInputSchema.parse(input), {
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner
      });
    }
  },
  {
    id: "mobile.ota.provision",
    description: "Provision Kanna mobile OTA bucket and relay storage access.",
    inputSchema: mobileOtaProvisionInputSchema,
    execute: async (_context, input) => {
      const context = await resolveDefaultContext(process.env);
      return executeMobileOtaProvisionWithContext(mobileOtaProvisionInputSchema.parse(input), {
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner
      });
    }
  },
  {
    id: "mobile.ota.provision-secret",
    description: "Provision the Kanna mobile OTA private key into cloud Secret Manager.",
    inputSchema: mobileOtaProvisionSecretInputSchema,
    execute: async (_context, input) => {
      const context = await resolveDefaultContext(process.env);
      return executeMobileOtaProvisionSecretWithContext(mobileOtaProvisionSecretInputSchema.parse(input), {
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner
      });
    }
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
      const cargoConfig = writeCargoConfig(context.repoRoot);
      const machineLocalConfig = syncMachineLocalConfig(context.repoRoot);
      const lines = ["Synced Kanna dev environment files."];
      if (machineLocalConfig.status === "copied") {
        lines.push(`  machine-local repo config from ${machineLocalConfig.source}`);
      } else if (machineLocalConfig.status === "kept-local") {
        lines.push(`  kept this worktree's ${machineLocalConfig.destination} (none in the primary checkout)`);
      }
      return {
        ok: true,
        message: lines.join("\n"),
        data: { cargoConfig, machineLocalConfig }
      };
    }
  },
  {
    id: "rust-cache.install",
    description: "Install the pinned kache compiler cache and create this repository's store.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const result = await installRustCache({
        repoRoot: context.repoRoot,
        homeDir: context.homeDir,
        env: context.env,
        runner: nodeCommandRunner
      });
      return {
        ok: true,
        message: result.eligible
          ? `Installed kache ${result.version} at ${result.binary}.`
          : `Rust build cache disabled (${result.category}); nothing installed.`,
        data: result
      };
    }
  },
  {
    id: "rust-cache.status",
    description: "Show the pinned kache installation, this repository's store, and cache stats.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const status = await getRustCacheStatus({
        repoRoot: context.repoRoot,
        homeDir: context.homeDir,
        env: context.env,
        runner: nodeCommandRunner
      });
      return { ok: true, message: formatJsonResult(status), data: status };
    }
  },
  {
    id: "build.sidecars",
    description: "Build Kanna desktop sidecars.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      const staged = await buildDesktopSidecars(nodeCommandRunner, context.repoRoot, context.env);
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
    description: "Build, sign, notarize, and optionally publish a Kanna release, flooring main staging above the greatest production semantic version.",
    inputSchema: releaseShipInputSchema,
    execute: async (_context, input) => {
      const parsed = releaseShipInputSchema.parse(input);
      if (parsed.staging && parsed.production) {
        return { ok: false, message: "release ship accepts only one of --staging or --production." };
      }
      if (parsed.rollbackTo && !parsed.staging) {
        return { ok: false, message: "release ship --rollback-to requires --staging." };
      }
      if (parsed.branch && !parsed.staging) {
        return { ok: false, message: "release ship --branch requires --staging (it records the RC's source branch)." };
      }
      const bump = parsed.major ? "major" : parsed.minor ? "minor" : "patch";
      const archLabels = [
        ...(parsed.arm64 ? ["arm64" as const] : []),
        ...(parsed.x86_64 ? ["x86_64" as const] : [])
      ];
      const environment = parsed.staging ? "staging" : "production";
      const context = await resolveDefaultContext(process.env);
      const releaseEnv = await loadReleaseTaskEnvironment(context);
      if (!parsed.dryRun && !parsed.rollbackTo) {
        await preflightNotarizationCredentials({
          cwd: context.repoRoot,
          env: releaseEnv,
          runner: nodeCommandRunner
        });
      }
      const result = await shipRelease({
        repoRoot: context.repoRoot,
        bump,
        archLabels: archLabels.length > 0 ? archLabels : ["arm64", "x86_64"],
        environment,
        release: parsed.release,
        dryRun: parsed.dryRun,
        rollbackTo: parsed.rollbackTo,
        sourceBranch: parsed.branch,
        env: releaseEnv,
        runner: nodeCommandRunner
      });
      return { ok: true, message: formatJsonResult(result), data: result };
    }
  },
  {
    id: "release.promote",
    description: "Promote a soaked staging prerelease into the production release of the exact same commit.",
    inputSchema: releasePromoteInputSchema,
    execute: async (_context, input) => {
      const parsed = releasePromoteInputSchema.parse(input);
      const archLabels = [
        ...(parsed.arm64 ? ["arm64" as const] : []),
        ...(parsed.x86_64 ? ["x86_64" as const] : [])
      ];
      const context = await resolveDefaultContext(process.env);
      const releaseEnv = await loadReleaseTaskEnvironment(context);
      if (!parsed.dryRun) {
        await preflightNotarizationCredentials({
          cwd: context.repoRoot,
          env: releaseEnv,
          runner: nodeCommandRunner
        });
      }
      const result = await shipRelease({
        repoRoot: context.repoRoot,
        bump: "patch",
        archLabels: archLabels.length > 0 ? archLabels : ["arm64", "x86_64"],
        environment: "production",
        release: !parsed.dryRun,
        dryRun: parsed.dryRun,
        promoteFrom: parsed.version,
        soakOverrideReason: parsed.overrideSoak,
        env: releaseEnv,
        runner: nodeCommandRunner
      });
      return { ok: true, message: formatJsonResult(result), data: result };
    }
  },
  {
    id: "release.reset-staging",
    description:
      "Abandon the active staging lineage for an exceptional non-linear publish. Records old/new provenance and never runs implicitly; routine post-promotion return to main is verified automatically.",
    inputSchema: releaseResetStagingInputSchema,
    execute: async (_context, input) => {
      const parsed = releaseResetStagingInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      const result = await resetStagingLineage({
        repoRoot: context.repoRoot,
        toBranch: parsed.to,
        reason: parsed.reason,
        confirmAbandon: parsed.confirmAbandon,
        dryRun: parsed.dryRun,
        env: context.env,
        runner: nodeCommandRunner
      });
      return { ok: true, message: formatJsonResult(result), data: result };
    }
  },
  {
    id: "release.setup-notarization",
    description: "Store and validate a notarization profile in an explicit file-based Keychain.",
    inputSchema: releaseSetupNotarizationInputSchema,
    execute: async (_context, input) => {
      const parsed = releaseSetupNotarizationInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      const result = await setupNotarizationCredentials({
        cwd: context.repoRoot,
        homeDir: context.homeDir,
        env: context.env,
        runner: nodeCommandRunner,
        profile: parsed.profile,
        keychainPath: parsed.keychain
      });
      return {
        ok: true,
        message: `Stored notarization profile ${result.profile} in ${result.keychainPath}; selectors written to ${result.configPath} with mode 0600.`,
        data: result
      };
    }
  },
  {
    id: "release.cut",
    description:
      "Cut a release/X.Y stabilization branch from origin/main, optionally naming an explicit target series and recording the unreleased series it abandons.",
    inputSchema: releaseCutInputSchema,
    execute: async (_context, input) => {
      const parsed = releaseCutInputSchema.parse(input);
      if (parsed.version && (parsed.major || parsed.minor || parsed.patch)) {
        return { ok: false, message: "release cut accepts --version or a bump flag, not both." };
      }
      const bump = parsed.major ? "major" : parsed.patch ? "patch" : "minor";
      const abandonSeries = (parsed.abandonSeries ?? "")
        .split(",")
        .map((series) => series.trim())
        .filter(Boolean);
      if (parsed.reason && abandonSeries.length === 0) {
        return { ok: false, message: "release cut --reason only applies with --abandon-series." };
      }
      const context = await resolveDefaultContext(process.env);
      const result = await cutReleaseBranch({
        repoRoot: context.repoRoot,
        bump,
        version: parsed.version,
        abandonSeries,
        reason: parsed.reason,
        env: context.env,
        runner: nodeCommandRunner
      });
      return { ok: true, message: formatJsonResult(result), data: result };
    }
  },
  {
    id: "release.status",
    description:
      "Show the production release and staging pointer, including reset- or promotion-authorized lineage, soak age, release freeze, and promotion blockers.",
    inputSchema: releaseStatusInputSchema,
    execute: async (_context, input) => {
      releaseStatusInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      const result = await releaseStatus({
        repoRoot: context.repoRoot,
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
    id: "test.all",
    description: "Run all canonical local verification lanes.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      return executeTestAll({
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner,
      });
    },
  },
  {
    id: "test.rust",
    description: "Run workspace Rust tests with daemon integration tests serialized.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      return executeRustTests({
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner
      });
    },
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
    id: "test.remote-e2e",
    description: "Run remote task interaction E2E tests.",
    inputSchema: remoteE2eInputSchema,
    execute: async (_context, input) => {
      const parsed = remoteE2eInputSchema.parse(input);
      if (parsed.dev && parsed.staging) {
        return { ok: false, message: "remote-e2e accepts only one of --dev or --staging." };
      }
      if (parsed.staging && (parsed.mobileRelay || parsed.desktopPairing)) {
        return {
          ok: false,
          message: "remote-e2e staging is only supported for the headless Layer B lane."
        };
      }
      const context = await resolveDefaultContext(process.env);
      return executeRemoteE2e({
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner,
        options: {
          staging: parsed.staging,
          mobileRelay: parsed.mobileRelay,
          desktopPairing: parsed.desktopPairing,
          ifChanged: parsed.ifChanged
        }
      });
    }
  },
  {
    id: "test.staging-smoke",
    description: "Run the staging health smoke: remote doctor, then the staging remote E2E lane.",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      return executeStagingSmoke({
        repoRoot: context.repoRoot,
        env: context.env,
        runner: nodeCommandRunner,
      });
    },
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
    id: "doctor.remote",
    description: "Check remote task E2E prerequisites.",
    inputSchema: remoteDoctorInputSchema,
    execute: async (_context, input) => {
      const parsed = remoteDoctorInputSchema.parse(input);
      const context = await resolveDefaultContext(process.env);
      return runBuiltCommand(
        "pnpm",
        ["--dir", "tests/remote-e2e", "exec", "tsx", "src/doctor.ts", ...(parsed.staging ? ["--staging"] : [])],
        context.repoRoot,
        context.env
      );
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
