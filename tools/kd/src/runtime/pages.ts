import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CommandRunner } from "./process";

export interface BuildConfigSchemaPagesInput {
  repoRoot: string;
  outDir: string;
}

export function buildConfigSchemaPages(input: BuildConfigSchemaPagesInput): string[] {
  mkdirSync(input.outDir, { recursive: true });
  const schemaOut = join(input.outDir, "config.schema.json");
  const cnameOut = join(input.outDir, "CNAME");
  copyFileSync(join(input.repoRoot, ".kanna", "config.schema.json"), schemaOut);
  writeFileSync(cnameOut, "schemas.kanna.build\n");
  return [schemaOut, cnameOut];
}

export const CONFIG_SCHEMA_PAGES_REMOTE = "origin";
export const CONFIG_SCHEMA_PAGES_BRANCH = "gh-pages";
const CONFIG_SCHEMA_RELATIVE_PATH = ".kanna/config.schema.json";

// Artifact-based Pages deploys need GitHub Actions, so publication is branch-based.
// The repository Pages source is a human-only setting; kd cannot change it.
export const CONFIG_SCHEMA_PAGES_SETTING_NOTE = [
  "One-time repository setting (kd cannot apply it):",
  '  GitHub repo Settings → Pages → Source: change "GitHub Actions" to "Deploy from a branch",',
  `  branch \`${CONFIG_SCHEMA_PAGES_BRANCH}\`, folder \`/ (root)\`.`,
  "Until that is changed, publishing has no visible effect."
].join("\n");

export interface PagesCommandStep {
  command: string;
  args: string[];
  cwd: string;
}

export interface PublishConfigSchemaPagesInput {
  repoRoot: string;
  runner: CommandRunner;
  dryRun: boolean;
  remote?: string;
  branch?: string;
}

export interface PublishConfigSchemaPagesResult {
  dryRun: boolean;
  pushed: boolean;
  remote: string;
  branch: string;
  publishBranch: string;
  workDir: string;
  sourceCommit: string;
  commitMessage: string;
  files: string[];
  commands: PagesCommandStep[];
}

interface PublishPlanInput {
  repoRoot: string;
  workDir: string;
  publishBranch: string;
  remote: string;
  branch: string;
  commitMessage: string;
}

// The commit is built in a throwaway worktree on a uniquely named orphan branch so
// the caller's worktree, index, branches, and stash namespace are never touched.
function preparePublishSteps(input: PublishPlanInput): PagesCommandStep[] {
  return [
    {
      command: "git",
      args: ["worktree", "add", "--detach", "--no-checkout", input.workDir, "HEAD"],
      cwd: input.repoRoot
    },
    // The index must be emptied before the orphan checkout: `git checkout --orphan`
    // keeps the index and would materialize HEAD's tracked files into the
    // (deliberately unchecked-out) worktree, publishing the whole repository.
    { command: "git", args: ["read-tree", "--empty"], cwd: input.workDir },
    { command: "git", args: ["checkout", "--orphan", input.publishBranch], cwd: input.workDir }
  ];
}

function commitPublishSteps(input: PublishPlanInput): PagesCommandStep[] {
  return [
    { command: "git", args: ["add", "--all"], cwd: input.workDir },
    { command: "git", args: ["commit", "--message", input.commitMessage], cwd: input.workDir },
    {
      command: "git",
      args: ["push", "--force", input.remote, `HEAD:refs/heads/${input.branch}`],
      cwd: input.workDir
    }
  ];
}

function cleanupPublishSteps(input: PublishPlanInput): PagesCommandStep[] {
  return [
    { command: "git", args: ["worktree", "remove", "--force", input.workDir], cwd: input.repoRoot },
    { command: "git", args: ["branch", "--delete", "--force", input.publishBranch], cwd: input.repoRoot }
  ];
}

export function buildConfigSchemaPublishPlan(input: PublishPlanInput): PagesCommandStep[] {
  return [...preparePublishSteps(input), ...commitPublishSteps(input), ...cleanupPublishSteps(input)];
}

