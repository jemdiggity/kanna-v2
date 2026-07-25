import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { CommandRunner } from "./process";

export const RELEASE_ENV_FILE = ".env.release.local";

export interface LoadReleaseEnvironmentInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

function validateDotenv(source: string, envPath: string): void {
  let pendingQuote: "'" | '"' | undefined;
  let pendingLine = 0;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (pendingQuote) {
      const closingIndex = findClosingQuote(line, pendingQuote, 0);
      if (closingIndex < 0) {
        continue;
      }
      assertOnlyCommentFollows(line.slice(closingIndex + 1), envPath, index + 1);
      pendingQuote = undefined;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(trimmed);
    if (!assignment) {
      throw new Error(`Invalid dotenv assignment at ${envPath}:${index + 1}`);
    }
    const value = (assignment[1] ?? "").trimStart();
    const quote = value[0];
    if (quote !== '"' && quote !== "'") {
      continue;
    }
    const closingIndex = findClosingQuote(value, quote, 1);
    if (closingIndex < 0) {
      pendingQuote = quote;
      pendingLine = index + 1;
      continue;
    }
    assertOnlyCommentFollows(value.slice(closingIndex + 1), envPath, index + 1);
  }

  if (pendingQuote) {
    throw new Error(`Unterminated quoted value at ${envPath}:${pendingLine}`);
  }
}

function findClosingQuote(value: string, quote: "'" | '"', start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] !== quote) {
      continue;
    }
    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 0) {
      return index;
    }
  }
  return -1;
}

function assertOnlyCommentFollows(value: string, envPath: string, line: number): void {
  const trailing = value.trim();
  if (trailing && !trailing.startsWith("#")) {
    throw new Error(`Unexpected content after quoted value at ${envPath}:${line}`);
  }
}

async function resolvePrimaryRepoRoot(input: LoadReleaseEnvironmentInput): Promise<string> {
  const result = await input.runner.run(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: input.repoRoot, env: input.env }
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to list Git worktrees.");
  }
  const primaryRoot = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim();
  if (!primaryRoot) {
    throw new Error("Git returned no primary worktree.");
  }
  return primaryRoot;
}

export async function loadReleaseEnvironment(
  input: LoadReleaseEnvironmentInput
): Promise<NodeJS.ProcessEnv> {
  const primaryRoot = await resolvePrimaryRepoRoot(input);
  const envPath = join(primaryRoot, RELEASE_ENV_FILE);
  if (!existsSync(envPath)) {
    return { ...input.env };
  }

  try {
    const source = readFileSync(envPath, "utf8");
    validateDotenv(source, envPath);
    const fileEnv = parseEnv(source);
    const inherited = Object.fromEntries(
      Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    return { ...fileEnv, ...inherited };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load release environment ${envPath}: ${message}`);
  }
}
