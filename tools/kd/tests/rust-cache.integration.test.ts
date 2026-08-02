import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
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
      repoRoot,
      homeDir,
      env: cache.env,
      runner: nodeCommandRunner
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

function writeRevision(repoRoot: string, revision: 1 | 2): void {
  if (revision === 1) {
    writeFileSync(join(repoRoot, "defaults", "src", "lib.rs"), "pub fn base() -> u32 { 1 }\n");
    writeFileSync(
      join(repoRoot, "consumer", "src", "lib.rs"),
      "pub fn use_base() -> u32 { kd_probe_defaults::base() }\n"
    );
    return;
  }
  writeFileSync(
    join(repoRoot, "defaults", "src", "session_id.rs"),
    "pub fn validate(id: &str) -> bool { !id.is_empty() }\n"
  );
  writeFileSync(
    join(repoRoot, "defaults", "src", "lib.rs"),
    "pub mod session_id;\npub fn base() -> u32 { 1 }\n"
  );
  writeFileSync(
    join(repoRoot, "consumer", "src", "lib.rs"),
    "pub use kd_probe_defaults::session_id;\n"
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

describeMac("stale-revision restores cannot reach a default build", () => {
  it("does not restore a revision-1 artifact into a revision-2 build", async () => {
    const { root, repoRoot, homeDir, log } = await twoRevisionFixture();

    // Record a real revision-1 rlib, then poison the cache with it.
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

    // Advance the sources, then build the way a developer actually does.
    writeRevision(repoRoot, 2);
    rmSync(join(repoRoot, ".build", "cargo-build"), { recursive: true, force: true });

    const cache = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...isolatedCargoEnv(), CI: "" },
      platform: "darwin",
      arch: process.arch
    });

    // Build first, so that a regression is demonstrated by its consequence and
    // not merely by a policy assertion: if the default ever reaches the cache
    // again, this build fails with `E0432: unresolved import ...session_id`,
    // exactly as `./kd test all` did.
    await run("cargo", ["build", "-p", "kd-probe-consumer"], { cwd: repoRoot, env: cache.env });

    // Opt-in only: kache 0.12.0 can mis-select a key, so the default resolution
    // must not reach the cache at all.
    expect(cache.state).toMatchObject({ active: false, category: "disabled-by-default" });
    expect(readFileSync(log, "utf8")).toBe("");
    const rebuilt = readdirSync(join(repoRoot, ".build", "cargo-build", "debug", "deps")).find(
      (f) => f.startsWith("libkd_probe_defaults") && f.endsWith(".rlib")
    );
    expect(rebuilt).toBeDefined();
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
