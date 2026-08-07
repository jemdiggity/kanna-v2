import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const LIVE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_TEMP_ROOT = join(tmpdir(), "kanna-e2e-fixtures");

describe("fixture repo helpers", () => {
  const createdRepoPaths: string[] = [];

  afterEach(async () => {
    if (createdRepoPaths.length === 0) return;

    const { cleanupFixtureRepos } = await import("./fixture-repo");
    await cleanupFixtureRepos(createdRepoPaths.splice(0));
  });

  it("rejects live checkout paths and their descendants", async () => {
    const { assertSafeE2eRepoPath } = await import("./fixture-repo");

    expect(() => assertSafeE2eRepoPath("/tmp/fixture", LIVE_REPO_ROOT)).not.toThrow();
    expect(() => assertSafeE2eRepoPath(LIVE_REPO_ROOT, LIVE_REPO_ROOT)).toThrow(
      /fixture repo/i,
    );
    expect(() => assertSafeE2eRepoPath(`${LIVE_REPO_ROOT}/apps`, LIVE_REPO_ROOT)).toThrow(
      /fixture repo/i,
    );
  });

  it("creates isolated repos from committed fake fixture content outside the live checkout", async () => {
    const { createFixtureRepo } = await import("./fixture-repo");

    const fixtureRepoPath = await createFixtureRepo("fixture-repo-test");
    createdRepoPaths.push(fixtureRepoPath);

    expect(fixtureRepoPath.startsWith(`${LIVE_REPO_ROOT}/`)).toBe(false);
    await expect(access(resolve(fixtureRepoPath, ".git"))).resolves.toBeUndefined();
    await expect(access(resolve(fixtureRepoPath, "apps", "README.md"))).resolves.toBeUndefined();

    const { stdout } = await execFileAsync("git", [
      "-C",
      fixtureRepoPath,
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(await realpath(stdout.trim())).toBe(await realpath(fixtureRepoPath));
  });

  it("creates a disposable repo from committed seed content with a local bare origin", async () => {
    const { createSeedFixtureRepo } = await import("./fixture-repo");

    const fixtureRepoPath = await createSeedFixtureRepo("task-switch-minimal");
    createdRepoPaths.push(fixtureRepoPath);

    expect(fixtureRepoPath.startsWith(`${LIVE_REPO_ROOT}/`)).toBe(false);
    await expect(access(resolve(fixtureRepoPath, ".git"))).resolves.toBeUndefined();

    const { stdout: topLevel } = await execFileAsync("git", [
      "-C",
      fixtureRepoPath,
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(await realpath(topLevel.trim())).toBe(await realpath(fixtureRepoPath));

    const { stdout: originUrl } = await execFileAsync("git", [
      "-C",
      fixtureRepoPath,
      "remote",
      "get-url",
      "origin",
    ]);
    const resolvedOriginPath = await realpath(originUrl.trim());
    expect(resolvedOriginPath.endsWith(".git")).toBe(true);

    const { stdout: isBare } = await execFileAsync("git", [
      "--git-dir",
      resolvedOriginPath,
      "rev-parse",
      "--is-bare-repository",
    ]);
    expect(isBare.trim()).toBe("true");

    const { stdout: mainRef } = await execFileAsync("git", [
      "--git-dir",
      resolvedOriginPath,
      "rev-parse",
      "refs/heads/main",
    ]);
    expect(mainRef.trim().length).toBeGreaterThan(0);
  });
});

describe("fixture removal guard", () => {
  const createdRepoPaths: string[] = [];

  afterEach(async () => {
    if (createdRepoPaths.length === 0) return;

    const { cleanupFixtureRepos } = await import("./fixture-repo");
    await cleanupFixtureRepos(createdRepoPaths.splice(0));
  });

  async function materializeFixtureShapedDir(): Promise<string> {
    await mkdir(FIXTURE_TEMP_ROOT, { recursive: true });
    const tempDir = await mkdtemp(join(FIXTURE_TEMP_ROOT, "fixture-"));
    const repoPath = join(tempDir, "removal-guard-fixture");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "tracked.txt"), "fixture\n", "utf8");
    return repoPath;
  }

  it("refuses every path it cannot tie back to a fixture root", async () => {
    const { assertRemovableFixturePath } = await import("./fixture-repo");

    const refused: Array<[string, string]> = [
      ["an unassigned fixture path", ""],
      ["a blank fixture path", "   "],
      ["a relative path", "tests/e2e"],
      ["the working directory", process.cwd()],
      ["the desktop package root", PACKAGE_ROOT],
      ["the live checkout", LIVE_REPO_ROOT],
      ["the home directory", homedir()],
      ["the filesystem root", "/"],
      ["the fixture temp root itself", FIXTURE_TEMP_ROOT],
      ["a sibling of the fixture dirs", join(FIXTURE_TEMP_ROOT, "not-a-fixture-dir")],
      ["a temp path outside the fixture root", join(tmpdir(), "kanna-unrelated-temp-dir")],
      ["a repo the tests did not create", join(homedir(), ".kanna", "repos", "kanna-7")],
    ];

    for (const [label, candidate] of refused) {
      // Paths inside the live checkout are refused by the older import guard,
      // which throws its own message before the removal guard is reached.
      expect(() => assertRemovableFixturePath(candidate), label).toThrow(
        /refusing to remove|must import a fixture repo/,
      );
    }
  });

  it("permits and removes a fixture path under the fixture temp root", async () => {
    const { assertRemovableFixturePath, cleanupFixtureRepos } = await import("./fixture-repo");
    const repoPath = await materializeFixtureShapedDir();

    expect(() => assertRemovableFixturePath(repoPath)).not.toThrow();
    await cleanupFixtureRepos([repoPath]);

    await expect(access(repoPath)).rejects.toThrow();
    // The mkdtemp parent goes with it, as it only ever holds this fixture.
    await expect(access(dirname(repoPath))).rejects.toThrow();
  });

  it("still cleans valid fixtures when handed the incident's unassigned path", async () => {
    const { cleanupFixtureRepos } = await import("./fixture-repo");
    const repoPath = await materializeFixtureShapedDir();

    await expect(cleanupFixtureRepos(["", repoPath])).rejects.toThrow(
      /refused 1 unsafe path/,
    );

    await expect(access(repoPath)).rejects.toThrow();
    await expect(access(PACKAGE_ROOT)).resolves.toBeUndefined();
  });

  it("permits a clone the app acquired for a fixture this process created", async () => {
    const { assertRemovableFixturePath, createFixtureRepo } = await import("./fixture-repo");
    const acquiredRoot = join(homedir(), ".kanna", "repos");

    expect(() =>
      assertRemovableFixturePath(join(acquiredRoot, "removal-guard-acquired-origin")),
    ).toThrow(/refusing to remove/);

    createdRepoPaths.push(await createFixtureRepo("removal-guard-acquired"));

    expect(() =>
      assertRemovableFixturePath(join(acquiredRoot, "removal-guard-acquired-origin")),
    ).not.toThrow();
    expect(() =>
      assertRemovableFixturePath(join(acquiredRoot, "some-other-checkout")),
    ).toThrow(/refusing to remove/);
  });
});
