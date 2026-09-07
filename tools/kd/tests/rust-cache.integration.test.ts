import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyRustCacheEnvironment, repositoryIdentity } from "../src/runtime/rust-cache";
import { resolveKachePaths } from "../src/runtime/rust-cache-policy";
import { loadReleaseEnvironment } from "../src/runtime/release-env";
import { nodeCommandRunner } from "../src/runtime/process";

const roots: string[] = [];
const describeMac = process.platform === "darwin" ? describe : describe.skip;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Cargo resolves its build and target directories from the environment *before*
 * a checkout's `.cargo/config.toml`, and kd exports `CARGO_BUILD_BUILD_DIR` for
 * every worktree. A test that inherits `process.env` therefore compiles its
 * disposable fixture into the *real* repository's build directory, mixing two
 * unrelated source roots in one Cargo fingerprint tree — the shared-build-dir
 * hazard that `docs/specs/safe-rust-build-caching.md` shows silently returning
 * stale artifacts. Every fixture build must own its directories.
 */
export function isolatedCargoEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const isolated = { ...env };
  delete isolated.CARGO_BUILD_BUILD_DIR;
  delete isolated.CARGO_BUILD_TARGET_DIR;
  delete isolated.CARGO_TARGET_DIR;
  return isolated;
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  const result = await nodeCommandRunner.run(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

/**
 * Stands in for the pinned kache binary: records the environment Cargo handed
 * the wrapper, then execs the real rustc so the build still succeeds.
 */
function installWrapperProbe(homeDir: string, log: string): string {
  const binary = resolveKachePaths(homeDir).binary;
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const [rustc, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  cacheDir: process.env.KACHE_CACHE_DIR,
  keySalt: process.env.KACHE_KEY_SALT,
  localOnly: process.env.KACHE_LOCAL_ONLY,
  cacheExecutables: process.env.KACHE_CACHE_EXECUTABLES,
  verifyRestores: process.env.KACHE_VERIFY_RESTORES,
  maxSize: process.env.KACHE_MAX_SIZE,
  cargoIncremental: process.env.CARGO_INCREMENTAL,
  incrementalFlag: args.some((value) => value.startsWith("incremental=")),
}) + "\\n");
const result = spawnSync(rustc, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 }
  );
  chmodSync(binary, 0o755);
  return binary;
}

interface Fixture {
  root: string;
  repoRoot: string;
  homeDir: string;
  log: string;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "kd-kache-integration-"));
  roots.push(root);
  const repoRoot = join(root, "repo");
  const homeDir = join(root, "home");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(repoRoot, ".cargo"), { recursive: true });
  writeFileSync(
    join(repoRoot, "Cargo.toml"),
    '[package]\nname = "kd-kache-probe"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n'
  );
  writeFileSync(join(repoRoot, "src", "lib.rs"), "pub fn probe() -> u32 { 1 }\n");
  // Kanna's real Cargo layout: private final artifacts, private intermediates.
  writeFileSync(
    join(repoRoot, ".cargo", "config.toml"),
    '[build]\ntarget-dir = ".build"\nbuild-dir = ".build/cargo-build"\n'
  );
  await run("git", ["init", "--quiet", repoRoot]);
  const log = join(root, "wrapper.jsonl");
  writeFileSync(log, "");
  return { root, repoRoot, homeDir, log };
}

