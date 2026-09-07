import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { CommandRunner } from "./process";
import {
  KACHE_MAX_SIZE,
  KACHE_VERSION,
  buildRustCacheEnvironment,
  resolveKacheArtifact,
  resolveKacheDownloadUrl,
  resolveKachePaths,
  resolveRustCacheEligibility,
  resolveRustCacheStore,
  stripRustCacheEnvironment
} from "./rust-cache-policy";
import type { KacheArtifact, RustCacheEligibility } from "./rust-cache-policy";

export interface RustCacheRuntimeInput {
  repoRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

export type RustCacheState =
  | { active: true; store: string; binary: string }
  | { active: false; category: string; warning?: string; store?: string; binary: string };

export interface RustCacheEnvironmentResult {
  env: NodeJS.ProcessEnv;
  state: RustCacheState;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Every worktree of a repository shares one content store, so the identity must
 * be the common Git directory rather than the checkout path. Derived from the
 * filesystem so that resolving a context never spawns another Git process.
 */
export function repositoryDirectory(repoRoot: string): string {
  const dotGit = join(repoRoot, ".git");
  try {
    if (lstatSync(dotGit).isDirectory()) return canonicalPath(dotGit);
    const gitDirectoryLine = readFileSync(dotGit, "utf8").trim();
    if (!gitDirectoryLine.startsWith("gitdir: ")) return canonicalPath(repoRoot);
    const gitDirectory = resolve(repoRoot, gitDirectoryLine.slice("gitdir: ".length));
    const commonDirectoryFile = join(gitDirectory, "commondir");
    if (!existsSync(commonDirectoryFile)) return canonicalPath(gitDirectory);
    return canonicalPath(resolve(gitDirectory, readFileSync(commonDirectoryFile, "utf8").trim()));
  } catch {
    return resolve(repoRoot);
  }
}

export function repositoryIdentity(repoRoot: string): string {
  return createHash("sha256").update(repositoryDirectory(repoRoot)).digest("hex").slice(0, 16);
}

/**
 * Identifies the source snapshot Cargo can see in this checkout.
 *
 * Kache's own key models individual rustc invocations, but a shared local
 * store also has mutable index state. Giving every complete checkout snapshot
 * a key salt prevents divergent worktrees from racing through the same logical
 * entries while retaining sharing between worktrees whose sources are byte-for-
 * byte identical. The repository store remains shared, so blobs are still
 * deduplicated and one 10 GiB GC cap applies to the repository as a whole.
 *
 * Hash every tracked and non-ignored untracked file, rather than HEAD or the
 * index: agents routinely build dirty worktrees, and Cargo reads working-tree
 * bytes. Ignored build products and dependencies are deliberately absent.
 */
export function sourceIdentity(repoRoot: string): string {
  const hash = createHash("sha256");
  let paths: string[];
  try {
    const listed = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: repoRoot,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
    paths = listed
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
  } catch {
    // A malformed or not-yet-initialized fixture must never fall back to the
    // repository-wide salt. Checkout-path scope is conservative and safe.
    return createHash("sha256").update(canonicalPath(repoRoot)).digest("hex");
  }

  for (const relativePath of paths) {
    hash.update(relativePath);
    hash.update("\0");
    const path = join(repoRoot, relativePath);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(readlinkSync(path));
      } else if (stat.isFile()) {
        hash.update(stat.mode & 0o111 ? "executable\0" : "file\0");
        hash.update(readFileSync(path));
      } else {
        // Gitlinks (submodules) are directories in the worktree. Their checked
        // out revision is source state even though their contents are not in
        // the parent repository's ls-files result.
        hash.update("directory\0");
        try {
          hash.update(
            execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: path,
              encoding: "utf8",
              maxBuffer: 1024 * 1024,
              stdio: ["ignore", "pipe", "ignore"]
            }).trim()
          );
        } catch {
          hash.update("unresolved");
        }
      }
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function rustCacheEligibility(input: RustCacheRuntimeInput): RustCacheEligibility {
  return resolveRustCacheEligibility({
    mode: input.env.KANNA_RUST_CACHE,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    ci: input.env.CI
  });
}

export function resolveRustCacheStorePath(input: RustCacheRuntimeInput): string {
  return resolveRustCacheStore(input.homeDir, repositoryIdentity(input.repoRoot));
}

function rustCacheWrapperPath(binary: string): string {
  return join(dirname(binary), "kanna-kache-wrapper.cjs");
}

/**
 * Cargo can be a long-lived descendant of `kd dev up`, so an environment
 * computed while kd starts cannot describe the sources Cargo sees later. This
 * tiny outer wrapper fingerprints the checkout immediately before every rustc
 * invocation and then delegates to the pinned kache binary. Kache still owns
 * locking and atomic blob publication in the shared store; divergent source
 * snapshots cannot address the same mutable index entry, while identical
 * snapshots retain cross-worktree hits.
 */
function ensureRustCacheWrapper(binary: string): string {
  const wrapper = rustCacheWrapperPath(binary);
  const contents = `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { lstatSync, readFileSync, readlinkSync } = require("node:fs");
const { join } = require("node:path");

const repoRoot = process.env.KANNA_RUST_CACHE_REPO_ROOT;
const kache = process.env.KANNA_KACHE_BINARY;
if (!repoRoot || !kache) process.exit(86);
const hash = createHash("sha256");
const gitBuffer = (args) => execFileSync("git", args, {
  cwd: repoRoot, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"]
});
let paths;
try {
  hash.update(gitBuffer(["rev-parse", "HEAD^{tree}"]).toString("utf8").trim());
  hash.update("\\0");
  const changed = gitBuffer(["diff", "--name-only", "-z", "HEAD"]);
  const untracked = gitBuffer(["ls-files", "--others", "--exclude-standard", "-z"]);
  paths = [...new Set(Buffer.concat([changed, untracked]).toString("utf8").split("\\0").filter(Boolean))].sort();
} catch {
  // Unborn repositories have no tree object; hash their complete index and
  // working tree. This is also the conservative path for malformed fixtures.
  paths = gitBuffer(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .toString("utf8").split("\\0").filter(Boolean).sort();
}
for (const relativePath of paths) {
  hash.update(relativePath); hash.update("\\0");
  const path = join(repoRoot, relativePath);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { hash.update("symlink\\0"); hash.update(readlinkSync(path)); }
    else if (stat.isFile()) { hash.update(stat.mode & 0o111 ? "executable\\0" : "file\\0"); hash.update(readFileSync(path)); }
    else {
      hash.update("directory\\0");
      try { hash.update(execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
      catch { hash.update("unresolved"); }
    }
  } catch { hash.update("missing"); }
  hash.update("\\0");
}
process.env.KACHE_KEY_SALT = "kanna-source-v2:" + hash.digest("hex");
const result = spawnSync(kache, process.argv.slice(2), { stdio: "inherit", env: process.env });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status == null ? 1 : result.status);
`;
  try {
    if (!existsSync(wrapper) || readFileSync(wrapper, "utf8") !== contents) {
      const temporary = `${wrapper}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, contents, { mode: 0o755 });
      renameSync(temporary, wrapper);
    }
    chmodSync(wrapper, 0o755);
  } catch (error) {
    throw new Error(`could not install the Kanna kache wrapper: ${String(error)}`);
  }
  return wrapper;
}

let warnedMissingBinary = false;

/**
 * Resolves the compiler-cache environment for a command, authoritatively.
 *
 * The result is a pure function of the resolution, not of what the caller
 * happened to inherit: every wrapper and cache control kd owns is scrubbed
 * first, on both the active and inactive paths. That matters because kd
 * environments nest. A kd-spawned shell already carries `RUSTC_WRAPPER` and
 * `CARGO_INCREMENTAL=0`, so a plain merge would let `KANNA_RUST_CACHE=off`
 * report inactive while still routing Cargo through kache and suppressing
 * incremental compilation — the documented opt-out would not actually opt out.
 * Scrubbing also drops ambient hostility that would otherwise survive an active
 * resolution: an inherited `RUSTC_WORKSPACE_WRAPPER` runs nested inside our
 * wrapper rather than being replaced by it, and an inherited `KACHE_DISABLED`
 * would silently neuter the cache we just enabled.
 *
 * Applying this twice yields the same environment as applying it once.
 */
export function applyRustCacheEnvironment(
  input: RustCacheRuntimeInput
): RustCacheEnvironmentResult {
  const paths = resolveKachePaths(input.homeDir);
  const eligibility = rustCacheEligibility(input);
  // Cargo's default incremental behaviour is restored by removing our override,
  // not by setting a value, so an opt-out returns to plain incremental builds.
  const base = stripRustCacheEnvironment(input.env);

  if (!eligibility.enabled) {
    return {
      env: base,
      state: {
        active: false,
        category: eligibility.category,
        ...(eligibility.warning ? { warning: eligibility.warning } : {}),
        binary: paths.binary
      }
    };
  }

  // The cache is on by default, so this is the state of any checkout that has
  // not run setup. Fall back to direct rustc rather than downloading a compiler
  // wrapper from inside an arbitrary build, and say both ways out once.
  if (!existsSync(paths.binary)) {
    if (!warnedMissingBinary) {
      warnedMissingBinary = true;
      console.warn(
        `[kd] Rust build cache is on but kache ${KACHE_VERSION} is not installed; building without it. ` +
          `Run ./kd rust-cache install, or set KANNA_RUST_CACHE=off to silence this.`
      );
    }
    return {
      env: base,
      state: { active: false, category: "not-installed", binary: paths.binary }
    };
  }

  const store = resolveRustCacheStorePath(input);
  const wrapper = ensureRustCacheWrapper(paths.binary);
  return {
    env: {
      ...base,
      ...buildRustCacheEnvironment({
        binary: wrapper,
        store,
        sourceIdentity: sourceIdentity(input.repoRoot)
      }),
      KANNA_KACHE_BINARY: paths.binary,
      KANNA_RUST_CACHE_REPO_ROOT: canonicalPath(input.repoRoot)
    },
    state: { active: true, store, binary: paths.binary }
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface EnsureKacheBinaryInput {
  homeDir: string;
  runner: CommandRunner;
  arch?: string;
  /** Defaults to the pinned manifest entry for `arch`; overridden only by tests. */
  artifact?: KacheArtifact;
}

/**
 * Bootstraps the pinned release archive into a Kanna-owned tooling cache. The
 * SHA-256 is verified before anything is extracted, the extracted binary must
 * report the pinned version, and publication is a single atomic rename so a
 * partially downloaded tool can never be observed as installed.
 */
export async function ensureKacheBinary(input: EnsureKacheBinaryInput): Promise<string> {
  const paths = resolveKachePaths(input.homeDir);
  if (existsSync(paths.binary)) return paths.binary;

  const arch = input.arch ?? process.arch;
  const artifact: KacheArtifact | undefined = input.artifact ?? resolveKacheArtifact(arch);
  if (!artifact) {
    throw new Error(`no pinned kache ${KACHE_VERSION} release for architecture ${arch}`);
  }

  const parent = dirname(paths.versionRoot);
  mkdirSync(parent, { recursive: true });
  const tempRoot = mkdtempSync(join(parent, `.install-${KACHE_VERSION}-`));

  try {
    const archive = join(tempRoot, artifact.asset);
    const url = resolveKacheDownloadUrl(artifact);
    const downloaded = await input.runner.run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--tlsv1.2",
      "--output",
      archive,
      url
    ]);
    if (downloaded.exitCode !== 0) {
      throw new Error(downloaded.stderr.trim() || `failed to download ${url}`);
    }

    const digest = sha256File(archive);
    if (digest !== artifact.sha256) {
      throw new Error(
        `kache ${KACHE_VERSION} checksum mismatch for ${artifact.asset}: expected ${artifact.sha256}, got ${digest}`
      );
    }

    const binDirectory = join(tempRoot, "bin");
    mkdirSync(binDirectory, { recursive: true });
    const extracted = await input.runner.run("tar", ["-xzf", archive, "-C", binDirectory]);
    if (extracted.exitCode !== 0) {
      throw new Error(extracted.stderr.trim() || `failed to extract ${artifact.asset}`);
    }

    const tempBinary = join(binDirectory, "kache");
    if (!existsSync(tempBinary)) {
      throw new Error(`${artifact.asset} did not contain a kache executable`);
    }
    chmodSync(tempBinary, 0o755);
    rmSync(archive, { force: true });

    const verified = await input.runner.run(tempBinary, ["--version"]);
    if (verified.exitCode !== 0 || verified.stdout.trim() !== `kache ${KACHE_VERSION}`) {
      throw new Error(`installed kache did not report version ${KACHE_VERSION}`);
    }

    try {
      renameSync(tempRoot, paths.versionRoot);
    } catch (error) {
      // A concurrent kd may have published the same pinned version first.
      if (!existsSync(paths.binary)) {
        throw new Error(`failed to publish kache at ${paths.versionRoot}`, { cause: error });
      }
    }
    return paths.binary;
  } finally {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

export interface RustCacheInstallResult {
  version: string;
  binary: string;
  store: string;
  eligible: boolean;
  category?: string;
}

export async function installRustCache(
  input: RustCacheRuntimeInput & { runner: CommandRunner }
): Promise<RustCacheInstallResult> {
  const paths = resolveKachePaths(input.homeDir);
  const eligibility = rustCacheEligibility(input);
  const store = resolveRustCacheStorePath(input);
  if (!eligibility.enabled) {
    return {
      version: KACHE_VERSION,
      binary: paths.binary,
      store,
      eligible: false,
      category: eligibility.category
    };
  }

  const binary = await ensureKacheBinary({
    homeDir: input.homeDir,
    runner: input.runner,
    arch: input.arch
  });
  mkdirSync(store, { recursive: true });
  return { version: KACHE_VERSION, binary, store, eligible: true };
}

export interface RustCacheStatus {
  enabled: boolean;
  category?: string;
  warning?: string;
  version: string;
  binary: string;
  installed: boolean;
  store: string;
  maxSize: string;
  stats?: string;
}

export async function getRustCacheStatus(
  input: RustCacheRuntimeInput & { runner: CommandRunner }
): Promise<RustCacheStatus> {
  const eligibility = rustCacheEligibility(input);
  const paths = resolveKachePaths(input.homeDir);
  const installed = existsSync(paths.binary);
  const store = resolveRustCacheStorePath(input);

  let stats: string | undefined;
  if (installed) {
    const result = await input.runner.run(paths.binary, ["stats"], {
      cwd: input.repoRoot,
      // Report against Kanna's store and cap even when the cache is disabled
      // for builds, so status never shows kache's own 50 GiB default.
      env: {
        ...input.env,
        KACHE_CACHE_DIR: store,
        KACHE_LOCAL_ONLY: "1",
        KACHE_MAX_SIZE
      }
    });
    stats = (result.exitCode === 0 ? result.stdout : result.stderr).trim() || undefined;
  }

  return {
    enabled: eligibility.enabled,
    ...(!eligibility.enabled ? { category: eligibility.category } : {}),
    ...(!eligibility.enabled && eligibility.warning ? { warning: eligibility.warning } : {}),
    version: KACHE_VERSION,
    binary: paths.binary,
    installed,
    store,
    maxSize: KACHE_MAX_SIZE,
    ...(stats ? { stats } : {})
  };
}
