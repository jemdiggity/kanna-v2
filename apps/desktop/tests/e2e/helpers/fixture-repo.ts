import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

interface CreateFixtureRepoOptions {
  fixtureName?: string;
  tempRoot?: string;
}

interface CreateSeedFixtureRepoOptions {
  fixtureRoot?: string;
  tempRoot?: string;
}

interface CommandOptions {
  cwd?: string;
}

const RM_RETRY_OPTIONS = {
  force: true,
  recursive: true,
  maxRetries: 10,
  retryDelay: 100,
} as const;

const DEFAULT_LIVE_REPO_ROOT = resolve(
  process.env.KANNA_E2E_LIVE_REPO_ROOT ??
    dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

const DEFAULT_SEED_FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/repos",
);

const DEFAULT_FIXTURE_NAME = "generic-kanna-like";

const FIXTURE_TEMP_DIR_PREFIX = "fixture-";
const DEFAULT_FIXTURE_TEMP_ROOT = join(tmpdir(), "kanna-e2e-fixtures");

/**
 * Where the app clones a repo it acquires for a transferred task. E2E suites
 * read those paths back out of the destination database and hand them to
 * `cleanupFixtureRepos`, so removal has to be possible here too — but only for
 * clones named after a fixture this process created.
 */
const ACQUIRED_REPO_ROOT = resolve(homedir(), ".kanna", "repos");

/** Every temp root a fixture has been materialized under in this process. */
const fixtureTempRoots = new Set<string>([resolve(DEFAULT_FIXTURE_TEMP_ROOT)]);

/** Sanitized names of the fixture repos this process created. */
const createdFixtureNames = new Set<string>();

