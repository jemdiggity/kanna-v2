import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

interface CreateFixtureRepoOptions {
  fixtureName?: string;
  tempRoot?: string;
}

interface CreateSeedFixtureRepoOptions {
  fixtureRoot?: string;
  tempRoot?: string;
}

interface CreateEmptyFixtureRepoOptions {
  initialBranch?: string;
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
 * The exact `fixture-XXXX` directories this process created with `mkdtemp`,
 * recorded only once that call succeeded. Ownership is the directory itself —
 * not the base it sits in and not its name — because a temp base is shared:
 * another process (or an abandoned run) can leave a `fixture-XXXX` lookalike
 * there, and nothing about its path distinguishes it from ours.
 */
const ownedFixtureDirs = new Set<string>();

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

function owningFixtureDir(resolvedPath: string): string | null {
  for (const ownedFixtureDir of ownedFixtureDirs) {
    if (isWithinPath(resolvedPath, ownedFixtureDir)) return ownedFixtureDir;
  }

  return null;
}

/**
 * Guards the only destructive operation in the E2E fixture helpers, and names
 * what gets removed: the `mkdtemp` directory that owns the fixture, which holds
 * the fixture repo and its bare origin and nothing else.
 *
 * A bare `vitest run` from `apps/desktop` collects `tests/e2e/real/**` (the
 * package's `test` script scopes to `src`, a bare invocation does not). Those
 * suites cannot reach an app, so their `beforeAll` fails before assigning a
 * fixture path — and the cleanup hook still ran with `""`. `resolve("")` is the
 * cwd, so the recursive remove deleted the whole `apps/desktop` tree
 * (2026-08-06). Removal is now confined to directories this process created and
 * recorded; anything else — a `fixture-XXXX` lookalike another run left in the
 * shared temp base included — throws instead of falling through to `rm`.
 */
function ownedFixtureRemovalTarget(candidatePath: string): string {
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

  const ownedFixtureDir = owningFixtureDir(resolvedPath);
  if (ownedFixtureDir) return ownedFixtureDir;

  throw new Error(
    `refusing to remove ${resolvedPath}: it is not inside a fixture directory this process created (${ownedFixtureDirs.size} recorded)`,
  );
}

export function assertRemovableFixturePath(candidatePath: string): void {
  ownedFixtureRemovalTarget(candidatePath);
}

async function registerOwnedFixtureDir(tempDir: string): Promise<void> {
  const resolvedTempDir = resolve(tempDir);
  ownedFixtureDirs.add(resolvedTempDir);
  // The macOS temp dir is a symlink (/var/folders → /private/var/folders), so a
  // caller handing back a canonicalized path must still match what we created.
  ownedFixtureDirs.add(await realpath(resolvedTempDir).catch(() => resolvedTempDir));
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
  const tempDir = await mkdtemp(join(tempRoot, FIXTURE_TEMP_DIR_PREFIX));
  await registerOwnedFixtureDir(tempDir);
  const repoName = sanitizeRepoName(input.destinationName);
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
    tempRoot: options.tempRoot ?? DEFAULT_FIXTURE_TEMP_ROOT,
  });
}

export async function createEmptyFixtureRepo(
  name: string,
  options: CreateEmptyFixtureRepoOptions = {},
): Promise<string> {
  const tempRoot = options.tempRoot ?? DEFAULT_FIXTURE_TEMP_ROOT;
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, FIXTURE_TEMP_DIR_PREFIX));
  await registerOwnedFixtureDir(tempDir);
  const repoPath = join(tempDir, sanitizeRepoName(name));
  await mkdir(repoPath, { recursive: true });
  await runCommand(
    ["git", "init", `--initial-branch=${options.initialBranch ?? "main"}`],
    { cwd: repoPath },
  );
  return repoPath;
}

export async function createSeedFixtureRepo(
  fixtureName: string,
  options: CreateSeedFixtureRepoOptions = {},
): Promise<string> {
  return materializeSeedFixtureRepo({
    destinationName: fixtureName,
    fixtureName,
    fixtureRoot: options.fixtureRoot ?? DEFAULT_SEED_FIXTURE_ROOT,
    tempRoot: options.tempRoot ?? DEFAULT_FIXTURE_TEMP_ROOT,
  });
}

export async function cleanupFixtureRepos(repoPaths: string[]): Promise<void> {
  const targets: string[] = [];
  const refusals: string[] = [];
  for (const repoPath of repoPaths) {
    try {
      // Removing the owning directory takes the fixture repo and its bare
      // origin together, which is what every caller means by cleanup.
      targets.push(ownedFixtureRemovalTarget(repoPath));
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
