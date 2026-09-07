import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRustCacheEnvironment,
  ensureKacheBinary,
  getRustCacheStatus,
  installRustCache,
  repositoryIdentity,
  resolveRustCacheStorePath,
  sourceIdentity
} from "../src/runtime/rust-cache";
import {
  KACHE_ARTIFACTS,
  KACHE_VERSION,
  resolveKachePaths
} from "../src/runtime/rust-cache-policy";
import type { CommandRunner } from "../src/runtime/process";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const ARM64_ARTIFACT = KACHE_ARTIFACTS.arm64!;
const ARCHIVE_BODY = "kache-archive";

/**
 * A pin whose checksum matches what the fake `curl` writes, so the happy path
 * reaches extraction. The real pinned checksums are asserted for shape by the
 * policy test and were verified against the published `.sha256` assets.
 */
const MATCHING_PIN = {
  ...ARM64_ARTIFACT,
  sha256: createHash("sha256").update(ARCHIVE_BODY).digest("hex")
};

interface FakeInstallOptions {
  version?: string;
  calls?: string[];
}

/**
 * Stands in for the pinned release: `curl` writes an archive body, `tar`
 * extracts a fake executable, and the executable reports a version.
 */
function fakeInstallRunner(options: FakeInstallOptions = {}): CommandRunner {
  const body = ARCHIVE_BODY;
  return {
    async run(command, args) {
      options.calls?.push(`${command} ${args.join(" ")}`);
      if (command === "curl") {
        const output = args[args.indexOf("--output") + 1]!;
        writeFileSync(output, body);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "tar") {
        const destination = args[args.indexOf("-C") + 1]!;
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "kache"), "#!/bin/sh\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: `kache ${options.version ?? KACHE_VERSION}\n`,
        stderr: ""
      };
    }
  };
}

describe("kache bootstrap", () => {
  it("refuses to publish an archive whose checksum does not match the pin", async () => {
    const home = scratch("kd-kache-home-");
    await expect(
      ensureKacheBinary({ homeDir: home, runner: fakeInstallRunner(), arch: "arm64" })
    ).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(resolveKachePaths(home).binary)).toBe(false);
  });

  it("leaves no partial install behind after a failed verification", async () => {
    const home = scratch("kd-kache-home-");
    const parent = dirname(resolveKachePaths(home).versionRoot);
    await expect(
      ensureKacheBinary({ homeDir: home, runner: fakeInstallRunner(), arch: "arm64" })
    ).rejects.toThrow();
    expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
  });

  it("rejects an architecture with no pinned release", async () => {
    const home = scratch("kd-kache-home-");
    await expect(
      ensureKacheBinary({ homeDir: home, runner: fakeInstallRunner(), arch: "arm" })
    ).rejects.toThrow(/no pinned kache/);
  });

  it("downloads the pinned asset over HTTPS and verifies the reported version", async () => {
    const home = scratch("kd-kache-home-");
    const calls: string[] = [];
    const binary = await ensureKacheBinary({
      homeDir: home,
      runner: fakeInstallRunner({ calls }),
      arch: "arm64",
      artifact: MATCHING_PIN
    });
    expect(binary).toBe(resolveKachePaths(home).binary);
    expect(existsSync(binary)).toBe(true);
    const download = calls.find((call) => call.startsWith("curl"));
    expect(download).toContain("--proto =https");
    expect(download).toContain(
      `https://github.com/kunobi-ninja/kache/releases/download/v${KACHE_VERSION}/${MATCHING_PIN.asset}`
    );
    expect(calls.some((call) => call.includes("--version"))).toBe(true);
    // The verified archive must not be left inside the published tool root.
    expect(existsSync(join(resolveKachePaths(home).versionRoot, MATCHING_PIN.asset))).toBe(false);
  });

  it("rejects a binary that does not report the pinned version", async () => {
    const home = scratch("kd-kache-home-");
    await expect(
      ensureKacheBinary({
        homeDir: home,
        runner: fakeInstallRunner({ version: "0.1.0" }),
        arch: "arm64",
        artifact: MATCHING_PIN
      })
    ).rejects.toThrow(new RegExp(`did not report version ${KACHE_VERSION}`));
    expect(existsSync(resolveKachePaths(home).binary)).toBe(false);
  });

  it("reuses an already published tool without downloading again", async () => {
    const home = scratch("kd-kache-home-");
    const paths = resolveKachePaths(home);
    mkdirSync(dirname(paths.binary), { recursive: true });
    writeFileSync(paths.binary, "#!/bin/sh\n");
    const calls: string[] = [];
    const binary = await ensureKacheBinary({
      homeDir: home,
      runner: fakeInstallRunner({ calls }),
      arch: "arm64"
    });
    expect(binary).toBe(paths.binary);
    expect(calls).toEqual([]);
  });
});

