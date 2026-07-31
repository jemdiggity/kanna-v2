import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadReleaseEnvironment } from "../src/runtime/release-env";
import { nodeCommandRunner, type CommandRunner } from "../src/runtime/process";

const execFileAsync = promisify(execFile);

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
  it("loads the global file when the local file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".kanna"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(
      join(home, ".kanna", ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=global-profile\n"
    );

    const env = await loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      env: {},
      runner: gitWorktreeListRunner(repo)
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("global-profile");
  });

  it("lets the local file override the global file", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".kanna"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(
      join(home, ".kanna", ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=global-profile\nGLOBAL_ONLY=global\n"
    );
    await writeFile(
      join(repo, ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=local-profile\nLOCAL_ONLY=local\n"
    );

    const env = await loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      env: {},
      runner: gitWorktreeListRunner(repo)
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("local-profile");
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
      'APPLE_KEYCHAIN_PROFILE="kanna-notarization"\nRELEASE_DEFAULT=file\n'
    );

    const env = await loadReleaseEnvironment({
      repoRoot: worktree,
      homeDir: home,
      env: { PATH: "/usr/bin" },
      runner: gitWorktreeListRunner(primary)
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("kanna-notarization");
    expect(env.RELEASE_DEFAULT).toBe("file");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("lets inherited environment values override both file defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".kanna"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(
      join(home, ".kanna", ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=global-profile\n"
    );
    await writeFile(
      join(repo, ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=local-profile\n"
    );

    const env = await loadReleaseEnvironment({
      repoRoot: repo,
      homeDir: home,
      env: { APPLE_KEYCHAIN_PROFILE: "shell-profile" },
      runner: gitWorktreeListRunner(repo)
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("shell-profile");
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
      'APPLE_KEYCHAIN_PROFILE="profile" # local profile\nRELEASE_NOTES="line one\nline two"\n'
    );

    const env = await loadReleaseEnvironment({
      repoRoot: root,
      homeDir: join(root, "home"),
      env: {},
      runner: gitWorktreeListRunner(root)
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("profile");
    expect(env.RELEASE_NOTES).toBe("line one\nline two");
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
    await writeFile(join(primary, ".env.release.local"), "APPLE_KEYCHAIN_PROFILE=real-profile\n");

    const env = await loadReleaseEnvironment({
      repoRoot: worktree,
      homeDir: join(root, "home"),
      env: {},
      runner: nodeCommandRunner
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("real-profile");
  });
});