async function runStep(runner: CommandRunner, step: PagesCommandStep): Promise<void> {
  const result = await runner.run(step.command, step.args, { cwd: step.cwd });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${step.command} ${step.args.join(" ")} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`
    );
  }
}

async function runCleanup(runner: CommandRunner, steps: PagesCommandStep[]): Promise<void> {
  for (const step of steps) {
    // Cleanup is best effort: a failed teardown must not mask the publish outcome.
    await runner.run(step.command, step.args, { cwd: step.cwd }).catch(() => undefined);
  }
}

export async function publishConfigSchemaPages(
  input: PublishConfigSchemaPagesInput
): Promise<PublishConfigSchemaPagesResult> {
  const remote = input.remote ?? CONFIG_SCHEMA_PAGES_REMOTE;
  const branch = input.branch ?? CONFIG_SCHEMA_PAGES_BRANCH;

  if (!existsSync(join(input.repoRoot, ".kanna", "config.schema.json"))) {
    throw new Error(`Refusing to publish the config schema: ${CONFIG_SCHEMA_RELATIVE_PATH} does not exist.`);
  }

  // The artifact is copied from the working tree, so an uncommitted schema would
  // publish something that is not in the repository.
  const status = await input.runner.run("git", ["status", "--porcelain", "--", CONFIG_SCHEMA_RELATIVE_PATH], {
    cwd: input.repoRoot
  });
  if (status.exitCode !== 0) {
    throw new Error(status.stderr.trim() || status.stdout.trim() || "Failed to inspect git worktree status.");
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `Refusing to publish the config schema: ${CONFIG_SCHEMA_RELATIVE_PATH} has uncommitted changes. ` +
        "Commit them first so the published schema matches a committed revision."
    );
  }

  const remoteUrl = await input.runner.run("git", ["remote", "get-url", remote], { cwd: input.repoRoot });
  if (remoteUrl.exitCode !== 0) {
    throw new Error(`Refusing to publish the config schema: git remote "${remote}" is not configured.`);
  }

  const head = await input.runner.run("git", ["rev-parse", "HEAD"], { cwd: input.repoRoot });
  if (head.exitCode !== 0) {
    throw new Error(head.stderr.trim() || head.stdout.trim() || "Failed to resolve HEAD.");
  }
  const sourceCommit = head.stdout.trim();
  const commitMessage = `Publish ${CONFIG_SCHEMA_RELATIVE_PATH} from ${sourceCommit}`;

  const workDir = mkdtempSync(join(tmpdir(), "kd-pages-publish-"));
  const publishBranch = basename(workDir);
  const plan: PublishPlanInput = {
    repoRoot: input.repoRoot,
    workDir,
    publishBranch,
    remote,
    branch,
    commitMessage
  };
  const commands = buildConfigSchemaPublishPlan(plan);

  const result: PublishConfigSchemaPagesResult = {
    dryRun: input.dryRun,
    pushed: false,
    remote,
    branch,
    publishBranch,
    workDir,
    sourceCommit,
    commitMessage,
    files: [],
    commands
  };

  try {
    if (!input.dryRun) {
      for (const step of preparePublishSteps(plan)) {
        await runStep(input.runner, step);
      }
    }

    result.files = buildConfigSchemaPages({ repoRoot: input.repoRoot, outDir: workDir })
      .map((path) => basename(path))
      .sort();

    if (input.dryRun) {
      return result;
    }

    for (const step of commitPublishSteps(plan)) {
      await runStep(input.runner, step);
    }
    result.pushed = true;
    return result;
  } finally {
    if (!input.dryRun) {
      await runCleanup(input.runner, cleanupPublishSteps(plan));
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function formatPublishConfigSchemaPagesResult(result: PublishConfigSchemaPagesResult): string {
  const header = result.dryRun
    ? `Dry run: would publish ${result.files.length} file(s) to ${result.remote} ${result.branch} from ${result.sourceCommit}`
    : `Published ${result.files.length} file(s) to ${result.remote} ${result.branch} from ${result.sourceCommit}`;
  const files = result.files.map((file) => `  ${file}`);
  const commitLine = `Commit message: ${result.commitMessage}`;
  const commands = result.dryRun
    ? [
        "Would run:",
        ...result.commands.map((step) => `  ${step.command} ${step.args.join(" ")} (cwd: ${step.cwd})`),
        `Nothing was pushed to ${result.remote}.`
      ]
    : [];
  return [header, ...files, commitLine, ...commands, "", CONFIG_SCHEMA_PAGES_SETTING_NOTE].join("\n");
}