describe("repository identity", () => {
  function worktree(root: string, name: string, commonDirectory: string): string {
    const path = join(root, name);
    mkdirSync(join(commonDirectory, "worktrees", name), { recursive: true });
    writeFileSync(join(commonDirectory, "worktrees", name, "commondir"), "../..\n");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".git"), `gitdir: ${join(commonDirectory, "worktrees", name)}\n`);
    return path;
  }

  it("gives every worktree of a repository the same store", () => {
    const root = scratch("kd-kache-repo-");
    const commonDirectory = join(root, "primary", ".git");
    mkdirSync(commonDirectory, { recursive: true });
    const primary = join(root, "primary");
    const first = worktree(root, "task-a", commonDirectory);
    const second = worktree(root, "task-b", commonDirectory);

    expect(repositoryIdentity(first)).toBe(repositoryIdentity(primary));
    expect(repositoryIdentity(second)).toBe(repositoryIdentity(primary));
  });

  it("gives a different repository a different store", () => {
    const root = scratch("kd-kache-repo-");
    const first = join(root, "one");
    const second = join(root, "two");
    mkdirSync(join(first, ".git"), { recursive: true });
    mkdirSync(join(second, ".git"), { recursive: true });
    expect(repositoryIdentity(first)).not.toBe(repositoryIdentity(second));
  });

  it("resolves the store under the Kanna cache root", () => {
    const root = scratch("kd-kache-repo-");
    const repoRoot = join(root, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    expect(resolveRustCacheStorePath({ repoRoot, homeDir: "/home/kanna", env: {} })).toBe(
      `/home/kanna/Library/Caches/kanna/rust-kache/${repositoryIdentity(repoRoot)}`
    );
  });
});

describe("source identity", () => {
  it("changes with working-tree bytes and returns when the bytes return", () => {
    const root = scratch("kd-kache-source-");
    const repoRoot = join(root, "repo");
    mkdirSync(repoRoot, { recursive: true });
    execFileSync("git", ["init", "--quiet", repoRoot]);
    writeFileSync(join(repoRoot, "Cargo.toml"), "one\n");
    const first = sourceIdentity(repoRoot);
    writeFileSync(join(repoRoot, "Cargo.toml"), "two\n");
    const second = sourceIdentity(repoRoot);
    writeFileSync(join(repoRoot, "Cargo.toml"), "one\n");

    expect(second).not.toBe(first);
    expect(sourceIdentity(repoRoot)).toBe(first);
  });
});

