import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeCommandRunner, type CommandRunner } from "./process";
import { formatSourceRef, resolveSourceRef } from "./source-ref";

const HEAD_COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

interface GitStub {
  status?: string;
  commits?: Record<string, string>;
}

function gitRunner(stub: GitStub, calls: string[] = []): CommandRunner {
  return {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: stub.status ?? "", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        const ref = args[args.length - 1].replace("^{commit}", "");
        const commits = stub.commits ?? { HEAD: HEAD_COMMIT };
        const commit = commits[ref];
        return commit
          ? { exitCode: 0, stdout: `${commit}\n`, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
}

describe("resolveSourceRef", () => {
  it("requires an explicit ref for production", async () => {
    await expect(
      resolveSourceRef({
        repoRoot: "/repo",
        runner: gitRunner({}),
        requireRef: true,
        command: "cloud deploy"
      })
    ).rejects.toThrow("cloud deploy --production requires --ref <branch|tag|sha>");
  });

  it("reports the current HEAD when no ref is required or given", async () => {
    const calls: string[] = [];
    const source = await resolveSourceRef({
      repoRoot: "/repo",
      runner: gitRunner({}, calls),
      requireRef: false,
      command: "cloud deploy"
    });

    expect(source).toEqual({ ref: "HEAD", commit: HEAD_COMMIT, shortCommit: HEAD_COMMIT.slice(0, 12) });
    expect(calls).toEqual([
      "git status --porcelain",
      "git rev-parse --verify --quiet HEAD^{commit}"
    ]);
    expect(formatSourceRef(source)).toBe(`Source: HEAD (${HEAD_COMMIT.slice(0, 12)})`);
  });

  it("refuses to build from a dirty worktree", async () => {
    await expect(
      resolveSourceRef({
        repoRoot: "/repo",
        runner: gitRunner({ status: " M services/relay/src/index.ts\n" }),
        ref: "release/0.2",
        requireRef: true,
        command: "cloud deploy"
      })
    ).rejects.toThrow("Refusing to run cloud deploy from a dirty git worktree");
  });

  it("resolves the requested ref to a commit", async () => {
    const source = await resolveSourceRef({
      repoRoot: "/repo",
      runner: gitRunner({ commits: { HEAD: HEAD_COMMIT, "release/0.2": HEAD_COMMIT } }),
      ref: "release/0.2",
      requireRef: true,
      command: "cloud deploy"
    });

    expect(source).toEqual({
      ref: "release/0.2",
      commit: HEAD_COMMIT,
      shortCommit: HEAD_COMMIT.slice(0, 12)
    });
  });

  it("refuses a ref that is not the checked-out commit", async () => {
    await expect(
      resolveSourceRef({
        repoRoot: "/repo",
        runner: gitRunner({ commits: { HEAD: HEAD_COMMIT, "release/0.2": OTHER_COMMIT } }),
        ref: "release/0.2",
        requireRef: true,
        command: "cloud deploy"
      })
    ).rejects.toThrow(
      `cloud deploy builds from the working tree, but --ref release/0.2 (${OTHER_COMMIT}) is not checked out; HEAD is ${HEAD_COMMIT}.`
    );
  });

  it("fails when the ref does not resolve", async () => {
    await expect(
      resolveSourceRef({
        repoRoot: "/repo",
        runner: gitRunner({ commits: { HEAD: HEAD_COMMIT } }),
        ref: "release/9.9",
        requireRef: true,
        command: "mobile archive"
      })
    ).rejects.toThrow("Failed to resolve git ref release/9.9 to a commit in /repo.");
  });
});

/**
 * The guards above run against a mocked runner, so this pins them to what the
 * real `git` binary does: `--verify --quiet` exit codes, `^{commit}` peeling,
 * and `status --porcelain` seeing an untracked file.
 */
describe("resolveSourceRef against real git", () => {
  let repoRoot = "";
  let commit = "";

  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "kd-source-ref-"));
    const git = async (...args: string[]): Promise<string> => {
      const result = await nodeCommandRunner.run("git", args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "kd",
          GIT_AUTHOR_EMAIL: "kd@example.com",
          GIT_COMMITTER_NAME: "kd",
          GIT_COMMITTER_EMAIL: "kd@example.com"
        }
      });
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      }
      return result.stdout.trim();
    };

    await git("init", "--initial-branch", "main");
    await writeFile(join(repoRoot, "VERSION"), "0.0.1\n");
    await git("add", "VERSION");
    await git("commit", "-m", "initial");
    await git("tag", "v0.0.1");
    commit = await git("rev-parse", "HEAD");
  }, 30_000);

  afterAll(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  });

  it("resolves a branch, a tag, and HEAD to the same commit", async () => {
    for (const ref of ["main", "v0.0.1"]) {
      await expect(
        resolveSourceRef({ repoRoot, runner: nodeCommandRunner, ref, requireRef: true, command: "cloud deploy" })
      ).resolves.toEqual({ ref, commit, shortCommit: commit.slice(0, 12) });
    }
    await expect(
      resolveSourceRef({ repoRoot, runner: nodeCommandRunner, requireRef: false, command: "cloud deploy" })
    ).resolves.toEqual({ ref: "HEAD", commit, shortCommit: commit.slice(0, 12) });
  }, 20_000);

  it("rejects an unknown ref", async () => {
    await expect(
      resolveSourceRef({
        repoRoot,
        runner: nodeCommandRunner,
        ref: "release/9.9",
        requireRef: true,
        command: "cloud deploy"
      })
    ).rejects.toThrow("Failed to resolve git ref release/9.9 to a commit");
  }, 20_000);

  it("sees an untracked file as a dirty worktree", async () => {
    const stray = join(repoRoot, "stray.txt");
    await writeFile(stray, "not committed\n");
    try {
      await expect(
        resolveSourceRef({
          repoRoot,
          runner: nodeCommandRunner,
          ref: "main",
          requireRef: true,
          command: "cloud deploy"
        })
      ).rejects.toThrow("Refusing to run cloud deploy from a dirty git worktree");
    } finally {
      await rm(stray, { force: true });
    }
  }, 20_000);
});
