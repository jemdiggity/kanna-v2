import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";

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
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "KANNA_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN"
]);
const COMPILER_CACHE_ENVIRONMENT_KEYS = new Set([
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
  "CARGO_INCREMENTAL"
]);
export interface LoadReleaseEnvironmentInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** @internal Test-only synchronization for deterministic filesystem races. */
  testSynchronization?: ReleaseEnvironmentTestSynchronization;
}

interface DirectoryIdentity {
  dev: string;
  ino: string;
}

interface DirectoryAncestryEntry extends DirectoryIdentity {
  name: string;
  canonicalPath: string;
}

interface ReleaseEnvironmentTestSynchronization {
  event: "after-release-file-read" | "after-temp-created" | "before-release-file-rename";
  readyPath: string;
  continuePath: string;
}

interface PinnedWorkerResponse {
  ok: boolean;
  error?: string;
  missing?: boolean;
  source?: string;
  directory?: DirectoryIdentity;
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
  const globalEnv = loadDotenvFile(
    input.homeDir,
    globalEnvPath,
    input.testSynchronization
  );
  const inherited = definedEnvironment(input.env);
  // Release, signing, and packaging must be reproducible with no compiler cache
  // present, so no Kanna-managed or ambient wrapper reaches Bazel or Cargo here.
  return stripCompilerCacheEnvironment({ ...globalEnv, ...inherited });
}

function stripCompilerCacheEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith("KACHE_") && !COMPILER_CACHE_ENVIRONMENT_KEYS.has(key)
    )
  );
}

function loadDotenvFile(
  homeDir: string,
  envPath: string,
  testSynchronization?: ReleaseEnvironmentTestSynchronization
): Record<string, string> {
  try {
    const ancestry = machineConfigAncestry(
      homeDir,
      false,
      testSynchronization
    );
    if (ancestry === undefined) {
      return {};
    }
    const response = runPinnedDirectoryWorker(join(homeDir, ".kanna"), {
      operation: "read",
      ancestry,
      fileName: RELEASE_ENV_FILE,
      requireOwnerOnly: true,
      testSynchronization
    });
    if (response.missing) {
      return {};
    }
    if (response.source === undefined) {
      throw new Error("Pinned release-environment read returned no content.");
    }
    validateDotenv(response.source, envPath);
    const parsed = definedEnvironment(parseEnv(response.source));
    validateReleaseEnvironmentFile(parsed, envPath);
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
      `Plaintext release credentials are not allowed in ${envPath}: ${unsafeKeys.join(", ")}. Store notarization credentials with ./kd release setup-notarization, keep updater signing material in the owner-only file selected by TAURI_PRIVATE_KEY_PATH, and keep other secrets in their supported secure stores.`
    );
  }
}

/**
 * Replace one family of machine-local selectors in ~/.kanna/.env.release.local,
 * leaving every other line untouched. Only non-secret selectors belong here;
 * the secrets they point at stay in the Keychain.
 */
function writeMachineSelectors(input: {
  homeDir: string;
  selectorKeys: Set<string>;
  selectorLabel: string;
  assignments: [string, string][];
  /** @internal Test-only synchronization for deterministic filesystem races. */
  testSynchronization?: ReleaseEnvironmentTestSynchronization;
}): string {
  const kannaDir = join(input.homeDir, ".kanna");
  const envPath = join(kannaDir, RELEASE_ENV_FILE);
  const ancestry = machineConfigAncestry(
    input.homeDir,
    true,
    input.testSynchronization
  );
  if (ancestry === undefined) {
    throw new Error(`Unable to create machine-local release directory ${kannaDir}.`);
  }
  // Repair and pin the persistent writer lock before parsing existing config,
  // so even a validation failure leaves the shared writer invariant healthy.
  preparePinnedDirectoryLock(
    kannaDir,
    ancestry,
    ".release-environment-write.lockf",
    true
  );

  const readResponse = runPinnedDirectoryWorker(kannaDir, {
    operation: "read",
    ancestry,
    fileName: RELEASE_ENV_FILE,
    requireOwnerOnly: false,
    repairDirectoryMode: true,
    testSynchronization: input.testSynchronization
  });
  const source = readResponse.source ?? "";
  validateDotenv(source, envPath);
  const parsed = definedEnvironment(parseEnv(source));
  validateReleaseEnvironmentFile(parsed, envPath);
  for (const key of input.selectorKeys) {
    if (parsed[key]?.includes("\n") || parsed[key]?.includes("\r")) {
      throw new Error(`Invalid multiline ${input.selectorLabel} selector ${key} in ${envPath}.`);
    }
  }

  const retainedLines = source
    .split(/\r?\n/)
    .filter((line) => {
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !assignment?.[1] || !input.selectorKeys.has(assignment[1]);
    });
  while (retainedLines.at(-1) === "") retainedLines.pop();
  const updated = [
    ...retainedLines,
    ...input.assignments.map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    ""
  ].join("\n");

  runPinnedDirectoryWorker(kannaDir, {
    operation: "write",
    ancestry,
    fileName: RELEASE_ENV_FILE,
    expectedSource: readResponse.missing ? undefined : source,
    source: updated,
    repairDirectoryMode: true,
    testSynchronization: input.testSynchronization
  });
  return envPath;
}