describeMac("kache Cargo wiring", () => {
  it("routes every rustc invocation through the pinned wrapper with Kanna's store settings", async () => {
    const { repoRoot, homeDir, log } = await fixture();
    const binary = installWrapperProbe(homeDir, log);

    const cache = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...isolatedCargoEnv(), KANNA_RUST_CACHE: "on", CI: "" },
      platform: "darwin",
      arch: process.arch
    });
    expect(cache.state.active).toBe(true);

    await run("cargo", ["build"], { cwd: repoRoot, env: cache.env });

    const invocations = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.cacheDir).toBe(
        join(homeDir, "Library", "Caches", "kanna", "rust-kache", repositoryIdentity(repoRoot))
      );
      expect(invocation.localOnly).toBe("1");
      expect(invocation.keySalt).toMatch(/^kanna-source-v1:[0-9a-f]{64}$/);
      expect(invocation.cacheExecutables).toBe("0");
      expect(invocation.verifyRestores).toBe("always");
      expect(invocation.maxSize).toBe("10GiB");
      expect(invocation.cargoIncremental).toBe("0");
      // Hermetic compilation: Cargo must never ask rustc for incremental state.
      expect(invocation.incrementalFlag).toBe(false);
    }

    expect(cache.env.RUSTC_WRAPPER).toBe(binary);
    // Cargo still creates the layout directory; it must stay empty, because
    // incremental state is the disk cost hermetic caching trades away.
    const incremental = join(repoRoot, ".build", "cargo-build", "debug", "incremental");
    expect(existsSync(incremental) ? readdirSync(incremental) : []).toEqual([]);
    expect(existsSync(join(repoRoot, ".build", "debug", "libkd_kache_probe.rlib"))).toBe(true);
  }, 120_000);

  it("builds directly against rustc when the cache is opted out", async () => {
    const { repoRoot, homeDir, log } = await fixture();
    installWrapperProbe(homeDir, log);

    const cache = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...isolatedCargoEnv(), KANNA_RUST_CACHE: "off" },
      platform: "darwin",
      arch: process.arch
    });
    expect(cache.state.active).toBe(false);
    expect(cache.env.RUSTC_WRAPPER).toBeUndefined();

    await run("cargo", ["build"], { cwd: repoRoot, env: cache.env });
    expect(readFileSync(log, "utf8")).toBe("");
  }, 120_000);

  it("gives sibling worktrees of one repository the same store", async () => {
    const { root, repoRoot } = await fixture();
    const worktree = join(root, "worktrees", "task-a");
    mkdirSync(dirname(worktree), { recursive: true });
    await run("git", ["-C", repoRoot, "add", "."]);
    await run("git", ["-C", repoRoot, "-c", "user.email=kd@kanna", "-c", "user.name=kd", "commit", "--quiet", "-m", "probe"]);
    await run("git", ["-C", repoRoot, "worktree", "add", "--quiet", "-b", "task-a", worktree]);

    expect(repositoryIdentity(worktree)).toBe(repositoryIdentity(repoRoot));
  }, 120_000);

  it("strips the wrapper from the release environment", async () => {
    const { repoRoot, homeDir, log } = await fixture();
    installWrapperProbe(homeDir, log);

    const cache = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: {
        PATH: process.env.PATH ?? "",
        KANNA_RUST_CACHE: "on",
        KACHE_S3_BUCKET: "inherited"
      },
      platform: "darwin",
      arch: process.arch
    });
    expect(cache.state.active).toBe(true);

    const releaseEnv = await loadReleaseEnvironment({
      homeDir,
      env: cache.env
    });
    expect(releaseEnv.RUSTC_WRAPPER).toBeUndefined();
    expect(releaseEnv.RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
    expect(releaseEnv.CARGO_INCREMENTAL).toBeUndefined();
    expect(Object.keys(releaseEnv).some((key) => key.startsWith("KACHE_"))).toBe(false);
    expect(releaseEnv.PATH).toBe(process.env.PATH);
  }, 120_000);
});

/**
 * A two-crate workspace shaped like the incident: `defaults` gains a `session_id`
 * module at revision 2, and `consumer` re-exports it, so a `defaults` rlib built
 * from revision 1 makes `consumer` fail to compile with E0432 — exactly how the
 * stale restore surfaced in `./kd test all`.
 */
