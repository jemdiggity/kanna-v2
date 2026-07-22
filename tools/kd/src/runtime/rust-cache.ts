import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandRunner } from "./process";
import {
  KANACHE_PROFILE,
  KANACHE_REPOSITORY,
  KANACHE_REVISION,
  KANACHE_RUST_INPUT_EXCLUSIONS,
  parseKanacheManifest,
  parseWorktreeList,
  rankDonors,
  resolveRustCacheEligibility,
  resolveKanachePaths
} from "./rust-cache-policy";
import type { DonorCandidate, RustCacheMatchingMode } from "./rust-cache-policy";

export interface RustCacheEvent {
  timestamp: string;
  repository: string;
  commit: string;
  destination: string;
  donor?: string;
  matchingMode?: RustCacheMatchingMode;
  layouts: string[];
  outcome: "hit" | "miss" | "recorded" | "record-miss";
  category: string;
  wallMs: number;
  allocationDeltaBytes: number;
}

export interface RustCacheRuntimeInput {
  repoRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  commit: string;
  platform?: NodeJS.Platform;
}

export interface RustCacheOperationResult {
  ok: true;
  outcome: "hit" | "miss" | "recorded" | "record-miss";
  category: string;
  donor?: string;
  matchingMode?: RustCacheMatchingMode;
  message: string;
}

export type RustCacheLayouts = "sidecars" | "all";

const RUST_CACHE_LIFECYCLE_TOKEN = "KANNA_RUST_CACHE_LIFECYCLE_TOKEN";

interface RustCacheLifecycleOwner {
  token: string;
  pid: number;
  createdAt: string;
}

function rustCacheEligibility(input: RustCacheRuntimeInput) {
  return resolveRustCacheEligibility({
    mode: input.env.KANNA_RUST_CACHE,
    platform: input.platform ?? process.platform,
    ci: input.env.CI
  });
}

export async function ensureKanacheBinary(input: {
  homeDir: string;
  runner: CommandRunner;
}): Promise<string> {
  const paths = resolveKanachePaths(input.homeDir);
  if (existsSync(paths.binary)) return paths.binary;

  const parent = dirname(paths.versionRoot);
  mkdirSync(parent, { recursive: true });
  const tempRoot = mkdtempSync(join(parent, `.install-${KANACHE_REVISION}-`));

  try {
    const installed = await input.runner.run("cargo", [
      "install",
      "--git",
      KANACHE_REPOSITORY,
      "--rev",
      KANACHE_REVISION,
      "--locked",
      "--root",
      tempRoot
    ]);
    if (installed.exitCode !== 0) {
      throw new Error(installed.stderr.trim() || "cargo install failed");
    }

    const tempBinary = join(tempRoot, "bin", "kanache");
    if (!existsSync(tempBinary)) {
      throw new Error(`cargo install did not create ${tempBinary}`);
    }
    chmodSync(tempBinary, 0o755);
    const verified = await input.runner.run(tempBinary, ["--version"]);
    if (verified.exitCode !== 0 || !verified.stdout.startsWith("kanache 0.1.0")) {
      throw new Error("installed Kanache version check failed");
    }

    try {
      renameSync(tempRoot, paths.versionRoot);
    } catch (error) {
      if (!existsSync(paths.binary)) {
        throw new Error(`failed to publish Kanache at ${paths.versionRoot}`, { cause: error });
      }
    }
    return paths.binary;
  } finally {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

export function appendRustCacheEvent(homeDir: string, event: RustCacheEvent): void {
  const path = resolveKanachePaths(homeDir).events;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch (error) {
    throw new Error(`failed to append Kanache event log at ${path}`, { cause: error });
  }
}

export function readRustCacheEvents(
  homeDir: string,
  repository: string,
  limit: number,
  onWarning: (warning: string) => void = () => {}
): RustCacheEvent[] {
  const path = resolveKanachePaths(homeDir).events;
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`failed to read Kanache event log at ${path}`, { cause: error });
  }

  return raw
    .split("\n")
    .flatMap((line, index) => {
      if (!line) return [];
      try {
        const event = JSON.parse(line) as RustCacheEvent;
        return event.repository === repository ? [event] : [];
      } catch {
        onWarning(`Ignored malformed Kanache event log line ${index + 1}.`);
        return [];
      }
    })
    .slice(-limit);
}