export function writeMachineNotarizationSelectors(input: {
  homeDir: string;
  profile: string;
  keychainPath: string;
  /** @internal Test-only synchronization for deterministic filesystem races. */
  testSynchronization?: ReleaseEnvironmentTestSynchronization;
}): string {
  return writeMachineSelectors({
    homeDir: input.homeDir,
    selectorKeys: NOTARIZATION_SELECTOR_KEYS,
    selectorLabel: "notarization",
    assignments: [
      [NOTARIZATION_PROFILE_ENV, input.profile],
      [NOTARIZATION_KEYCHAIN_ENV, input.keychainPath]
    ],
    testSynchronization: input.testSynchronization
  });
}

function preparePinnedDirectoryLock(
  cwd: string,
  ancestry: DirectoryAncestryEntry[],
  lockName: string,
  repairDirectoryMode: boolean
): void {
  runPinnedDirectoryWorker(cwd, {
    operation: "ensure-lock-file",
    ancestry,
    fileName: lockName,
    repairDirectoryMode
  });
}

function machineConfigAncestry(
  homeDir: string,
  createKannaDirectory: boolean,
  testSynchronization?: ReleaseEnvironmentTestSynchronization
): DirectoryAncestryEntry[] | undefined {
  if (!isAbsolute(homeDir)) {
    throw new Error(`Machine-local home directory must be absolute: ${homeDir}`);
  }
  const normalizedHome = resolve(homeDir);
  // Pin the resolved home inode instead of rejecting every path component:
  // macOS intentionally exposes /var as a symlink to /private/var. The worker
  // verifies this inode as its cwd, so replacing any earlier component cannot
  // redirect the relative .kanna operation.
  const homeStats = lstatSync(normalizedHome, { bigint: true });
  if (homeStats.isSymbolicLink()) {
    throw new Error(
      `Machine-local home directory must not be a symbolic link: ${normalizedHome}`
    );
  }
  if (!homeStats.isDirectory()) {
    throw new Error(`Machine-local home path must be a directory: ${normalizedHome}`);
  }
  const homeAncestry: DirectoryAncestryEntry[] = [
    {
      name: "",
      canonicalPath: normalizedHome,
      dev: homeStats.dev.toString(),
      ino: homeStats.ino.toString()
    }
  ];
  const response = runPinnedDirectoryWorker(normalizedHome, {
    operation: createKannaDirectory ? "ensure-directory" : "inspect-directory",
    ancestry: homeAncestry,
    childName: ".kanna",
    testSynchronization
  });
  if (response.missing) {
    return undefined;
  }
  if (response.directory === undefined) {
    throw new Error(`Unable to pin machine-local release directory ${join(homeDir, ".kanna")}.`);
  }
  return [
    ...homeAncestry,
    {
      name: ".kanna",
      canonicalPath: join(normalizedHome, ".kanna"),
      ...response.directory
    }
  ];
}