async function twoRevisionFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "kd-kache-revision-"));
  roots.push(root);
  const repoRoot = join(root, "repo");
  const homeDir = join(root, "home");
  for (const crate of ["defaults", "consumer"]) {
    mkdirSync(join(repoRoot, crate, "src"), { recursive: true });
  }
  // The consumer also builds an executable, so the `defaults` rlib is linked and
  // not merely read as metadata. The original incident surfaced in rustdoc for
  // exactly that reason: a stale rlib behind a current rmeta is invisible to an
  // ordinary library build.
  mkdirSync(join(repoRoot, "consumer", "src", "bin"), { recursive: true });
  mkdirSync(join(repoRoot, ".cargo"), { recursive: true });
  writeFileSync(
    join(repoRoot, "Cargo.toml"),
    '[workspace]\nmembers = ["defaults", "consumer"]\nresolver = "2"\n'
  );
  writeFileSync(
    join(repoRoot, "defaults", "Cargo.toml"),
    '[package]\nname = "kd-probe-defaults"\nversion = "0.1.0"\nedition = "2021"\n'
  );
  writeFileSync(
    join(repoRoot, "consumer", "Cargo.toml"),
    '[package]\nname = "kd-probe-consumer"\nversion = "0.1.0"\nedition = "2021"\n\n' +
      '[dependencies]\nkd-probe-defaults = { path = "../defaults" }\n'
  );
  writeFileSync(
    join(repoRoot, ".cargo", "config.toml"),
    '[build]\ntarget-dir = ".build"\nbuild-dir = ".build/cargo-build"\n'
  );
  await run("git", ["init", "--quiet", repoRoot]);
  const log = join(root, "wrapper.jsonl");
  writeFileSync(log, "");
  return { root, repoRoot, homeDir, log };
}

/**
 * `base()` deliberately returns a different value per revision, so the built
 * executable reports which revision's `defaults` archive it was actually linked
 * against. That catches a stale restore in the direction E0432 cannot: reverting
 * a checkout to revision 1 still compiles cleanly against a revision-2 rlib,
 * because revision 2 is a superset of the API revision 1 uses.
 */
function writeRevision(repoRoot: string, revision: 1 | 2): void {
  const probe = join(repoRoot, "consumer", "src", "bin", "probe.rs");
  if (revision === 1) {
    rmSync(join(repoRoot, "defaults", "src", "session_id.rs"), { force: true });
    writeFileSync(join(repoRoot, "defaults", "src", "lib.rs"), "pub fn base() -> u32 { 1 }\n");
    writeFileSync(
      join(repoRoot, "consumer", "src", "lib.rs"),
      "pub fn use_base() -> u32 { kd_probe_defaults::base() }\n"
    );
    writeFileSync(probe, 'fn main() { println!("{}", kd_probe_consumer::use_base()); }\n');
    return;
  }
  writeFileSync(
    join(repoRoot, "defaults", "src", "session_id.rs"),
    "pub fn validate(id: &str) -> bool { !id.is_empty() }\n"
  );
  writeFileSync(
    join(repoRoot, "defaults", "src", "lib.rs"),
    "pub mod session_id;\npub fn base() -> u32 { 2 }\n"
  );
  writeFileSync(
    join(repoRoot, "consumer", "src", "lib.rs"),
    "pub use kd_probe_defaults::session_id;\npub fn use_base() -> u32 { kd_probe_defaults::base() }\n"
  );
  // Reads through the linked rlib, so a revision-1 archive behind a revision-2
  // metadata file fails here rather than passing silently.
  writeFileSync(
    probe,
    'fn main() { assert!(kd_probe_consumer::session_id::validate("x")); ' +
      'println!("{}", kd_probe_consumer::use_base()); }\n'
  );
}

/**
 * Stands in for a cache that mis-selects a key: after each `defaults` compile it
 * overwrites the fresh outputs with the recorded revision-1 ones. Both `.rmeta`
 * and `.rlib` are replaced, because rustc resolves imports from the metadata —
 * restoring only the archive is invisible to a normal build, which is why the
 * real incident surfaced in rustdoc, where the rlib is linked directly.
 */
