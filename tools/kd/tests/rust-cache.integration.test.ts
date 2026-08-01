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
      env: { ...process.env, KANNA_RUST_CACHE: "on", CI: "" },
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
      env: { ...process.env, KANNA_RUST_CACHE: "off" },
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
      env: { PATH: process.env.PATH ?? "", KACHE_S3_BUCKET: "inherited" },
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
