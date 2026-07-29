import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMA_PAGES_SETTING_NOTE,
  formatPublishConfigSchemaPagesResult,
  publishConfigSchemaPages
} from "../src/runtime/pages";
import type { CommandResult, CommandRunner } from "../src/runtime/process";

interface RecordedCall {
  command: string;
  args: string[];
  cwd?: string;
}

function fakeRunner(
  calls: RecordedCall[],
  overrides: (command: string, args: string[]) => CommandResult | undefined = () => undefined
): CommandRunner {
  return {
    async run(command, args, options) {
      calls.push({ command, args, cwd: options?.cwd });
      return overrides(command, args) ?? { exitCode: 0, stdout: "", stderr: "" };
    }
  };
}

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "kd-pages-publish-repo-"));
  mkdirSync(join(repoRoot, ".kanna"), { recursive: true });
  writeFileSync(join(repoRoot, ".kanna", "config.schema.json"), '{"type":"object"}\n');
  return repoRoot;
}

const HEAD_SHA = "1111111111111111111111111111111111111111";

function headOverride(command: string, args: string[]): CommandResult | undefined {
  if (command === "git" && args.join(" ") === "rev-parse HEAD") {
    return { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" };
  }
  return undefined;
}

describe("config schema Pages publication", () => {
  it("commits the built artifact on an orphan branch in a throwaway worktree and force-pushes it", async () => {
    const repoRoot = await makeRepo();
    const calls: RecordedCall[] = [];

    try {
      const result = await publishConfigSchemaPages({
        repoRoot,
        runner: fakeRunner(calls, headOverride),
        dryRun: false
      });

      expect(result.pushed).toBe(true);
      expect(result.branch).toBe("gh-pages");
      expect(result.remote).toBe("origin");
      expect(result.sourceCommit).toBe(HEAD_SHA);
      expect(result.files).toEqual(["CNAME", "config.schema.json"]);
      expect(result.commitMessage).toBe(`Publish .kanna/config.schema.json from ${HEAD_SHA}`);

      const { workDir, publishBranch } = result;
      expect(publishBranch).not.toBe("gh-pages");
      expect(calls).toEqual([
        { command: "git", args: ["status", "--porcelain", "--", ".kanna/config.schema.json"], cwd: repoRoot },
        { command: "git", args: ["remote", "get-url", "origin"], cwd: repoRoot },
        { command: "git", args: ["rev-parse", "HEAD"], cwd: repoRoot },
        {
          command: "git",
          args: ["worktree", "add", "--detach", "--no-checkout", workDir, "HEAD"],
          cwd: repoRoot
        },
        { command: "git", args: ["read-tree", "--empty"], cwd: workDir },
        { command: "git", args: ["checkout", "--orphan", publishBranch], cwd: workDir },
        { command: "git", args: ["add", "--all"], cwd: workDir },
        { command: "git", args: ["commit", "--message", result.commitMessage], cwd: workDir },
        { command: "git", args: ["push", "--force", "origin", "HEAD:refs/heads/gh-pages"], cwd: workDir },
        { command: "git", args: ["worktree", "remove", "--force", workDir], cwd: repoRoot },
        { command: "git", args: ["branch", "--delete", "--force", publishBranch], cwd: repoRoot }
      ]);
      // Nothing is ever checked out over, stashed in, or committed to the caller's worktree.
      expect(calls.filter((call) => call.cwd === repoRoot).map((call) => call.args[0])).toEqual([
        "status",
        "remote",
        "rev-parse",
        "worktree",
        "worktree",
        "branch"
      ]);
      expect(existsSync(workDir)).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("builds and reports the plan without pushing on a dry run", async () => {
    const repoRoot = await makeRepo();
    const calls: RecordedCall[] = [];

    try {
      const result = await publishConfigSchemaPages({
        repoRoot,
        runner: fakeRunner(calls, headOverride),
        dryRun: true
      });

      expect(result.dryRun).toBe(true);
      expect(result.pushed).toBe(false);
      expect(result.files).toEqual(["CNAME", "config.schema.json"]);
      expect(calls).toEqual([
        { command: "git", args: ["status", "--porcelain", "--", ".kanna/config.schema.json"], cwd: repoRoot },
        { command: "git", args: ["remote", "get-url", "origin"], cwd: repoRoot },
        { command: "git", args: ["rev-parse", "HEAD"], cwd: repoRoot }
      ]);
      expect(result.commands.map((step) => step.args.join(" "))).toContain(
        "push --force origin HEAD:refs/heads/gh-pages"
      );
      expect(existsSync(result.workDir)).toBe(false);

      const message = formatPublishConfigSchemaPagesResult(result);
      expect(message).toContain("Dry run: would publish 2 file(s) to origin gh-pages");
      expect(message).toContain("Nothing was pushed to origin.");
      expect(message).toContain(CONFIG_SCHEMA_PAGES_SETTING_NOTE);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports the one-time Pages source setting after a real publish", async () => {
    const repoRoot = await makeRepo();

    try {
      const result = await publishConfigSchemaPages({
        repoRoot,
        runner: fakeRunner([], headOverride),
        dryRun: false
      });

      const message = formatPublishConfigSchemaPagesResult(result);
      expect(message).toContain("Published 2 file(s) to origin gh-pages");
      expect(message).toContain("GitHub repo Settings → Pages → Source");
      expect(message).toContain('change "GitHub Actions" to "Deploy from a branch"');
      expect(message).toContain("branch `gh-pages`, folder `/ (root)`");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses to publish an uncommitted schema", async () => {
    const repoRoot = await makeRepo();
    const calls: RecordedCall[] = [];
    const runner = fakeRunner(calls, (command, args) => {
      if (command === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: " M .kanna/config.schema.json\n", stderr: "" };
      }
      return headOverride(command, args);
    });

    try {
      await expect(publishConfigSchemaPages({ repoRoot, runner, dryRun: true })).rejects.toThrow(
        /has uncommitted changes/
      );
      expect(calls).toEqual([
        { command: "git", args: ["status", "--porcelain", "--", ".kanna/config.schema.json"], cwd: repoRoot }
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses to publish when the remote is missing", async () => {
    const repoRoot = await makeRepo();
    const runner = fakeRunner([], (command, args) => {
      if (command === "git" && args[0] === "remote") {
        return { exitCode: 2, stdout: "", stderr: "error: No such remote 'origin'\n" };
      }
      return headOverride(command, args);
    });

    try {
      await expect(publishConfigSchemaPages({ repoRoot, runner, dryRun: false })).rejects.toThrow(
        /git remote "origin" is not configured/
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses to publish when the schema file is absent", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kd-pages-publish-empty-"));
    const calls: RecordedCall[] = [];

    try {
      await expect(
        publishConfigSchemaPages({ repoRoot, runner: fakeRunner(calls, headOverride), dryRun: true })
      ).rejects.toThrow(/\.kanna\/config\.schema\.json does not exist/);
      expect(calls).toEqual([]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("cleans up the throwaway worktree and branch when the push fails", async () => {
    const repoRoot = await makeRepo();
    const calls: RecordedCall[] = [];
    const runner = fakeRunner(calls, (command, args) => {
      if (command === "git" && args[0] === "push") {
        return { exitCode: 1, stdout: "", stderr: "fatal: unable to access origin\n" };
      }
      return headOverride(command, args);
    });

    try {
      await expect(publishConfigSchemaPages({ repoRoot, runner, dryRun: false })).rejects.toThrow(
        /unable to access origin/
      );
      const teardown = calls.slice(-2).map((call) => call.args.slice(0, 2).join(" "));
      expect(teardown).toEqual(["worktree remove", "branch --delete"]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