function installStaleRestoringCache(homeDir: string, log: string, staleDir: string): string {
  const binary = resolveKachePaths(homeDir).binary;
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [rustc, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, "invoked\\n");
const result = spawnSync(rustc, args, { stdio: "inherit" });
const outIndex = args.indexOf("--out-dir");
if (outIndex !== -1) {
  const outDir = args[outIndex + 1];
  for (const stale of fs.readdirSync(${JSON.stringify(staleDir)})) {
    for (const produced of fs.readdirSync(outDir)) {
      const sameKind = produced.endsWith(path.extname(stale));
      if (sameKind && produced.startsWith("libkd_probe_defaults")) {
        fs.copyFileSync(path.join(${JSON.stringify(staleDir)}, stale), path.join(outDir, produced));
      }
    }
  }
}
process.exit(result.status ?? 1);
`,
    { mode: 0o755 }
  );
  chmodSync(binary, 0o755);
  return binary;
}

describeMac("fixture builds stay out of the real repository's build directory", () => {
  it("strips inherited Cargo build/target directories", () => {
    const isolated = isolatedCargoEnv({
      PATH: "/usr/bin",
      CARGO_BUILD_BUILD_DIR: "/repo/.build/cargo-build",
      CARGO_BUILD_TARGET_DIR: "/repo/.build",
      CARGO_TARGET_DIR: "/repo/.build"
    });
    expect(isolated).toEqual({ PATH: "/usr/bin" });
  });

  it("compiles a fixture into the fixture's own build directory", async () => {
    const { repoRoot } = await fixture();
    // Simulates `./kd test all`, where vitest inherits kd's worktree env. If the
    // fixture honoured that, two unrelated source roots would share one Cargo
    // fingerprint tree and the real repository could be handed a stale artifact.
    const inherited = {
      ...isolatedCargoEnv(),
      CARGO_BUILD_BUILD_DIR: "/nonexistent/shared/cargo-build"
    };
    const metadata = JSON.parse(
      await run("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
        cwd: repoRoot,
        env: isolatedCargoEnv(inherited)
      })
    ) as { build_directory?: string; target_directory?: string };

    expect(metadata.build_directory ?? "").toContain(repoRoot);
    expect(metadata.target_directory ?? "").toContain(repoRoot);
  }, 120_000);
});

describeMac("the two-revision fixture detects a mis-selected cache key", () => {
  /**
   * The negative control for the real-binary suite below. A cache that selects
   * the wrong key is indistinguishable from a correct one unless the harness can
   * actually observe the fault, so this installs a deliberately broken cache at
   * the pinned path — it restores recorded revision-1 outputs over every fresh
   * `defaults` compile — and proves the fixture fails loudly. Without this, "the
   * real binary passed" would only mean the probe is insensitive.
   */
  it("fails with E0432 when the cache serves a revision-1 artifact to revision 2", async () => {
    const { root, repoRoot, homeDir, log } = await twoRevisionFixture();

    // Record a real revision-1 rlib and rmeta, then poison the cache with them.
    writeRevision(repoRoot, 1);
    await run("cargo", ["build", "-p", "kd-probe-defaults"], {
      cwd: repoRoot,
      env: isolatedCargoEnv()
    });
    const depsDir = join(repoRoot, ".build", "cargo-build", "debug", "deps");
    const staleDir = join(root, "stale");
    mkdirSync(staleDir, { recursive: true });
    const recorded = readdirSync(depsDir).filter(
      (f) => f.startsWith("libkd_probe_defaults") && (f.endsWith(".rlib") || f.endsWith(".rmeta"))
    );
    expect(recorded.length).toBeGreaterThan(0);
    for (const file of recorded) {
      writeFileSync(join(staleDir, file), readFileSync(join(depsDir, file)));
    }
    installStaleRestoringCache(homeDir, log, staleDir);

    // Advance the sources, then build the way a developer actually does — with
    // no KANNA_RUST_CACHE set at all, which is now an enabled cache.
    writeRevision(repoRoot, 2);
    rmSync(join(repoRoot, ".build", "cargo-build"), { recursive: true, force: true });

    const cache = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...isolatedCargoEnv(), CI: "" },
      platform: "darwin",
      arch: process.arch
    });
    expect(cache.state.active).toBe(true);

    // `-j 1` is what makes the poisoning deterministic. This stand-in cache
    // overwrites the `defaults` outputs only after rustc exits, but cargo's
    // metadata pipelining lets the consumer start as soon as rustc emits the
    // fresh `.rmeta` — so with parallel jobs the consumer can read a
    // revision-2 metadata file and fail later at link time with E0460 instead.
    // One job keeps the consumer queued until the poisoned `defaults` unit is
    // finished, which is the ordering this negative control is about. (Verified
    // by widening the overwrite window to 800ms: parallel builds fail with
    // E0460, `-j 1` still reports E0432.)
    const result = await nodeCommandRunner.run(
      "cargo",
      ["build", "-j", "1", "-p", "kd-probe-consumer"],
      { cwd: repoRoot, env: cache.env }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("E0432");
    expect(result.stderr).toContain("session_id");
    expect(readFileSync(log, "utf8")).not.toBe("");
  }, 180_000);

  it("opting out of an inherited active environment restores incremental compilation", async () => {
    const { repoRoot, homeDir, log } = await twoRevisionFixture();
    writeRevision(repoRoot, 2);
    installWrapperProbe(homeDir, log);

    const active = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...isolatedCargoEnv(), KANNA_RUST_CACHE: "on", CI: "" },
      platform: "darwin",
      arch: process.arch
    });
    expect(active.state.active).toBe(true);

    // A kd-spawned shell inherits `active.env`; opting out inside it must undo
    // the wrapper and restore Cargo's own incremental compilation.
    const optedOut = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...active.env, KANNA_RUST_CACHE: "off" },
      platform: "darwin",
      arch: process.arch
    });
    expect(optedOut.state).toMatchObject({ active: false, category: "disabled" });

    await run("cargo", ["build", "-p", "kd-probe-consumer"], { cwd: repoRoot, env: optedOut.env });

    expect(readFileSync(log, "utf8")).toBe("");
    const incremental = join(repoRoot, ".build", "cargo-build", "debug", "incremental");
    expect(existsSync(incremental)).toBe(true);
    expect(readdirSync(incremental).length).toBeGreaterThan(0);
  }, 180_000);
});

/**
 * The cross-revision key-selection suite, run against the **real pinned kache
 * binary** rather than a stub.
 *
 * It is gated on that binary already being installed at its pinned path, which
 * is exactly the condition under which the cache can affect a build: when it is
 * absent `applyRustCacheEnvironment` resolves `not-installed` and falls back to
 * direct rustc (pinned by "stays inert when the pinned tool is not installed" in
 * `rust-cache.test.ts`). So the gate is a biconditional, not a coverage hole —
 * the suite runs wherever the risk exists. `./kd rust-cache install` is what
 * puts the binary there, and it runs from this repository's `setup` list, so a
 * developer machine that builds through `kd` has it.
 *
 * The store is disposable: the fixture home symlinks the pinned tool root, so
 * the real binary runs while `KACHE_CACHE_DIR` still resolves under the
 * fixture's own home and no developer's store is read or written.
 */
const pinnedKache = resolveKachePaths(homedir());
const describeRealKache =
  process.platform === "darwin" && existsSync(pinnedKache.binary) ? describe : describe.skip;

function linkPinnedKache(homeDir: string): void {
  const fixture = resolveKachePaths(homeDir);
  mkdirSync(dirname(fixture.versionRoot), { recursive: true });
  symlinkSync(pinnedKache.versionRoot, fixture.versionRoot);
}

interface CacheEntry {
  crate: string;
  hits: number;
}

/**
 * `kache list` prints one fixed-width row per stored entry. Sizes carry a unit
 * ("7.0 KiB"), so the columns are read from the end, where they are unambiguous.
 */
async function listCacheEntries(store: string): Promise<CacheEntry[]> {
  const stdout = await run(pinnedKache.binary, ["list"], {
    env: { ...isolatedCargoEnv(), KACHE_CACHE_DIR: store, KACHE_LOCAL_ONLY: "1" }
  });
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns[0]?.startsWith("kd_probe_"))
    .map((columns) => ({ crate: columns[0]!, hits: Number(columns.at(-3)) }))
    .filter((entry) => Number.isFinite(entry.hits));
}

function defaultsEntries(entries: CacheEntry[]): CacheEntry[] {
  return entries.filter((entry) => entry.crate === "kd_probe_defaults");
}

function totalHits(entries: CacheEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.hits, 0);
}

describeRealKache("pinned kache selects cache keys per source revision", () => {
  it("isolates divergent concurrent worktrees inside the shared repository store", async () => {
    const { root, repoRoot, homeDir } = await twoRevisionFixture();
    linkPinnedKache(homeDir);

    writeRevision(repoRoot, 1);
    await run("git", ["add", "."], { cwd: repoRoot });
    await run("git", ["-c", "user.name=Kanna", "-c", "user.email=kanna@example.invalid", "commit", "-qm", "revision 1"], {
      cwd: repoRoot
    });
    writeRevision(repoRoot, 2);
    await run("git", ["add", "."], { cwd: repoRoot });
    await run("git", ["-c", "user.name=Kanna", "-c", "user.email=kanna@example.invalid", "commit", "-qm", "revision 2"], {
      cwd: repoRoot
    });

    const firstRoot = join(root, "worktree-1");
    const secondRoot = join(root, "worktree-2");
    await run("git", ["worktree", "add", "--quiet", "--detach", firstRoot, "HEAD~1"], {
      cwd: repoRoot
    });
    await run("git", ["worktree", "add", "--quiet", "--detach", secondRoot, "HEAD"], {
      cwd: repoRoot
    });

    const cacheFor = (worktree: string) =>
      applyRustCacheEnvironment({
        repoRoot: worktree,
        homeDir,
        env: { ...isolatedCargoEnv(), CI: "" },
        platform: "darwin",
        arch: process.arch
      });
    const firstCache = cacheFor(firstRoot);
    const secondCache = cacheFor(secondRoot);
    if (!firstCache.state.active || !secondCache.state.active) {
      throw new Error("pinned cache unexpectedly inactive");
    }

    // Sharing remains intact at the blob/index layer, but the full source
    // snapshot participates in every logical key. This is the boundary the old
    // repository-only configuration lacked.
    expect(firstCache.state.store).toBe(secondCache.state.store);
    expect(firstCache.env.KACHE_KEY_SALT).not.toBe(secondCache.env.KACHE_KEY_SALT);

    const build = (worktree: string, env: NodeJS.ProcessEnv) =>
      run("cargo", ["build"], { cwd: worktree, env });
    await Promise.all([build(firstRoot, firstCache.env), build(secondRoot, secondCache.env)]);
    expect(await run(join(firstRoot, ".build", "debug", "probe"), [])).toBe("1");
    expect(await run(join(secondRoot, ".build", "debug", "probe"), [])).toBe("2");

    // Exercise concurrent restores too, not only concurrent publication.
    rmSync(join(firstRoot, ".build"), { recursive: true, force: true });
    rmSync(join(secondRoot, ".build"), { recursive: true, force: true });
    await Promise.all([build(firstRoot, firstCache.env), build(secondRoot, secondCache.env)]);
    expect(await run(join(firstRoot, ".build", "debug", "probe"), [])).toBe("1");
    expect(await run(join(secondRoot, ".build", "debug", "probe"), [])).toBe("2");
  }, 300_000);

  it("never serves an artifact compiled from a different revision", async () => {
    const { repoRoot, homeDir } = await twoRevisionFixture();
    linkPinnedKache(homeDir);

    // No KANNA_RUST_CACHE at all: this is the default a developer now gets.
    const cache = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...isolatedCargoEnv(), CI: "" },
      platform: "darwin",
      arch: process.arch
    });
    const state = cache.state;
    if (!state.active) throw new Error(`pinned cache inactive: ${JSON.stringify(state)}`);
    expect(state.binary).toBe(resolveKachePaths(homeDir).binary);

    const build = (): Promise<string> => run("cargo", ["build"], { cwd: repoRoot, env: cache.env });
    const coldTree = (): void => rmSync(join(repoRoot, ".build"), { recursive: true, force: true });
    const linkedRevision = (): Promise<string> =>
      run(join(repoRoot, ".build", "debug", "probe"), []);

    // 1. Populate the store from revision 1.
    writeRevision(repoRoot, 1);
    await build();

    // 2. Cold private tree, warm store. The restore path has to be live, or
    //    every assertion after this one passes vacuously.
    coldTree();
    await build();
    expect(await linkedRevision()).toBe("1");
    const afterRevision1 = await listCacheEntries(state.store);
    expect(defaultsEntries(afterRevision1)).toHaveLength(1);
    expect(totalHits(afterRevision1)).toBeGreaterThan(0);

    // 3. The incident, reproduced as a build: advance the sources against a
    //    store that holds only revision 1. Serving that entry fails to compile
    //    with `E0432: unresolved import ...session_id` — the negative control
    //    above proves this fixture reports exactly that.
    writeRevision(repoRoot, 2);
    coldTree();
    await build();
    expect(await linkedRevision()).toBe("2");
    const afterRevision2 = await listCacheEntries(state.store);
    expect(defaultsEntries(afterRevision2)).toHaveLength(2);

    // 4. Revision 2 must restore its *own* entry on a second cold tree. Without
    //    this, step 3 would be satisfied by a cache that simply never hits.
    coldTree();
    await build();
    expect(await linkedRevision()).toBe("2");
    const afterRevision2Restore = await listCacheEntries(state.store);
    expect(defaultsEntries(afterRevision2Restore)).toHaveLength(2);
    expect(totalHits(afterRevision2Restore)).toBeGreaterThan(totalHits(afterRevision2));

    // 5. The reverse direction, which is an ordinary branch switch: revision 1
    //    sources against a store holding both revisions. Revision 2's archive
    //    still satisfies revision 1's imports, so only the linked value tells
    //    the truth here.
    writeRevision(repoRoot, 1);
    coldTree();
    await build();
    expect(await linkedRevision()).toBe("1");
    const afterRevert = await listCacheEntries(state.store);
    expect(defaultsEntries(afterRevert)).toHaveLength(2);
    expect(totalHits(afterRevert)).toBeGreaterThan(totalHits(afterRevision2Restore));
  }, 300_000);

  it("keys on the compiler invocation, not only on the sources", async () => {
    // Sources are one input among several. This pins the next most likely way to
    // get a logically stale artifact with a physically valid blob: identical
    // sources compiled under different flags must not share an entry.
    const { repoRoot, homeDir } = await twoRevisionFixture();
    linkPinnedKache(homeDir);
    writeRevision(repoRoot, 1);

    const cache = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...isolatedCargoEnv(), CI: "" },
      platform: "darwin",
      arch: process.arch
    });
    const state = cache.state;
    if (!state.active) throw new Error(`pinned cache inactive: ${JSON.stringify(state)}`);

    await run("cargo", ["build"], { cwd: repoRoot, env: cache.env });
    expect(defaultsEntries(await listCacheEntries(state.store))).toHaveLength(1);

    rmSync(join(repoRoot, ".build"), { recursive: true, force: true });
    await run("cargo", ["build"], {
      cwd: repoRoot,
      env: { ...cache.env, RUSTFLAGS: "--cfg kd_probe_alt" }
    });
    expect(defaultsEntries(await listCacheEntries(state.store))).toHaveLength(2);
  }, 300_000);
});