function repositoryId(commonDirectory: string): string {
  return createHash("sha256").update(commonDirectory).digest("hex").slice(0, 16);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function repositoryDirectoryFromFilesystem(repoRoot: string): string {
  const dotGit = join(repoRoot, ".git");
  try {
    if (lstatSync(dotGit).isDirectory()) return canonicalPath(dotGit);
    const gitDirectoryLine = readFileSync(dotGit, "utf8").trim();
    if (!gitDirectoryLine.startsWith("gitdir: ")) return canonicalPath(repoRoot);
    const gitDirectoryValue = gitDirectoryLine.slice("gitdir: ".length);
    const gitDirectory = resolve(repoRoot, gitDirectoryValue);
    const commonDirectoryFile = join(gitDirectory, "commondir");
    if (!existsSync(commonDirectoryFile)) return canonicalPath(gitDirectory);
    return canonicalPath(resolve(gitDirectory, readFileSync(commonDirectoryFile, "utf8").trim()));
  } catch {
    return resolve(repoRoot);
  }
}

function availableBytes(path: string): bigint {
  const stats = statfsSync(path, { bigint: true });
  return stats.bavail * stats.bsize;
}

function parseHostTarget(output: string): string | undefined {
  return output
    .split("\n")
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length)
    .trim();
}

async function gitCommonDirectory(
  runner: CommandRunner,
  path: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const result = await runner.run("git", ["-C", path, "rev-parse", "--git-common-dir"], {
    cwd: path,
    env
  });
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  if (!value) return undefined;
  return canonicalPath(resolve(path, value));
}

function safeAppendEvent(homeDir: string, event: RustCacheEvent): void {
  try {
    appendRustCacheEvent(homeDir, event);
  } catch (error) {
    console.warn(`[kd] ${error instanceof Error ? error.message : String(error)}`);
  }
}

function miss(category: string, detail?: string): RustCacheOperationResult {
  return {
    ok: true,
    outcome: "miss",
    category,
    message: detail ? `Kanache cache miss (${category}): ${detail}` : `Kanache cache miss (${category}).`
  };
}

function warmMiss(
  input: RustCacheRuntimeInput,
  category: string,
  detail?: string,
  commit = input.commit
): RustCacheOperationResult {
  const result = miss(category, detail);
  safeAppendEvent(input.homeDir, {
    timestamp: new Date().toISOString(),
    repository: repositoryId(repositoryDirectoryFromFilesystem(input.repoRoot)),
    commit,
    destination: input.repoRoot,
    layouts: [],
    outcome: "miss",
    category,
    wallMs: 0,
    allocationDeltaBytes: 0
  });
  return result;
}

function recordMiss(category: string, detail?: string): RustCacheOperationResult {
  return {
    ok: true,
    outcome: "record-miss",
    category,
    message: detail
      ? `Kanache donor not recorded (${category}): ${detail}`
      : `Kanache donor not recorded (${category}).`
  };
}

function recordFailure(
  input: RustCacheRuntimeInput,
  category: string,
  detail?: string,
  layouts: string[] = []
): RustCacheOperationResult {
  const result = recordMiss(category, detail);
  safeAppendEvent(input.homeDir, {
    timestamp: new Date().toISOString(),
    repository: repositoryId(repositoryDirectoryFromFilesystem(input.repoRoot)),
    commit: input.commit,
    destination: input.repoRoot,
    layouts,
    outcome: "record-miss",
    category,
    wallMs: 0,
    allocationDeltaBytes: 0
  });
  return result;
}