describe("rust cache environment application", () => {
  function fixture(): { repoRoot: string; homeDir: string } {
    const root = scratch("kd-kache-env-");
    const repoRoot = join(root, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    return { repoRoot, homeDir: join(root, "home") };
  }

  function install(homeDir: string): string {
    const paths = resolveKachePaths(homeDir);
    mkdirSync(dirname(paths.binary), { recursive: true });
    writeFileSync(paths.binary, "#!/bin/sh\n");
    return paths.binary;
  }

  it("points Cargo at the pinned wrapper and this repository's store", () => {
    const { repoRoot, homeDir } = fixture();
    const binary = install(homeDir);
    const result = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { PATH: "/usr/bin", KANNA_RUST_CACHE: "on" },
      platform: "darwin",
      arch: "arm64"
    });
    expect(result.state).toEqual({
      active: true,
      binary,
      store: resolveRustCacheStorePath({ repoRoot, homeDir, env: {} })
    });
    expect(result.env.RUSTC_WRAPPER).toBe(binary);
    expect(result.env.KACHE_CACHE_DIR).toBe(
      resolveRustCacheStorePath({ repoRoot, homeDir, env: {} })
    );
    expect(result.env.KACHE_KEY_SALT).toMatch(/^kanna-source-v1:[0-9a-f]{64}$/);
    expect(result.env.KACHE_LOCAL_ONLY).toBe("1");
    expect(result.env.KACHE_CACHE_EXECUTABLES).toBe("0");
    expect(result.env.CARGO_INCREMENTAL).toBe("0");
    expect(result.env.PATH).toBe("/usr/bin");
  });

  it("stays inert when the pinned tool is not installed", () => {
    const { repoRoot, homeDir } = fixture();
    const result = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { PATH: "/usr/bin", KANNA_RUST_CACHE: "on" },
      platform: "darwin",
      arch: "arm64"
    });
    expect(result.state).toMatchObject({ active: false, category: "not-installed" });
    expect(result.env.RUSTC_WRAPPER).toBeUndefined();
    expect(result.env.PATH).toBe("/usr/bin");
  });

  it("is active by default once the pinned tool is installed", () => {
    const { repoRoot, homeDir } = fixture();
    const binary = install(homeDir);
    const result = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      arch: "arm64"
    });
    expect(result.state.active).toBe(true);
    expect(result.env.RUSTC_WRAPPER).toBe(binary);
  });

  it("stays inert when opted out, in CI, or off a supported host", () => {
    const { repoRoot, homeDir } = fixture();
    install(homeDir);
    for (const [env, category] of [
      [{ KANNA_RUST_CACHE: "off" }, "disabled"],
      [{ KANNA_RUST_CACHE: "kanache" }, "invalid-mode"],
      [{ KANNA_RUST_CACHE: "on", CI: "true" }, "disabled-in-ci"]
    ] as const) {
      const result = applyRustCacheEnvironment({
        repoRoot,
        homeDir,
        env,
        platform: "darwin",
        arch: "arm64"
      });
      expect(result.state).toMatchObject({ active: false, category });
      expect(result.env.RUSTC_WRAPPER).toBeUndefined();
    }

    const linux = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { KANNA_RUST_CACHE: "on" },
      platform: "linux",
      arch: "arm64"
    });
    expect(linux.state).toMatchObject({ active: false, category: "unsupported-platform" });
  });

  it("opting out of an inherited active environment restores direct incremental builds", () => {
    const { repoRoot, homeDir } = fixture();
    install(homeDir);
    // kd environments nest: a shell spawned by kd already carries the active
    // cache settings, so opting out has to undo them, not merely report off.
    const active = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { PATH: "/usr/bin", KANNA_RUST_CACHE: "on" },
      platform: "darwin",
      arch: "arm64"
    });
    expect(active.state.active).toBe(true);

    const optedOut = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: { ...active.env, KANNA_RUST_CACHE: "off" },
      platform: "darwin",
      arch: "arm64"
    });
    expect(optedOut.state).toMatchObject({ active: false, category: "disabled" });
    expect(optedOut.env.RUSTC_WRAPPER).toBeUndefined();
    expect(optedOut.env.CARGO_INCREMENTAL).toBeUndefined();
    expect(optedOut.env.KACHE_CACHE_DIR).toBeUndefined();
    expect(Object.keys(optedOut.env).some((key) => key.startsWith("KACHE_"))).toBe(false);
    expect(optedOut.env.PATH).toBe("/usr/bin");
  });

  it("drops ambient wrappers and disable switches that would survive an active resolution", () => {
    const { repoRoot, homeDir } = fixture();
    const binary = install(homeDir);
    const result = applyRustCacheEnvironment({
      repoRoot,
      homeDir,
      env: {
        PATH: "/usr/bin",
        KANNA_RUST_CACHE: "on",
        // Cargo nests this inside RUSTC_WRAPPER, so it would still run.
        RUSTC_WORKSPACE_WRAPPER: "/bin/false",
        CARGO_BUILD_RUSTC_WRAPPER: "/bin/false",
        CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "/bin/false",
        // kache honours this and would silently pass every compile through.
        KACHE_DISABLED: "1",
        KACHE_CACHE_DIR: "/somewhere/else"
      },
      platform: "darwin",
      arch: "arm64"
    });
    expect(result.state.active).toBe(true);
    expect(result.env.RUSTC_WRAPPER).toBe(binary);
    expect(result.env.RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
    expect(result.env.CARGO_BUILD_RUSTC_WRAPPER).toBeUndefined();
    expect(result.env.CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
    expect(result.env.KACHE_DISABLED).toBeUndefined();
    expect(result.env.KACHE_CACHE_DIR).toBe(
      resolveRustCacheStorePath({ repoRoot, homeDir, env: {} })
    );
  });

  it("is idempotent: reapplying yields the same environment", () => {
    const { repoRoot, homeDir } = fixture();
    install(homeDir);
    const input = { repoRoot, homeDir, platform: "darwin" as const, arch: "arm64" };
    const once = applyRustCacheEnvironment({ ...input, env: { PATH: "/usr/bin", KANNA_RUST_CACHE: "on" } });
    const twice = applyRustCacheEnvironment({ ...input, env: once.env });
    expect(twice.env).toEqual(once.env);
    expect(twice.state).toEqual(once.state);
  });
});