function runPinnedDirectoryWorker(
  cwd: string,
  request: Record<string, unknown>
): PinnedWorkerResponse {
  const workerArguments = [
    "-e",
    // tsup rewrites require() inside Function#toString to __require(); define
    // the same local in the standalone process so source and bundled kd share
    // exactly one worker implementation.
    `const __require = require; const __name = (target) => target;\n(${pinnedDirectoryWorker.toString()})()`
  ];
  const serializeWrite = request.operation === "write";
  if (serializeWrite) {
    const ancestry = request.ancestry as DirectoryAncestryEntry[];
    preparePinnedDirectoryLock(
      cwd,
      ancestry,
      ".release-environment-write.lockf",
      request.repairDirectoryMode === true
    );
  }
  const result = spawnSync(
    serializeWrite ? "/usr/bin/lockf" : process.execPath,
    serializeWrite
      ? [
          "-s",
          "-t",
          "0",
          "-k",
          ".release-environment-write.lockf",
          process.execPath,
          ...workerArguments
        ]
      : workerArguments,
    {
      cwd,
      encoding: "utf8",
      input: JSON.stringify(request),
      maxBuffer: 2 * 1024 * 1024
    }
  );
  if (result.error) {
    throw new Error(`Unable to pin machine-local release directory ${cwd}: ${result.error.message}`);
  }
  if (serializeWrite && result.status === 75) {
    throw new Error(
      "Another machine-local release setup is already in progress; retry after it finishes."
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Unable to access pinned machine-local release directory ${cwd}: ${result.stderr.trim() || `worker exited ${result.status}`}`
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Pinned machine-local release directory worker returned invalid output for ${cwd}.`);
  }
  if (!isRecord(response) || typeof response.ok !== "boolean") {
    throw new Error(`Pinned machine-local release directory worker returned invalid output for ${cwd}.`);
  }
  const typedResponse = response as unknown as PinnedWorkerResponse;
  if (!typedResponse.ok) {
    throw new Error(typedResponse.error ?? `Unable to access pinned directory ${cwd}.`);
  }
  return typedResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// This function is serialized into a fresh Node process whose cwd is selected
// by the kernel. All sensitive path operations are relative to that pinned cwd;
// ancestry checks before and after each operation detect pathname replacement
// without ever following a replacement into repository-controlled storage.
function pinnedDirectoryWorker(): void {
  const fs: typeof import("node:fs") = require("node:fs");
  const crypto: typeof import("node:crypto") = require("node:crypto");
  const request = JSON.parse(fs.readFileSync(0, "utf8")) as Record<string, unknown>;

  const respond = (response: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(response));
  };
  const identity = (path: string): DirectoryIdentity => {
    const stats = fs.lstatSync(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Machine-local release configuration directory is not a regular directory: ${path}`);
    }
    return { dev: stats.dev.toString(), ino: stats.ino.toString() };
  };
  const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
    left.dev === right.dev && left.ino === right.ino;
  const ancestry = request.ancestry as DirectoryAncestryEntry[];
  const synchronizeTest = (event: ReleaseEnvironmentTestSynchronization["event"]): void => {
    const synchronization = request.testSynchronization;
    if (
      typeof synchronization !== "object" ||
      synchronization === null ||
      (synchronization as ReleaseEnvironmentTestSynchronization).event !== event
    ) {
      return;
    }
    const { readyPath, continuePath } = synchronization as ReleaseEnvironmentTestSynchronization;
    fs.writeFileSync(readyPath, event, { encoding: "utf8", flag: "wx" });
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(continuePath)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for release-environment test synchronization at ${event}.`);
      }
      Atomics.wait(waitArray, 0, 0, 10);
    }
  };
  const assertPinnedAncestry = (): void => {
    if (!Array.isArray(ancestry) || ancestry.length === 0) {
      throw new Error("Machine-local release configuration ancestry is missing.");
    }
    const last = ancestry.length - 1;
    for (let index = last; index >= 0; index -= 1) {
      const upward = "../".repeat(last - index);
      const currentPath = upward || ".";
      if (!sameIdentity(identity(currentPath), ancestry[index])) {
        throw new Error("Machine-local release configuration ancestry changed during access.");
      }
      if (!sameIdentity(identity(ancestry[index].canonicalPath), ancestry[index])) {
        throw new Error("Machine-local release configuration canonical path changed during access.");
      }
      if (index > 0) {
        const entryPath = `${upward}../${ancestry[index].name}`;
        if (!sameIdentity(identity(entryPath), ancestry[index])) {
          throw new Error("Machine-local release configuration ancestry changed during access.");
        }
      }
    }
  };
  const readReleaseFile = (
    fileName: string,
    requireOwnerOnly: boolean
  ): { missing: boolean; source?: string } => {
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        fileName,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { missing: true };
      if (code === "ELOOP") {
        throw new Error("Machine-local release environment must be a regular file, not a symbolic link.");
      }
      throw error;
    }
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile()) {
        throw new Error("Machine-local release environment must be a regular file.");
      }
      const permissions = opened.mode & 0o777;
      if (requireOwnerOnly && (permissions & 0o077) !== 0) {
        throw new Error(
          `Machine-local release environment must be owner-only (0600), but is mode ${permissions.toString(8).padStart(4, "0")}. Run chmod 600 before retrying.`
        );
      }
      const source = fs.readFileSync(descriptor, "utf8");
      const configured = fs.lstatSync(fileName);
      if (
        configured.isSymbolicLink() ||
        !configured.isFile() ||
        configured.dev !== opened.dev ||
        configured.ino !== opened.ino
      ) {
        throw new Error(
          "Machine-local release environment must remain the same regular, non-symlinked file while it is read."
        );
      }
      return { missing: false, source };
    } finally {
      fs.closeSync(descriptor);
    }
  };
  try {
    assertPinnedAncestry();
    const operation = request.operation;
    if (operation === "inspect-directory" || operation === "ensure-directory") {
      const childName = String(request.childName);
      let child;
      try {
        child = fs.lstatSync(childName, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (operation === "inspect-directory") {
          assertPinnedAncestry();
          respond({ ok: true, missing: true });
          return;
        }
        try {
          fs.mkdirSync(childName, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        child = fs.lstatSync(childName, { bigint: true });
      }
      if (child.isSymbolicLink()) {
        throw new Error("Machine-local release configuration directory must not be a symbolic link.");
      }
      if (!child.isDirectory()) {
        throw new Error("Machine-local release configuration path must be a directory.");
      }
      assertPinnedAncestry();
      respond({
        ok: true,
        missing: false,
        directory: { dev: child.dev.toString(), ino: child.ino.toString() }
      });
      return;
    }

    if (operation === "assert-directory") {
      assertPinnedAncestry();
      respond({ ok: true });
      return;
    }

    if (request.repairDirectoryMode === true) {
      fs.chmodSync(".", 0o700);
    }
    const fileName = String(request.fileName);
    if (operation === "ensure-lock-file") {
      if (!/^\.[a-z0-9-]+\.lockf$/.test(fileName)) {
        throw new Error("Invalid machine-local release lock name.");
      }
      const descriptor = fs.openSync(
        fileName,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile()) {
          throw new Error("Machine-local release lock must be a regular file.");
        }
        if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
          throw new Error("Machine-local release lock must be owned by the current user.");
        }
        fs.fchmodSync(descriptor, 0o600);
        const configured = fs.lstatSync(fileName);
        if (
          configured.isSymbolicLink() ||
          !configured.isFile() ||
          configured.dev !== opened.dev ||
          configured.ino !== opened.ino
        ) {
          throw new Error("Machine-local release lock must remain the same regular, non-symlinked file while it is prepared.");
        }
      } finally {
        fs.closeSync(descriptor);
      }
      assertPinnedAncestry();
      respond({ ok: true });
      return;
    }
    if (operation === "read") {
      const result = readReleaseFile(fileName, request.requireOwnerOnly === true);
      synchronizeTest("after-release-file-read");
      assertPinnedAncestry();
      respond({ ok: true, ...result });
      return;
    }
    if (operation === "write") {
      const current = readReleaseFile(fileName, false);
      const expectedSource = request.expectedSource;
      if (
        (current.missing && expectedSource !== undefined) ||
        (!current.missing && current.source !== expectedSource)
      ) {
        throw new Error("Machine-local release environment changed while selectors were being written; retry setup.");
      }
      const source = request.source;
      if (typeof source !== "string") {
        throw new Error("Machine-local release environment replacement content is missing.");
      }
      const tempName = `${fileName}.tmp-${process.pid}-${crypto.randomUUID()}`;
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(
          tempName,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600
        );
        synchronizeTest("after-temp-created");
        fs.writeFileSync(descriptor, source, "utf8");
        fs.fchmodSync(descriptor, 0o600);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        assertPinnedAncestry();
        const publishSource = readReleaseFile(fileName, false);
        if (
          (publishSource.missing && expectedSource !== undefined) ||
          (!publishSource.missing && publishSource.source !== expectedSource)
        ) {
          throw new Error("Machine-local release environment changed while selectors were being written; retry setup.");
        }
        synchronizeTest("before-release-file-rename");
        fs.renameSync(tempName, fileName);
        assertPinnedAncestry();
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        fs.rmSync(tempName, { force: true });
      }
      respond({ ok: true });
      return;
    }
    throw new Error("Unknown pinned machine-local release operation.");
  } catch (error) {
    respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
