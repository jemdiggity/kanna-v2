import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishConfigSchemaPages } from "../src/runtime/pages";
import { nodeCommandRunner } from "../src/runtime/process";

// Real git, local bare "origin": the fake-runner tests pin the command sequence,
// but only real git proves the orphan commit carries the artifact and nothing else.
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

async function git(args: string[], cwd: string): Promise<string> {
  const result = await nodeCommandRunner.run("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function realRepoPath(repo: string): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"], repo)).trim();
}

async function makeRepoWithRemote(): Promise<{ repo: string; remote: string }> {
  const root = mkdtempSync(join(tmpdir(), "kd-pages-publish-git-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo, { recursive: true });

  await git(["init", "--bare", "--initial-branch", "main", remote], root);
  await git(["init", "--initial-branch", "main"], repo);
  await git(["config", "user.email", "kd@example.com"], repo);
  await git(["config", "user.name", "kd"], repo);
  mkdirSync(join(repo, ".kanna"), { recursive: true });
  writeFileSync(join(repo, ".kanna", "config.schema.json"), '{"type":"object"}\n');
  writeFileSync(join(repo, "README.md"), "repo content that must not be published\n");
  await git(["add", "--all"], repo);
  await git(["commit", "--message", "init"], repo);
  await git(["remote", "add", "origin", remote], repo);
  await git(["push", "origin", "main"], repo);

  return { repo, remote };
}

describe("config schema Pages publication against real git", () => {
  it("pushes an orphan branch holding only the artifact and leaves the caller's worktree alone", async () => {
    const { repo, remote } = await makeRepoWithRemote();
    writeFileSync(join(repo, "local-work.txt"), "uncommitted work unrelated to the schema\n");
    const headBefore = (await git(["rev-parse", "HEAD"], repo)).trim();

    const result = await publishConfigSchemaPages({ repoRoot: repo, runner: nodeCommandRunner, dryRun: false });

    expect(result.pushed).toBe(true);
    expect(result.sourceCommit).toBe(headBefore);

    const published = (await git(["ls-tree", "-r", "--name-only", "gh-pages"], remote))
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(published).toEqual(["CNAME", "config.schema.json"]);
    expect(await git(["show", "gh-pages:CNAME"], remote)).toBe("schemas.kanna.build\n");
    expect(await git(["show", "gh-pages:config.schema.json"], remote)).toBe('{"type":"object"}\n');

    // The caller's worktree, branches, worktree registrations, and stash are untouched.
    expect((await git(["rev-parse", "HEAD"], repo)).trim()).toBe(headBefore);
    expect((await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).trim()).toBe("main");
    expect(await git(["status", "--porcelain"], repo)).toBe("?? local-work.txt\n");
    expect(await git(["branch", "--list"], repo)).toBe("* main\n");
    expect(await git(["stash", "list"], repo)).toBe("");
    const registeredWorktrees = (await git(["worktree", "list", "--porcelain"], repo))
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(registeredWorktrees).toEqual([`worktree ${await realRepoPath(repo)}`]);
  }, 60_000);

  it("replaces the published content instead of stacking history", async () => {
    const { repo, remote } = await makeRepoWithRemote();
    await publishConfigSchemaPages({ repoRoot: repo, runner: nodeCommandRunner, dryRun: false });

    writeFileSync(join(repo, ".kanna", "config.schema.json"), '{"type":"object","title":"v2"}\n');
    await git(["commit", "--all", "--message", "schema v2"], repo);
    await publishConfigSchemaPages({ repoRoot: repo, runner: nodeCommandRunner, dryRun: false });

    expect(await git(["show", "gh-pages:config.schema.json"], remote)).toBe('{"type":"object","title":"v2"}\n');
    const history = (await git(["log", "--oneline", "gh-pages"], remote)).split("\n").filter(Boolean);
    expect(history).toHaveLength(1);
  }, 60_000);

  it("makes no commit and no push on a dry run", async () => {
    const { repo, remote } = await makeRepoWithRemote();

    const result = await publishConfigSchemaPages({ repoRoot: repo, runner: nodeCommandRunner, dryRun: true });

    expect(result.pushed).toBe(false);
    expect(result.files).toEqual(["CNAME", "config.schema.json"]);
    expect(await git(["branch", "--list"], remote)).toBe("* main\n");
    expect(await git(["branch", "--list"], repo)).toBe("* main\n");
    expect(await git(["status", "--porcelain"], repo)).toBe("");
  }, 60_000);

  it("refuses to publish while the schema has uncommitted changes", async () => {
    const { repo, remote } = await makeRepoWithRemote();
    writeFileSync(join(repo, ".kanna", "config.schema.json"), '{"type":"object","title":"unstaged"}\n');

    await expect(
      publishConfigSchemaPages({ repoRoot: repo, runner: nodeCommandRunner, dryRun: false })
    ).rejects.toThrow(/has uncommitted changes/);

    expect(await git(["branch", "--list"], remote)).toBe("* main\n");
  }, 60_000);
});