describe("rust cache commands", () => {
  function fixture(): { repoRoot: string; homeDir: string } {
    const root = scratch("kd-kache-command-");
    const repoRoot = join(root, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    return { repoRoot, homeDir: join(root, "home") };
  }

  it("install creates the repository store next to the verified tool", async () => {
    const { repoRoot, homeDir } = fixture();
    const paths = resolveKachePaths(homeDir);
    mkdirSync(dirname(paths.binary), { recursive: true });
    writeFileSync(paths.binary, "#!/bin/sh\n");
    const result = await installRustCache({
      repoRoot,
      homeDir,
      env: { KANNA_RUST_CACHE: "on" },
      platform: "darwin",
      arch: "arm64",
      runner: fakeInstallRunner()
    });
    expect(result).toEqual({
      version: KACHE_VERSION,
      binary: paths.binary,
      store: resolveRustCacheStorePath({ repoRoot, homeDir, env: {} }),
      eligible: true
    });
    expect(existsSync(result.store)).toBe(true);
  });

  it("install does nothing when the cache is disabled", async () => {
    const { repoRoot, homeDir } = fixture();
    const calls: string[] = [];
    const result = await installRustCache({
      repoRoot,
      homeDir,
      env: { KANNA_RUST_CACHE: "off" },
      platform: "darwin",
      arch: "arm64",
      runner: fakeInstallRunner({ calls })
    });
    expect(result).toMatchObject({ eligible: false, category: "disabled" });
    expect(calls).toEqual([]);
    expect(existsSync(result.store)).toBe(false);
  });

  it("status reports the pin, the store, and cache stats without writing", async () => {
    const { repoRoot, homeDir } = fixture();
    const paths = resolveKachePaths(homeDir);
    mkdirSync(dirname(paths.binary), { recursive: true });
    writeFileSync(paths.binary, "#!/bin/sh\n");
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const status = await getRustCacheStatus({
      repoRoot,
      homeDir,
      env: { KANNA_RUST_CACHE: "on" },
      platform: "darwin",
      arch: "arm64",
      runner: {
        async run(command, args, options) {
          calls.push({ command, args, env: options?.env });
          return { exitCode: 0, stdout: "Store: 1.0 MiB / 10.0 GiB\n", stderr: "" };
        }
      }
    });
    expect(status).toMatchObject({
      enabled: true,
      version: KACHE_VERSION,
      installed: true,
      binary: paths.binary,
      store: resolveRustCacheStorePath({ repoRoot, homeDir, env: {} }),
      stats: "Store: 1.0 MiB / 10.0 GiB"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["stats"]);
    expect(calls[0]!.env?.KACHE_CACHE_DIR).toBe(status.store);
    expect(calls[0]!.env?.KACHE_MAX_SIZE).toBe(status.maxSize);
    // Reading status must not create the store.
    expect(existsSync(status.store)).toBe(false);
  });

  it("status reports an uninstalled tool without invoking it", async () => {
    const { repoRoot, homeDir } = fixture();
    const calls: string[] = [];
    const status = await getRustCacheStatus({
      repoRoot,
      homeDir,
      env: { KANNA_RUST_CACHE: "off" },
      platform: "darwin",
      arch: "arm64",
      runner: fakeInstallRunner({ calls })
    });
    expect(status).toMatchObject({ enabled: false, category: "disabled", installed: false });
    expect(status.stats).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
