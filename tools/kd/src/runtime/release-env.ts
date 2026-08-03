import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { CommandRunner } from "./process";
import { stripRustCacheEnvironment } from "./rust-cache-policy";

export const RELEASE_ENV_FILE = ".env.release.local";
export const NOTARIZATION_PROFILE_ENV = "APPLE_KEYCHAIN_PROFILE";
export const NOTARIZATION_KEYCHAIN_ENV = "APPLE_KEYCHAIN_PATH";

const NOTARIZATION_SELECTOR_KEYS = new Set([
  NOTARIZATION_PROFILE_ENV,
  NOTARIZATION_KEYCHAIN_ENV
]);
const UNSAFE_PLAINTEXT_RELEASE_KEYS = new Set([
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_PRIVATE_KEY",
  "TAURI_PRIVATE_KEY_PASSWORD",
  "KANNA_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN"
]);
const MIGRATION_REPLACE_ATTEMPTS = 3;

export interface LoadReleaseEnvironmentInput {
  repoRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

interface ResolvePrimaryRepoRootInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

type DotenvQuote = "'" | '"' | "`";

function validateDotenv(source: string, envPath: string): void {
  let pendingQuote: DotenvQuote | undefined;
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
    if (quote !== '"' && quote !== "'" && quote !== "`") {
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

function findClosingQuote(value: string, quote: DotenvQuote, start: number): number {
  // Node's parseEnv treats the first matching delimiter as the boundary even
  // when it is preceded by a backslash; dotenv quoting does not use JS escapes.
  return value.indexOf(quote, start);
}

function assertOnlyCommentFollows(value: string, envPath: string, line: number): void {
  const trailing = value.trim();
  if (trailing && !trailing.startsWith("#")) {
    throw new Error(`Unexpected content after quoted value at ${envPath}:${line}`);
  }
}

async function resolvePrimaryRepoRoot(input: ResolvePrimaryRepoRootInput): Promise<string> {
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
  const globalEnvPath = join(input.homeDir, ".kanna", RELEASE_ENV_FILE);
  const localEnvPath = join(primaryRoot, RELEASE_ENV_FILE);
  const globalEnv = loadDotenvFile(globalEnvPath, "machine");
  const localEnv = loadDotenvFile(localEnvPath, "repository");
  const inherited = definedEnvironment(input.env);
  // Release, signing, and packaging must be reproducible with no compiler cache
  // present, so no Kanna-managed or ambient wrapper reaches Bazel or Cargo here.
  return stripRustCacheEnvironment({ ...globalEnv, ...localEnv, ...inherited });
}

type ReleaseEnvironmentScope = "machine" | "repository";

function loadDotenvFile(
  envPath: string,
  scope: ReleaseEnvironmentScope
): Record<string, string> {
  if (!existsSync(envPath)) {
    return {};
  }

  try {
    const source = readFileSync(envPath, "utf8");
    validateDotenv(source, envPath);
    const parsed = definedEnvironment(parseEnv(source));
    validateReleaseEnvironmentFile(parsed, envPath, scope);
    if (
      scope === "machine" &&
      [...NOTARIZATION_SELECTOR_KEYS].some((key) => parsed[key] !== undefined)
    ) {
      const permissions = statSync(envPath).mode & 0o777;
      if ((permissions & 0o077) !== 0) {
        throw new Error(
          `Notarization selector config must be owner-only (0600), but ${envPath} is mode ${permissions.toString(8).padStart(4, "0")}. Run ./kd release setup-notarization to migrate it safely.`
        );
      }
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load release environment ${envPath}: ${message}`);
  }
}

function validateReleaseEnvironmentFile(
  parsed: Record<string, string>,
  envPath: string,
  scope: ReleaseEnvironmentScope
): void {
  const unsafeKeys = Object.keys(parsed).filter((key) =>
    UNSAFE_PLAINTEXT_RELEASE_KEYS.has(key)
  );
  if (unsafeKeys.length > 0) {
    throw new Error(
      `Plaintext release credentials are not allowed in ${envPath}: ${unsafeKeys.join(", ")}. Store notarization credentials with ./kd release setup-notarization and keep other secrets in their supported secure stores.`
    );
  }

  if (scope === "repository") {
    const selectors = Object.keys(parsed).filter((key) =>
      NOTARIZATION_SELECTOR_KEYS.has(key)
    );
    if (selectors.length > 0) {
      throw new Error(
        `Notarization selectors are machine-local and cannot be set in repository file ${envPath}: ${selectors.join(", ")}. Move them to ~/.kanna/${RELEASE_ENV_FILE}.`
      );
    }
  }
}

export function writeMachineNotarizationSelectors(input: {
  homeDir: string;
  profile: string;
  keychainPath: string;
}): string {
  const kannaDir = join(input.homeDir, ".kanna");
  const envPath = join(kannaDir, RELEASE_ENV_FILE);
  mkdirSync(kannaDir, { recursive: true, mode: 0o700 });
  chmodSync(kannaDir, 0o700);

  const source = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  validateDotenv(source, envPath);
  const parsed = definedEnvironment(parseEnv(source));
  validateReleaseEnvironmentFile(parsed, envPath, "machine");
  for (const key of NOTARIZATION_SELECTOR_KEYS) {
    if (parsed[key]?.includes("\n") || parsed[key]?.includes("\r")) {
      throw new Error(`Invalid multiline notarization selector ${key} in ${envPath}.`);
    }
  }

  const retainedLines = source
    .split(/\r?\n/)
    .filter((line) => {
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !assignment?.[1] || !NOTARIZATION_SELECTOR_KEYS.has(assignment[1]);
    });
  while (retainedLines.at(-1) === "") retainedLines.pop();
  const updated = [
    ...retainedLines,
    `${NOTARIZATION_PROFILE_ENV}=${JSON.stringify(input.profile)}`,
    `${NOTARIZATION_KEYCHAIN_ENV}=${JSON.stringify(input.keychainPath)}`,
    ""
  ].join("\n");
  const tempPath = `${envPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, updated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, envPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  chmodSync(envPath, 0o600);
  return envPath;
}

export async function migrateLegacyRepositoryNotarizationSelectors(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}): Promise<string | undefined> {
  const primaryRoot = await resolvePrimaryRepoRoot(input);
  const envPath = join(primaryRoot, RELEASE_ENV_FILE);

  for (let attempt = 0; attempt < MIGRATION_REPLACE_ATTEMPTS; attempt += 1) {
    if (!existsSync(envPath)) {
      return undefined;
    }

    try {
      const initialStat = statSync(envPath, { bigint: true });
      const source = readFileSync(envPath, "utf8");
      if (!sameFileIdentity(initialStat, statSync(envPath, { bigint: true }))) {
        continue;
      }

      validateDotenv(source, envPath);
      const parsed = definedEnvironment(parseEnv(source));
      if (![...NOTARIZATION_SELECTOR_KEYS].some((key) => parsed[key] !== undefined)) {
        return undefined;
      }

      const updated = removeDotenvAssignments(source, NOTARIZATION_SELECTOR_KEYS);
      const permissions = Number(initialStat.mode & 0o777n);
      const tempPath = `${envPath}.tmp-${process.pid}-${attempt}`;
      const claimedPath = `${envPath}.migrating-${process.pid}-${attempt}-${randomUUID()}`;
      try {
        writeFileSync(tempPath, updated, { encoding: "utf8", mode: permissions, flag: "wx" });
        chmodSync(tempPath, permissions);

        const currentStat = statSync(envPath, { bigint: true });
        const currentSource = readFileSync(envPath, "utf8");
        if (
          currentSource !== source ||
          !sameFileIdentity(initialStat, currentStat) ||
          !sameFileIdentity(currentStat, statSync(envPath, { bigint: true }))
        ) {
          continue;
        }

        // Claim the path before publishing the replacement. This closes the
        // check-to-rename window: a replacement that races the claim is moved
        // aside and checked, while a writer that recreates envPath prevents the
        // hard-link publish from overwriting it.
        renameSync(envPath, claimedPath);
        let claimedFilePresent = true;
        try {
          const claimedStat = statSync(claimedPath, { bigint: true });
          const claimedSource = readFileSync(claimedPath, "utf8");
          if (
            claimedSource !== source ||
            !sameFileIdentityAfterRename(initialStat, claimedStat) ||
            !sameFileIdentity(claimedStat, statSync(claimedPath, { bigint: true }))
          ) {
            if (!restoreClaimedFile(claimedPath, envPath)) {
              throw migrationConflictError(envPath, claimedPath);
            }
            claimedFilePresent = false;
            continue;
          }

          try {
            linkSync(tempPath, envPath);
          } catch (error) {
            if (!isFileSystemError(error, "EEXIST")) {
              throw error;
            }
            // A writer recreated the path after it was claimed. Its version is
            // authoritative for the retry and must not be overwritten.
            rmSync(claimedPath);
            claimedFilePresent = false;
            continue;
          }
          rmSync(claimedPath);
          claimedFilePresent = false;
          return envPath;
        } catch (error) {
          if (claimedFilePresent) {
            try {
              if (!restoreClaimedFile(claimedPath, envPath)) {
                throw migrationConflictError(envPath, claimedPath);
              }
              claimedFilePresent = false;
            } catch {
              throw migrationConflictError(envPath, claimedPath);
            }
          }
          throw error;
        }
      } finally {
        rmSync(tempPath, { force: true });
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Release environment ${envPath} changed while notarization selectors were being migrated; no migration changes were written. Retry ./kd release setup-notarization.`
  );
}

function removeDotenvAssignments(source: string, keys: ReadonlySet<string>): string {
  const retainedLines: string[] = [];
  let multilineQuote: DotenvQuote | undefined;
  let retainMultiline = false;

  for (const line of source.split(/\r?\n/)) {
    if (multilineQuote) {
      if (retainMultiline) {
        retainedLines.push(line);
      }
      if (findClosingQuote(line, multilineQuote, 0) >= 0) {
        multilineQuote = undefined;
        retainMultiline = false;
      }
      continue;
    }

    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const removeAssignment = assignment?.[1] !== undefined && keys.has(assignment[1]);
    if (!removeAssignment) {
      retainedLines.push(line);
    }

    const value = assignment?.[2]?.trimStart() ?? "";
    const quote = value[0];
    if (
      (quote === '"' || quote === "'" || quote === "`") &&
      findClosingQuote(value, quote, 1) < 0
    ) {
      multilineQuote = quote;
      retainMultiline = !removeAssignment;
    }
  }

  return retainedLines.join("\n");
}

function restoreClaimedFile(claimedPath: string, envPath: string): boolean {
  try {
    linkSync(claimedPath, envPath);
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
  rmSync(claimedPath);
  return true;
}

function migrationConflictError(envPath: string, claimedPath: string): Error {
  return new Error(
    `Release environment ${envPath} changed repeatedly while notarization selectors were being migrated. The competing version was preserved at ${claimedPath}; reconcile it before retrying ./kd release setup-notarization.`
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function sameFileIdentityAfterRename(left: BigIntStats, right: BigIntStats): boolean {
  // rename(2) may update ctime. The subsequent sameFileIdentity check includes
  // ctime once the file is at its claimed path and must remain stable there.
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

function isMissingFileError(error: unknown): boolean {
  return isFileSystemError(error, "ENOENT");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
