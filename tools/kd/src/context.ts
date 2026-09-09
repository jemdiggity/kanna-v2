import { basename, isAbsolute, join } from "node:path";
import { resolvePorts, type KdPorts } from "./ports";

export interface KdTmuxContext {
  server: string;
  session: string;
  inventoryPath?: string;
}

export interface KdContext {
  repoRoot: string;
  homeDir: string;
  isWorktree: boolean;
  worktreeName?: string;
  branch: string;
  commit: string;
  bundleIdentifier: string;
  ports: KdPorts;
  env: NodeJS.ProcessEnv;
  tmux: KdTmuxContext;
}

export interface ResolveKdContextInput {
  repoRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  branch: string;
  commit: string;
  bundleIdentifier: string;
  configPorts: Record<string, number>;
  dbOverride?: string;
  daemonDirOverride?: string;
  transferRootOverride?: string;
  /** Defaults to the host platform; injectable so both branches are testable. */
  platform?: NodeJS.Platform;
}

/**
 * The per-user directory Kanna's application data lives under.
 *
 * This mirrors `app_support_dir_for_home` in `crates/runtime-defaults`, and it
 * has to: `kd` tells the server, daemon and sidecars where their database,
 * daemon directory and transfer root are, so a disagreement is a split brain
 * rather than a cosmetic difference.
 */
function appDataDir(homeDir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "darwin") return join(homeDir, "Library", "Application Support");
  return xdgDir(env.XDG_DATA_HOME, homeDir, join(".local", "share"));
}

/** As {@link appDataDir}, for caches. */
export function appCacheDir(homeDir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "darwin") return join(homeDir, "Library", "Caches");
  return xdgDir(env.XDG_CACHE_HOME, homeDir, ".cache");
}

/** An XDG base directory: the environment value only when it is absolute. */
function xdgDir(value: string | undefined, homeDir: string, fallback: string): string {
  const configured = value?.trim();
  return configured && isAbsolute(configured) ? configured : join(homeDir, fallback);
}

function canonicalTmuxName(name: string): string {
  return name.replaceAll(".", "_");
}

function isWorktreePath(repoRoot: string, env: NodeJS.ProcessEnv): boolean {
  return env.KANNA_WORKTREE === "1" || repoRoot.includes("/.kanna-worktrees/");
}

function deriveTaskIdFromWorktreeName(worktreeName: string | undefined): string | undefined {
  if (!worktreeName) return undefined;
  const match = /^task-(.+?)(?:-\d+)?$/.exec(worktreeName);
  return match?.[1];
}

function applicationSupportPath(
  appDataRoot: string,
  bundleIdentifier: string,
  dbName: string,
): string {
  return join(appDataRoot, bundleIdentifier, dbName);
}

export function resolveKdContext(input: ResolveKdContextInput): KdContext {
  const isWorktree = isWorktreePath(input.repoRoot, input.env);
  const platform = input.platform ?? process.platform;
  const appDataRoot = appDataDir(input.homeDir, input.env, platform);
  const worktreeName = isWorktree ? basename(input.repoRoot) : undefined;
  const ports = resolvePorts({ env: input.env, configPorts: input.configPorts });
  // Every kd-launched instance is development or verification. This veto
  // travels to SQLite openers, including launchers that forget the DB override.
  const env: NodeJS.ProcessEnv = { ...input.env, KANNA_DB_ISOLATED: "1" };

  if (isWorktree) {
    env.KANNA_WORKTREE = "1";
    env.KANNA_BUILD_WORKTREE = worktreeName;
    env.KANNA_BUILD_TASK_ID =
      env.KANNA_TASK_ID?.trim() || deriveTaskIdFromWorktreeName(worktreeName) || "";
    const legacySharedRustBuildDir = join(
      appCacheDir(input.homeDir, input.env, platform),
      "kanna",
      "rust-build",
    );
    const inheritedRustBuildDir = env.CARGO_BUILD_BUILD_DIR?.trim();
    env.CARGO_BUILD_BUILD_DIR =
      inheritedRustBuildDir && inheritedRustBuildDir !== legacySharedRustBuildDir
        ? inheritedRustBuildDir
        : join(input.repoRoot, ".build", "cargo-build");
  }

  env.KANNA_BUILD_BRANCH = input.branch;
  env.KANNA_BUILD_COMMIT = input.commit;

  const explicitDb = input.dbOverride?.trim();
  const dbName = explicitDb
    ? basename(explicitDb)
    : isWorktree
      ? `kanna-wt-${worktreeName}.db`
      : env.KANNA_DB_NAME?.trim() || "kanna-v2.db";
  env.KANNA_DB_NAME = dbName;
  env.KANNA_DB_PATH =
    explicitDb && isAbsolute(explicitDb)
      ? explicitDb
      : isWorktree || explicitDb || !env.KANNA_DB_PATH?.trim()
      ? applicationSupportPath(appDataRoot, input.bundleIdentifier, dbName)
      : env.KANNA_DB_PATH;
  env.KANNA_DAEMON_DIR =
    input.daemonDirOverride?.trim() ||
    (isWorktree
      ? join(input.repoRoot, ".kanna-daemon")
      : env.KANNA_DAEMON_DIR?.trim() || join(appDataRoot, "Kanna"));
  env.KANNA_TRANSFER_ROOT =
    input.transferRootOverride?.trim() ||
    (isWorktree
      ? join(input.repoRoot, ".kanna-transfer")
      : env.KANNA_TRANSFER_ROOT?.trim() ||
        join(appDataRoot, input.bundleIdentifier, "transfer"));

  for (const [key, value] of Object.entries(ports)) {
    env[key] = String(value);
  }

  const sessionBase = env.KANNA_TMUX_SESSION?.trim()
    ? env.KANNA_TMUX_SESSION
    : isWorktree
      ? `kanna-${worktreeName}`
      : "kanna";
  const session = canonicalTmuxName(sessionBase);

  return {
    repoRoot: input.repoRoot,
    homeDir: input.homeDir,
    isWorktree,
    worktreeName,
    branch: input.branch,
    commit: input.commit,
    bundleIdentifier: input.bundleIdentifier,
    ports,
    env,
    tmux: { server: session, session, inventoryPath: join(input.repoRoot, ".kanna", "kd-state", "process-inventory.json") }
  };
}
