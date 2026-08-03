import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
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
export interface LoadReleaseEnvironmentInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
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

export function loadReleaseEnvironment(
  input: LoadReleaseEnvironmentInput
): NodeJS.ProcessEnv {
  const globalEnvPath = join(input.homeDir, ".kanna", RELEASE_ENV_FILE);
  const globalEnv = loadDotenvFile(globalEnvPath);
  const inherited = definedEnvironment(input.env);
  // Release, signing, and packaging must be reproducible with no compiler cache
  // present, so no Kanna-managed or ambient wrapper reaches Bazel or Cargo here.
  return stripRustCacheEnvironment({ ...globalEnv, ...inherited });
}

function loadDotenvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) {
    return {};
  }

  try {
    const source = readFileSync(envPath, "utf8");
    validateDotenv(source, envPath);
    const parsed = definedEnvironment(parseEnv(source));
    validateReleaseEnvironmentFile(parsed, envPath);
    const permissions = statSync(envPath).mode & 0o777;
    if ((permissions & 0o077) !== 0) {
      throw new Error(
        `Machine-local release environment must be owner-only (0600), but ${envPath} is mode ${permissions.toString(8).padStart(4, "0")}. Run chmod 600 ${envPath} before retrying.`
      );
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load release environment ${envPath}: ${message}`);
  }
}

function validateReleaseEnvironmentFile(
  parsed: Record<string, string>,
  envPath: string
): void {
  const unsafeKeys = Object.keys(parsed).filter((key) =>
    UNSAFE_PLAINTEXT_RELEASE_KEYS.has(key)
  );
  if (unsafeKeys.length > 0) {
    throw new Error(
      `Plaintext release credentials are not allowed in ${envPath}: ${unsafeKeys.join(", ")}. Store notarization credentials with ./kd release setup-notarization and keep other secrets in their supported secure stores.`
    );
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
  validateReleaseEnvironmentFile(parsed, envPath);
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

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
