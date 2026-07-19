import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync
} from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import type { CommandRunner } from "./process";
import {
  KANACHE_PROFILE,
  KANACHE_REPOSITORY,
  KANACHE_REVISION,
  parseKanacheManifest,
  parseRustCacheMode,
  parseWorktreeList,
  rankDonors,
  resolveKanachePaths
} from "./rust-cache-policy";
import type { DonorCandidate } from "./rust-cache-policy";

export interface RustCacheEvent {
  timestamp: string;
  repository: string;
  commit: string;
  destination: string;
  donor?: string;
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
}

export interface RustCacheOperationResult {
  ok: true;
  outcome: "hit" | "miss" | "recorded" | "record-miss";
  category: string;
  donor?: string;
  message: string;
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
  return resolve(path, value);
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

export async function warmRustCache(
  input: RustCacheRuntimeInput
): Promise<RustCacheOperationResult> {
  const mode = parseRustCacheMode(input.env.KANNA_RUST_CACHE);
  if (!mode.enabled) {
    if (mode.warning) console.warn(`[kd] ${mode.warning}`);
    return miss(mode.warning ? "invalid-mode" : "disabled", mode.warning);
  }
  if (process.platform !== "darwin") return miss("unsupported-platform");

  const destination = join(input.repoRoot, ".build", "cargo-build");
  if (existsSync(destination)) return miss("destination-exists");

  try {
    const worktrees = await input.runner.run("git", ["worktree", "list", "--porcelain"], {
      cwd: input.repoRoot,
      env: input.env
    });
    if (worktrees.exitCode !== 0) {
      return miss("git-worktree-list", worktrees.stderr.trim());
    }
    const rustc = await input.runner.run("rustc", ["-vV"], {
      cwd: input.repoRoot,
      env: input.env
    });
    const hostTarget = rustc.exitCode === 0 ? parseHostTarget(rustc.stdout) : undefined;
    if (!hostTarget) return miss("rustc-host", rustc.stderr.trim());

    const currentCommon = await gitCommonDirectory(input.runner, input.repoRoot, input.env);
    if (!currentCommon) return miss("git-common-dir");
    const candidates: DonorCandidate[] = [];

    for (const worktree of parseWorktreeList(worktrees.stdout)) {
      if (
        resolve(worktree.path) === resolve(input.repoRoot) ||
        worktree.head !== input.commit ||
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
        candidates.push({ ...worktree, manifest });
      } catch {
        // A malformed or incompatible donor is simply not eligible.
      }
    }

    const donors = rankDonors(candidates, hostTarget);
    if (donors.length === 0) return miss("no-donor");

    const binary = await ensureKanacheBinary({ homeDir: input.homeDir, runner: input.runner });
    const repository = repositoryId(currentCommon);
    for (const donor of donors) {
      const args = ["warm", donor.path, input.repoRoot, "--profile", KANACHE_PROFILE];
      for (const target of donor.manifest.targets) args.push("--target", target);
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
        commit: input.commit,
        destination: input.repoRoot,
        donor: donor.path,
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
          message: `Warmed private Cargo artifacts from ${donor.path}.`
        };
      }
    }
    return miss("all-donors-refused");
  } catch (error) {
    return miss("internal-error", error instanceof Error ? error.message : String(error));
  }
}
