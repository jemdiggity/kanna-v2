import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadReleaseEnvironment } from "../src/runtime/release-env";
import type { CommandRunner } from "../src/runtime/process";

function gitCommonDirRunner(commonDir: string, exitCode = 0): CommandRunner {
  return {
    async run(command, args, options) {
      expect(command).toBe("git");
      expect(args).toEqual(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      expect(options?.cwd).toBeDefined();
      return {
        exitCode,
        stdout: exitCode === 0 ? `${commonDir}\n` : "",
        stderr: exitCode === 0 ? "" : "not a git repository"
      };
    }
  };
}

describe("release environment", () => {
  it("loads the primary checkout file for a linked worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const primary = join(root, "repo");
    const worktree = join(primary, ".kanna-worktrees", "task-123");
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(primary, ".env.release.local"),
      'APPLE_KEYCHAIN_PROFILE="kanna-notarization"\nRELEASE_DEFAULT=file\n'
    );

    const env = await loadReleaseEnvironment({
      repoRoot: worktree,
      env: { PATH: "/usr/bin" },
      runner: gitCommonDirRunner(join(primary, ".git"))
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("kanna-notarization");
    expect(env.RELEASE_DEFAULT).toBe("file");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("lets inherited environment values override file defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".env.release.local"), "APPLE_KEYCHAIN_PROFILE=file-profile\n");

    const env = await loadReleaseEnvironment({
      repoRoot: root,
      env: { APPLE_KEYCHAIN_PROFILE: "shell-profile" },
      runner: gitCommonDirRunner(join(root, ".git"))
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("shell-profile");
  });

  it("returns an equivalent copy when the file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    const inherited = { PATH: "/usr/bin" };

    const env = await loadReleaseEnvironment({
      repoRoot: root,
      env: inherited,
      runner: gitCommonDirRunner(join(root, ".git"))
    });

    expect(env).toEqual(inherited);
    expect(env).not.toBe(inherited);
  });

  it("fails with the file path when dotenv syntax is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    const envPath = join(root, ".env.release.local");
    await writeFile(envPath, "BROKEN LINE\n");

    await expect(
      loadReleaseEnvironment({
        repoRoot: root,
        env: {},
        runner: gitCommonDirRunner(join(root, ".git"))
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
        env: {},
        runner: gitCommonDirRunner(join(root, ".git"))
      })
    ).rejects.toThrow(envPath);
  });

  it("fails clearly when Git cannot resolve the primary checkout", async () => {
    await expect(
      loadReleaseEnvironment({
        repoRoot: "/not-a-repo",
        env: {},
        runner: gitCommonDirRunner("", 128)
      })
    ).rejects.toThrow("not a git repository");
  });
});