function sanitizeRepoName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function runCommand(command: string[], options: CommandOptions = {}): Promise<void> {
  const [file, ...args] = command;
  const proc = spawn(file, args, {
    cwd: options.cwd,
    stdio: "pipe",
  });

  let stderr = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolveCommand, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }

      if (signal) {
        reject(new Error(`${command.join(" ")} exited with signal ${signal}`));
        return;
      }

      const details = stderr.trim();
      reject(
        new Error(
          details.length > 0
            ? `${command.join(" ")} failed: ${details}`
            : `${command.join(" ")} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

function isWithinPath(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function getLiveRepoRoot(): string {
  return DEFAULT_LIVE_REPO_ROOT;
}

export function assertSafeE2eRepoPath(
  repoPath: string,
  liveRepoRoot = getLiveRepoRoot(),
): void {
  if (!isWithinPath(repoPath, liveRepoRoot)) return;

  throw new Error(
    `E2E tests must import a fixture repo, not the live Kanna checkout: ${repoPath}`,
  );
}

function isInsideFixtureTempRoot(resolvedPath: string): boolean {
  for (const fixtureTempRoot of fixtureTempRoots) {
    const relativePath = relative(fixtureTempRoot, resolvedPath);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
    // Every fixture lives under a `fixture-XXXXXX` directory this helper
    // created with mkdtemp; nothing else under the temp root is ours to remove.
    if (relativePath.split(sep)[0]?.startsWith(FIXTURE_TEMP_DIR_PREFIX)) return true;
  }

  return false;
}

function isAcquiredFixtureClone(resolvedPath: string): boolean {
  if (dirname(resolvedPath) !== ACQUIRED_REPO_ROOT) return false;

  const directoryName = basename(resolvedPath);
  for (const fixtureName of createdFixtureNames) {
    if (directoryName === fixtureName || directoryName.startsWith(`${fixtureName}-`)) return true;
  }

  return false;
}

/**
 * Guards the only destructive operation in the E2E fixture helpers.
 *
 * A bare `vitest run` from `apps/desktop` collects `tests/e2e/real/**` (the
 * package's `test` script scopes to `src`, a bare invocation does not). Those
 * suites cannot reach an app, so their `beforeAll` fails before assigning a
 * fixture path — and the cleanup hook still ran with `""`. `resolve("")` is the
 * cwd, so the recursive remove deleted the whole `apps/desktop` tree
 * (2026-08-06). Removal now has to be tied back to a fixture this process
 * created; anything else throws instead of falling through to `rm`.
 */
export function assertRemovableFixturePath(candidatePath: string): void {
  if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
    throw new Error(
      "refusing to remove an empty fixture path — the fixture was never created (its setup most likely failed before assigning a path)",
    );
  }

  if (!isAbsolute(candidatePath)) {
    throw new Error(`refusing to remove a relative fixture path: ${candidatePath}`);
  }

  const resolvedPath = resolve(candidatePath);
  assertSafeE2eRepoPath(resolvedPath);

  const containedPaths: Array<[string, string]> = [
    ["the working directory", process.cwd()],
    ["the live Kanna checkout", getLiveRepoRoot()],
  ];
  for (const [label, containedPath] of containedPaths) {
    if (isWithinPath(containedPath, resolvedPath)) {
      throw new Error(
        `refusing to remove ${resolvedPath}: it contains ${label} (${containedPath})`,
      );
    }
  }

  if (isInsideFixtureTempRoot(resolvedPath) || isAcquiredFixtureClone(resolvedPath)) return;

  throw new Error(
    `refusing to remove ${resolvedPath}: it is not inside a fixture root created by this process (${[...fixtureTempRoots].join(", ")})`,
  );
}

async function registerFixtureTempRoot(tempRoot: string): Promise<void> {
  const resolvedTempRoot = resolve(tempRoot);
  fixtureTempRoots.add(resolvedTempRoot);
  // The macOS temp dir is a symlink (/var/folders → /private/var/folders), so a
  // caller handing back a canonicalized path must still match a known root.
  fixtureTempRoots.add(await realpath(resolvedTempRoot).catch(() => resolvedTempRoot));
}

function registerFixtureName(destinationName: string): string {
  const repoName = sanitizeRepoName(destinationName);
  if (!/[a-zA-Z0-9]/.test(repoName)) {
    throw new Error(`fixture repo name must contain alphanumerics: ${destinationName}`);
  }
  createdFixtureNames.add(repoName);
  return repoName;
}

async function materializeSeedFixtureRepo(input: {
  destinationName: string;
  fixtureName: string;
  fixtureRoot: string;
  tempRoot: string;
}): Promise<string> {
  const fixtureRoot = resolve(input.fixtureRoot);
  const sourceFixturePath = join(fixtureRoot, input.fixtureName);
  const tempRoot = input.tempRoot;
  await mkdir(tempRoot, { recursive: true });
  await registerFixtureTempRoot(tempRoot);
  const tempDir = await mkdtemp(join(tempRoot, FIXTURE_TEMP_DIR_PREFIX));
  const repoName = registerFixtureName(input.destinationName);
  const fixtureRepoPath = join(tempDir, repoName);
  const originPath = join(tempDir, `${repoName}-origin.git`);

  await cp(sourceFixturePath, fixtureRepoPath, { recursive: true });

  await runCommand(["git", "init"], { cwd: fixtureRepoPath });
  await runCommand(["git", "config", "user.name", "Kanna E2E"], { cwd: fixtureRepoPath });
  await runCommand(["git", "config", "user.email", "kanna-e2e@example.com"], { cwd: fixtureRepoPath });
  await runCommand(["git", "add", "."], { cwd: fixtureRepoPath });
  await runCommand(["git", "commit", "-m", "seed fixture"], { cwd: fixtureRepoPath });
  await runCommand(["git", "branch", "-M", "main"], { cwd: fixtureRepoPath });

  await runCommand(["git", "init", "--bare", originPath], { cwd: tempDir });
  await runCommand(["git", "remote", "add", "origin", originPath], { cwd: fixtureRepoPath });
  await runCommand(["git", "push", "-u", "origin", "main"], { cwd: fixtureRepoPath });

  return fixtureRepoPath;
}

export async function createFixtureRepo(
  name: string,
  options: CreateFixtureRepoOptions = {},
): Promise<string> {
  return materializeSeedFixtureRepo({
    destinationName: name,
    fixtureName: options.fixtureName ?? DEFAULT_FIXTURE_NAME,
    fixtureRoot: DEFAULT_SEED_FIXTURE_ROOT,
    tempRoot: options.tempRoot ?? join(tmpdir(), "kanna-e2e-fixtures"),
  });
}

export async function createSeedFixtureRepo(
  fixtureName: string,
  options: CreateSeedFixtureRepoOptions = {},
): Promise<string> {
  return materializeSeedFixtureRepo({
    destinationName: fixtureName,
    fixtureName,
    fixtureRoot: options.fixtureRoot ?? DEFAULT_SEED_FIXTURE_ROOT,
    tempRoot: options.tempRoot ?? join(tmpdir(), "kanna-e2e-fixtures"),
  });
}

function fixtureRemovalTarget(repoPath: string): string {
  assertRemovableFixturePath(repoPath);
  const resolvedRepoPath = resolve(repoPath);
  const parentDir = dirname(resolvedRepoPath);
  if (!basename(parentDir).startsWith(FIXTURE_TEMP_DIR_PREFIX)) return resolvedRepoPath;

  assertRemovableFixturePath(parentDir);
  return parentDir;
}

export async function cleanupFixtureRepos(repoPaths: string[]): Promise<void> {
  const targets: string[] = [];
  const refusals: string[] = [];
  for (const repoPath of repoPaths) {
    try {
      targets.push(fixtureRemovalTarget(repoPath));
    } catch (error) {
      refusals.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Removals happen only after every path has cleared the guard, so one bad
  // entry cannot take a directory with it — but the good entries still get
  // cleaned before the refusal surfaces.
  for (const target of targets) {
    await rm(target, RM_RETRY_OPTIONS);
  }

  if (refusals.length > 0) {
    throw new Error(
      `cleanupFixtureRepos refused ${refusals.length} unsafe path(s):\n${refusals.join("\n")}`,
    );
  }
}