function validDonorFiles(path: string): boolean {
  const buildRoot = join(path, ".build", "cargo-build");
  const manifest = join(buildRoot, ".kanache-manifest.json");
  const success = join(buildRoot, ".kanache-success");
  try {
    return (
      !lstatSync(path).isSymbolicLink() &&
      !lstatSync(buildRoot).isSymbolicLink() &&
      lstatSync(manifest).isFile() &&
      !lstatSync(manifest).isSymbolicLink() &&
      lstatSync(success).isFile() &&
      !lstatSync(success).isSymbolicLink()
    );
  } catch {
    return false;
  }
}

function clearRustCacheSuccessMarker(repoRoot: string): void {
  const marker = join(repoRoot, ".build", "cargo-build", ".kanache-success");
  try {
    unlinkSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`failed to revoke Kanache donor eligibility at ${marker}`, { cause: error });
  }

  let directory: number | undefined;
  try {
    directory = openSync(dirname(marker), "r");
    fsyncSync(directory);
  } catch (error) {
    throw new Error(`failed to persist Kanache donor revocation at ${marker}`, { cause: error });
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}

function readLifecycleOwner(lockDirectory: string): RustCacheLifecycleOwner | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(lockDirectory, "owner.json"), "utf8")
    ) as Partial<RustCacheLifecycleOwner>;
    if (
      typeof value.token !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.createdAt !== "string"
    ) {
      return undefined;
    }
    return value as RustCacheLifecycleOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeLifecycleLock(lockDirectory: string, expectedToken?: string): boolean {
  const owner = readLifecycleOwner(lockDirectory);
  if (expectedToken && owner?.token !== expectedToken) return false;
  try {
    unlinkSync(join(lockDirectory, "owner.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    rmdirSync(lockDirectory);
    return true;
  } catch {
    return false;
  }
}

export async function withRustCacheLifecycleLock<T>(
  input: RustCacheRuntimeInput,
  operation: (ownerEnv: NodeJS.ProcessEnv) => Promise<T>,
  options: { pollMs?: number; timeoutMs?: number } = {}
): Promise<T> {
  const lockDirectory = join(input.repoRoot, ".build", ".kanache-lifecycle-lock");
  const inheritedToken = input.env[RUST_CACHE_LIFECYCLE_TOKEN]?.trim();
  const inheritedOwner = readLifecycleOwner(lockDirectory);
  if (inheritedToken && inheritedOwner?.token === inheritedToken) {
    return operation(input.env);
  }

  mkdirSync(dirname(lockDirectory), { recursive: true });
  const token = randomUUID();
  const pollMs = options.pollMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      mkdirSync(lockDirectory);
      const owner: RustCacheLifecycleOwner = {
        token,
        pid: process.pid,
        createdAt: new Date().toISOString()
      };
      try {
        writeFileSync(join(lockDirectory, "owner.json"), `${JSON.stringify(owner)}\n`, {
          flag: "wx",
          mode: 0o600
        });
      } catch (error) {
        // Only remove the directory when it is still empty. An ownerless lock is
        // otherwise intentionally left in place: another process cannot prove
        // that the creator will not resume and publish through this pathname.
        try {
          rmdirSync(lockDirectory);
        } catch {
          // Fail closed and leave any unverifiable state for manual cleanup.
        }
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`failed to acquire Kanache lifecycle lock at ${lockDirectory}`, {
          cause: error
        });
      }

      let lockStats;
      try {
        lockStats = lstatSync(lockDirectory);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lockError;
      }
      if (lockStats.isSymbolicLink() || !lockStats.isDirectory()) {
        throw new Error(`unsafe Kanache lifecycle lock at ${lockDirectory}`);
      }
      const owner = readLifecycleOwner(lockDirectory);
      if (owner && !processIsAlive(owner.pid)) {
        removeLifecycleLock(lockDirectory, owner.token);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Kanache lifecycle lock at ${lockDirectory}`);
      }
      await delay(pollMs);
    }
  }

  const ownerEnv = { ...input.env, [RUST_CACHE_LIFECYCLE_TOKEN]: token };
  try {
    return await operation(ownerEnv);
  } finally {
    if (!removeLifecycleLock(lockDirectory, token)) {
      console.warn(`[kd] Kanache lifecycle lock ownership changed at ${lockDirectory}.`);
    }
  }
}

export async function warmRustCache(
  input: RustCacheRuntimeInput
): Promise<RustCacheOperationResult> {
  const eligibility = rustCacheEligibility(input);
  if (!eligibility.enabled) {
    if (eligibility.warning) console.warn(`[kd] ${eligibility.warning}`);
    return warmMiss(input, eligibility.category, eligibility.warning);
  }

  const destination = join(input.repoRoot, ".build", "cargo-build");
  if (existsSync(destination)) return warmMiss(input, "destination-exists");

  try {
    const worktrees = await input.runner.run("git", ["worktree", "list", "--porcelain"], {
      cwd: input.repoRoot,
      env: input.env
    });
    if (worktrees.exitCode !== 0) {
      return warmMiss(input, "git-worktree-list", worktrees.stderr.trim());
    }
    const head = await input.runner.run("git", ["rev-parse", "HEAD"], {
      cwd: input.repoRoot,
      env: input.env
    });
    const fullCommit = head.exitCode === 0 ? head.stdout.trim() : "";
    if (!/^[0-9a-f]{40}$/i.test(fullCommit)) {
      return warmMiss(input, "git-head", head.stderr.trim());
    }
    const rustc = await input.runner.run("rustc", ["-vV"], {
      cwd: input.repoRoot,
      env: input.env
    });
    const hostTarget = rustc.exitCode === 0 ? parseHostTarget(rustc.stdout) : undefined;
    if (!hostTarget) return warmMiss(input, "rustc-host", rustc.stderr.trim(), fullCommit);

    const currentCommon = await gitCommonDirectory(input.runner, input.repoRoot, input.env);
    if (!currentCommon) return warmMiss(input, "git-common-dir", undefined, fullCommit);
    const candidates: DonorCandidate[] = [];

    for (const worktree of parseWorktreeList(worktrees.stdout)) {
      if (
        canonicalPath(worktree.path) === canonicalPath(input.repoRoot) ||
        !validDonorFiles(worktree.path)
      ) {
        continue;
      }
      const common = await gitCommonDirectory(input.runner, worktree.path, input.env);
      if (common !== currentCommon) continue;
      try {
        const manifest = parseKanacheManifest(
          readFileSync(join(worktree.path, ".build", "cargo-build", ".kanache-manifest.json"), "utf8")
        );
        const matchingMode =
          worktree.head === fullCommit
            ? "head"
            : manifest.rustBuildInputsBlake3
              ? "input-hash"
              : undefined;
        if (matchingMode) {
          candidates.push({
            ...worktree,
            path: canonicalPath(worktree.path),
            manifest,
            matchingMode
          });
        }
      } catch {
        // A malformed or incompatible donor is simply not eligible.
      }
    }

    const donors = rankDonors(candidates, hostTarget);
    if (donors.length === 0) return warmMiss(input, "no-donor", undefined, fullCommit);

    const binary = await ensureKanacheBinary({ homeDir: input.homeDir, runner: input.runner });
    const repository = repositoryId(currentCommon);
    for (const donor of donors) {
      const args = ["warm", donor.path, input.repoRoot, "--profile", KANACHE_PROFILE];
      for (const target of donor.manifest.targets) args.push("--target", target);
      for (const exclusion of KANACHE_RUST_INPUT_EXCLUSIONS) {
        args.push("--exclude-rust-input-root", exclusion);
      }
      args.push("--strategy", "root");

      const freeBefore = availableBytes(input.repoRoot);
      const started = performance.now();
      const warmed = await input.runner.run(binary, args, {
        cwd: input.repoRoot,
        env: input.env
      });
      const wallMs = Math.round(performance.now() - started);
      const allocationDelta = freeBefore - availableBytes(input.repoRoot);
      const allocationDeltaBytes = Number(
        allocationDelta > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : allocationDelta < BigInt(Number.MIN_SAFE_INTEGER)
            ? BigInt(Number.MIN_SAFE_INTEGER)
            : allocationDelta
      );
      safeAppendEvent(input.homeDir, {
        timestamp: new Date().toISOString(),
        repository,
        commit: fullCommit,
        destination: input.repoRoot,
        donor: donor.path,
        matchingMode: donor.matchingMode,
        layouts: donor.manifest.targets,
        outcome: warmed.exitCode === 0 ? "hit" : "miss",
        category: warmed.exitCode === 0 ? "warmed" : "donor-refused",
        wallMs,
        allocationDeltaBytes
      });
      if (warmed.exitCode === 0) {
        return {
          ok: true,
          outcome: "hit",
          category: "warmed",
          donor: donor.path,
          matchingMode: donor.matchingMode,
          message: `Warmed private Cargo artifacts from ${donor.path} (${donor.matchingMode}).`
        };
      }
    }
    return warmMiss(input, "all-donors-refused", undefined, fullCommit);
  } catch (error) {
    return warmMiss(
      input,
      "internal-error",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function beginRustCacheBuild(
  input: RustCacheRuntimeInput
): Promise<RustCacheOperationResult> {
  clearRustCacheSuccessMarker(input.repoRoot);
  const eligibility = rustCacheEligibility(input);
  if (!eligibility.enabled) {
    if (eligibility.warning) console.warn(`[kd] ${eligibility.warning}`);
    return recordFailure(input, eligibility.category, eligibility.warning);
  }

  try {
    const binary = await ensureKanacheBinary({ homeDir: input.homeDir, runner: input.runner });
    const result = await input.runner.run(binary, ["manifest", "begin", input.repoRoot], {
      cwd: input.repoRoot,
      env: input.env
    });
    if (result.exitCode !== 0) {
      return recordMiss("manifest-begin", result.stderr.trim());
    }
    return {
      ok: true,
      outcome: "recorded",
      category: "manifest-begin",
      message: "Cleared prior Kanache donor eligibility."
    };
  } catch (error) {
    return recordMiss("manifest-begin", error instanceof Error ? error.message : String(error));
  }
}

export async function recordRustCache(
  input: RustCacheRuntimeInput,
  layouts: RustCacheLayouts
): Promise<RustCacheOperationResult> {
  const eligibility = rustCacheEligibility(input);
  if (!eligibility.enabled) {
    if (eligibility.warning) console.warn(`[kd] ${eligibility.warning}`);
    return recordFailure(input, eligibility.category, eligibility.warning);
  }

  try {
    const clean = await input.runner.run(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: input.repoRoot, env: input.env }
    );
    if (clean.exitCode !== 0) return recordFailure(input, "git-status", clean.stderr.trim());
    if (clean.stdout.trim()) return recordFailure(input, "dirty-worktree");

    const rustc = await input.runner.run("rustc", ["-vV"], {
      cwd: input.repoRoot,
      env: input.env
    });
    const hostTarget = rustc.exitCode === 0 ? parseHostTarget(rustc.stdout) : undefined;
    if (!hostTarget) return recordFailure(input, "rustc-host", rustc.stderr.trim());

    const binary = await ensureKanacheBinary({ homeDir: input.homeDir, runner: input.runner });
    const targets = layouts === "sidecars" ? [hostTarget] : [hostTarget, "host"].sort();
    const args = ["manifest", "record", input.repoRoot, "--profile", KANACHE_PROFILE];
    for (const target of targets) args.push("--target", target);
    for (const exclusion of KANACHE_RUST_INPUT_EXCLUSIONS) {
      args.push("--exclude-rust-input-root", exclusion);
    }
    const started = performance.now();
    const result = await input.runner.run(binary, args, {
      cwd: input.repoRoot,
      env: input.env
    });
    const wallMs = Math.round(performance.now() - started);
    const recorded = result.exitCode === 0;
    safeAppendEvent(input.homeDir, {
      timestamp: new Date().toISOString(),
      repository: repositoryId(repositoryDirectoryFromFilesystem(input.repoRoot)),
      commit: input.commit,
      destination: input.repoRoot,
      layouts: targets,
      outcome: recorded ? "recorded" : "record-miss",
      category: recorded ? "manifest-recorded" : "manifest-record",
      wallMs,
      allocationDeltaBytes: 0
    });
    if (!recorded) return recordMiss("manifest-record", result.stderr.trim());
    return {
      ok: true,
      outcome: "recorded",
      category: "manifest-recorded",
      message: `Recorded Kanache donor layouts: ${targets.join(", ")}.`
    };
  } catch (error) {
    return recordFailure(
      input,
      "manifest-record",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function noteRustCacheRecordMiss(
  input: RustCacheRuntimeInput,
  category: string
): RustCacheOperationResult {
  const result = recordMiss(category);
  safeAppendEvent(input.homeDir, {
    timestamp: new Date().toISOString(),
    repository: repositoryId(repositoryDirectoryFromFilesystem(input.repoRoot)),
    commit: input.commit,
    destination: input.repoRoot,
    layouts: [],
    outcome: "record-miss",
    category,
    wallMs: 0,
    allocationDeltaBytes: 0
  });
  return result;
}

export async function withRustCacheBuild<T>(
  input: RustCacheRuntimeInput,
  layouts: RustCacheLayouts,
  operation: () => Promise<T>,
  succeeded: (value: T) => boolean
): Promise<T> {
  await beginRustCacheBuild(input);
  const value = await operation();
  if (succeeded(value)) await recordRustCache(input, layouts);
  return value;
}

export async function getRustCacheStatus(input: RustCacheRuntimeInput): Promise<{
  enabled: boolean;
  category?: string;
  warning?: string;
  revision: string;
  binary: string;
  installed: boolean;
  manifest?: ReturnType<typeof parseKanacheManifest>;
  events: RustCacheEvent[];
}> {
  const eligibility = rustCacheEligibility(input);
  const paths = resolveKanachePaths(input.homeDir);
  const manifestPath = join(input.repoRoot, ".build", "cargo-build", ".kanache-manifest.json");
  let manifest: ReturnType<typeof parseKanacheManifest> | undefined;
  if (existsSync(manifestPath)) {
    try {
      manifest = parseKanacheManifest(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      console.warn(
        `[kd] Ignored invalid current Kanache manifest: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  let commonDirectory = repositoryDirectoryFromFilesystem(input.repoRoot);
  if (eligibility.enabled) {
    try {
      commonDirectory =
        (await gitCommonDirectory(input.runner, input.repoRoot, input.env)) ?? commonDirectory;
    } catch {
      // The filesystem-derived identity keeps status usable if Git is unavailable.
    }
  }
  let events: RustCacheEvent[] = [];
  try {
    events = readRustCacheEvents(input.homeDir, repositoryId(commonDirectory), 10, (warning) =>
      console.warn(`[kd] ${warning}`)
    );
  } catch (error) {
    console.warn(`[kd] ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    enabled: eligibility.enabled,
    ...(!eligibility.enabled ? { category: eligibility.category } : {}),
    ...(!eligibility.enabled && eligibility.warning
      ? { warning: eligibility.warning }
      : {}),
    revision: paths.revision,
    binary: paths.binary,
    installed: existsSync(paths.binary),
    ...(manifest ? { manifest } : {}),
    events
  };
}
