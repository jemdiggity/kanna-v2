import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const releaseEnvFsHooks = vi.hoisted(() => ({
  afterRead: vi.fn<(path: unknown, result: unknown) => void>()
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      const readFileSync = actual.readFileSync as (...parameters: unknown[]) => unknown;
      const result = readFileSync(...args);
      releaseEnvFsHooks.afterRead(args[0], result);
      return result;
    }
  };
});

import {
  loadReleaseEnvironment,
  migrateLegacyRepositoryNotarizationSelectors,
  writeMachineNotarizationSelectors
} from "../src/runtime/release-env";
import { nodeCommandRunner, type CommandRunner } from "../src/runtime/process";

const execFileAsync = promisify(execFile);

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

function gitWorktreeListRunner(primaryRoot: string, exitCode = 0): CommandRunner {
  return {
    async run(command, args, options) {
      expect(command).toBe("git");
      expect(args).toEqual(["worktree", "list", "--porcelain"]);
      expect(options?.cwd).toBeDefined();
      return {
        exitCode,
        stdout: exitCode === 0 ? `worktree ${primaryRoot}\nHEAD abc123\nbranch refs/heads/main\n\n` : "",
        stderr: exitCode === 0 ? "" : "not a git repository"
      };
    }
  };
}

describe("release environment", () => {
  afterEach(() => {
    releaseEnvFsHooks.afterRead.mockReset();
  });

  it("loads the global file when the local file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".kanna"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writePrivateFile(
      join(home, ".kanna", ".env.release.local"),
      `APPLE_KEYCHAIN_PROFILE=global-profile\nAPPLE_KEYCHAIN_PATH=${join(root, "login.keychain-db")}\n`
    );

    const env = await loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      env: {},
      runner: gitWorktreeListRunner(repo)
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("global-profile");
    expect(env.APPLE_KEYCHAIN_PATH).toBe(join(root, "login.keychain-db"));
  });

  it("lets repository defaults override non-sensitive machine defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".kanna"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writePrivateFile(
      join(home, ".kanna", ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=global-profile\nRELEASE_DEFAULT=global\nGLOBAL_ONLY=global\n"
    );
    await writeFile(
      join(repo, ".env.release.local"),
      "RELEASE_DEFAULT=local\nLOCAL_ONLY=local\n"
    );

    const env = await loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      env: {},
      runner: gitWorktreeListRunner(repo)
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("global-profile");
    expect(env.RELEASE_DEFAULT).toBe("local");
    expect(env.GLOBAL_ONLY).toBe("global");
    expect(env.LOCAL_ONLY).toBe("local");
  });

  it("loads the primary checkout file for a linked worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const primary = join(root, "repo");
    const worktree = join(primary, ".kanna-worktrees", "task-123");
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(primary, ".env.release.local"),
      "RELEASE_DEFAULT=file\n"
    );

    const env = await loadReleaseEnvironment({
      repoRoot: worktree,
      homeDir: home,
      env: { PATH: "/usr/bin" },
      runner: gitWorktreeListRunner(primary)
    });

    expect(env.RELEASE_DEFAULT).toBe("file");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("lets inherited selector values override machine-local selector defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".kanna"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writePrivateFile(
      join(home, ".kanna", ".env.release.local"),
      `APPLE_KEYCHAIN_PROFILE=global-profile\nAPPLE_KEYCHAIN_PATH=${join(root, "global.keychain-db")}\n`
    );

    const env = await loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      env: {
        APPLE_KEYCHAIN_PROFILE: "shell-profile",
        APPLE_KEYCHAIN_PATH: join(root, "shell.keychain-db")
      },
      runner: gitWorktreeListRunner(repo)
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("shell-profile");
    expect(env.APPLE_KEYCHAIN_PATH).toBe(join(root, "shell.keychain-db"));
  });

  it("rejects notarization selectors in the repository file", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=repo-profile\nAPPLE_KEYCHAIN_PATH=/tmp/repo.keychain-db\n"
    );

    await expect(loadReleaseEnvironment({
      repoRoot: root,
      homeDir: join(root, "home"),
      env: {},
      runner: gitWorktreeListRunner(root)
    })).rejects.toThrow(/machine-local.*cannot be set in repository file/);
  });

  it.each(["APPLE_PASSWORD", "TAURI_PRIVATE_KEY_PASSWORD", "GH_TOKEN"])(
    "rejects plaintext release credential %s from release config",
    async (credentialKey) => {
      const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
      const home = join(root, "home");
      await mkdir(join(home, ".kanna"), { recursive: true });
      await mkdir(join(root, "repo", ".git"), { recursive: true });
      await writePrivateFile(
        join(home, ".kanna", ".env.release.local"),
        `${credentialKey}=must-not-be-printed\n`
      );

      await expect(loadReleaseEnvironment({
        repoRoot: join(root, "repo"),
        homeDir: home,
        env: {},
        runner: gitWorktreeListRunner(join(root, "repo"))
      })).rejects.toThrow(new RegExp(`Plaintext release credentials.*${credentialKey}`));
    }
  );

  it("rejects permissive machine selector config and points to migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".kanna"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    const envPath = join(home, ".kanna", ".env.release.local");
    await writeFile(envPath, "APPLE_KEYCHAIN_PROFILE=profile\n", { mode: 0o644 });
    await chmod(envPath, 0o644);

    await expect(loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      env: {},
      runner: gitWorktreeListRunner(repo)
    })).rejects.toThrow(/owner-only \(0600\).*setup-notarization/);
  });

  it("writes only selectors to machine config and repairs its mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    await mkdir(join(home, ".kanna"), { recursive: true });
    const envPath = join(home, ".kanna", ".env.release.local");
    await writeFile(envPath, "RELEASE_DEFAULT=keep\nAPPLE_KEYCHAIN_PROFILE=old\n", { mode: 0o644 });

    expect(writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "new-profile",
      keychainPath: "/Users/test/Library/Keychains/login.keychain-db"
    })).toBe(envPath);

    expect(await readFile(envPath, "utf8")).toBe(
      'RELEASE_DEFAULT=keep\nAPPLE_KEYCHAIN_PROFILE="new-profile"\nAPPLE_KEYCHAIN_PATH="/Users/test/Library/Keychains/login.keychain-db"\n'
    );
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("strips every compiler-wrapper and cache control, including Cargo's config aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".env.release.local"), "RUSTC_WRAPPER=/from/dotenv\n");

    const env = await loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      // A release invoked from a kd shell inherits the active cache environment,
      // and a hostile caller can add wrappers Cargo honours just as strongly.
      env: {
        PATH: "/usr/bin",
        RUSTC_WRAPPER: "/tools/kache",
        RUSTC_WORKSPACE_WRAPPER: "/bin/false",
        CARGO_BUILD_RUSTC_WRAPPER: "/bin/false",
        CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "/bin/false",
        CARGO_INCREMENTAL: "0",
        KACHE_CACHE_DIR: "/store",
        KACHE_DISABLED: "1",
        APPLE_KEYCHAIN_PROFILE: "kanna"
      },
      runner: gitWorktreeListRunner(repo)
    });

    expect(env).toEqual({ PATH: "/usr/bin", APPLE_KEYCHAIN_PROFILE: "kanna" });
  });

  it("returns an equivalent copy when both files are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const inherited = { PATH: "/usr/bin" };

    const env = await loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      env: inherited,
      runner: gitWorktreeListRunner(repo)
    });

    expect(env).toEqual(inherited);
    expect(env).not.toBe(inherited);
  });

  it("fails with the global file path when global dotenv syntax is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    const globalEnvPath = join(home, ".kanna", ".env.release.local");
    await mkdir(join(home, ".kanna"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(globalEnvPath, "BROKEN LINE\n");

    await expect(
      loadReleaseEnvironment({
        repoRoot: repo,
        homeDir: home,
        env: {},
        runner: gitWorktreeListRunner(repo)
      })
    ).rejects.toThrow(globalEnvPath);
  });

  it("fails with the file path when dotenv syntax is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    const envPath = join(root, ".env.release.local");
    await writeFile(envPath, "BROKEN LINE\n");

    await expect(
      loadReleaseEnvironment({
        repoRoot: root,
        homeDir: join(root, "home"),
        env: {},
        runner: gitWorktreeListRunner(root)
      })
    ).rejects.toThrow(envPath);
  });

  it("fails with the file path when the file cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    const envPath = join(root, ".env.release.local");
    await mkdir(envPath);

    await expect(
      loadReleaseEnvironment({
        repoRoot: root,
        homeDir: join(root, "home"),
        env: {},
        runner: gitWorktreeListRunner(root)
      })
    ).rejects.toThrow(envPath);
  });

  it("fails clearly when Git cannot resolve the primary checkout", async () => {
    await expect(
      loadReleaseEnvironment({
        repoRoot: "/not-a-repo",
        homeDir: "/fake-home",
        env: {},
        runner: gitWorktreeListRunner("", 128)
      })
    ).rejects.toThrow("not a git repository");
  });

  it("accepts Node dotenv comments and multiline quoted values", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".env.release.local"),
      'RELEASE_DEFAULT="value" # local default\nRELEASE_NOTES="line one\nline two"\n'
    );

    const env = await loadReleaseEnvironment({
      repoRoot: root,
      homeDir: join(root, "home"),
      env: {},
      runner: gitWorktreeListRunner(root)
    });

    expect(env.RELEASE_DEFAULT).toBe("value");
    expect(env.RELEASE_NOTES).toBe("line one\nline two");
  });

  it("preserves selector-looking lines inside retained multiline values during migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const envPath = join(root, ".env.release.local");
    await writeFile(
      envPath,
      [
        'RELEASE_NOTES="line one',
        "APPLE_KEYCHAIN_PROFILE=part-of-the-notes",
        "APPLE_KEYCHAIN_PATH=/also-part-of-the-notes",
        'line four"',
        "APPLE_KEYCHAIN_PROFILE=legacy-profile",
        "export APPLE_KEYCHAIN_PATH=/legacy.keychain-db",
        "RELEASE_DEFAULT=preserved",
        ""
      ].join("\n")
    );

    await expect(migrateLegacyRepositoryNotarizationSelectors({
      repoRoot: root,
      env: {},
      runner: gitWorktreeListRunner(root)
    })).resolves.toBe(envPath);

    expect(await readFile(envPath, "utf8")).toBe(
      'RELEASE_NOTES="line one\n' +
      "APPLE_KEYCHAIN_PROFILE=part-of-the-notes\n" +
      "APPLE_KEYCHAIN_PATH=/also-part-of-the-notes\n" +
      'line four"\n' +
      "RELEASE_DEFAULT=preserved\n"
    );
  });

  it("retries migration without losing an unrelated competing edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const envPath = join(root, ".env.release.local");
    await writeFile(
      envPath,
      "RELEASE_DEFAULT=keep\nAPPLE_KEYCHAIN_PROFILE=legacy-profile\n"
    );
    let wroteCompetingEdit = false;
    releaseEnvFsHooks.afterRead.mockImplementation((path, result) => {
      if (path !== envPath || wroteCompetingEdit) {
        return;
      }
      wroteCompetingEdit = true;
      writeFileSync(envPath, `${String(result)}CONCURRENT_EDIT=preserved\n`, "utf8");
    });

    await expect(migrateLegacyRepositoryNotarizationSelectors({
      repoRoot: root,
      env: {},
      runner: gitWorktreeListRunner(root)
    })).resolves.toBe(envPath);

    expect(wroteCompetingEdit).toBe(true);
    expect(await readFile(envPath, "utf8")).toBe(
      "RELEASE_DEFAULT=keep\nCONCURRENT_EDIT=preserved\n"
    );
  });

  it("resolves the primary checkout from a real linked worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-git-"));
    const primary = join(root, "repo");
    const worktree = join(root, "worktree");
    await execFileAsync("git", ["init", "--initial-branch=main", primary]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: primary });
    await execFileAsync("git", ["config", "user.name", "Kanna Test"], { cwd: primary });
    await writeFile(join(primary, "README.md"), "fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: primary });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: primary });
    await execFileAsync("git", ["worktree", "add", "-b", "feature", worktree], { cwd: primary });
    await writeFile(join(primary, ".env.release.local"), "RELEASE_DEFAULT=real-default\n");

    const env = await loadReleaseEnvironment({
      repoRoot: worktree,
      homeDir: join(root, "home"),
      env: {},
      runner: nodeCommandRunner
    });

    expect(env.RELEASE_DEFAULT).toBe("real-default");
  });
});
