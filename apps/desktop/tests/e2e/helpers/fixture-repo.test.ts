import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

  it("creates an empty repo with an explicit unborn branch", async () => {
    const { createEmptyFixtureRepo } = await import("./fixture-repo");

    const fixtureRepoPath = await createEmptyFixtureRepo("empty-fixture-repo", {
      initialBranch: "trunk",
    });
    createdRepoPaths.push(fixtureRepoPath);

    const { stdout: branch } = await execFileAsync("git", [
      "-C",
      fixtureRepoPath,
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    const { stdout: commitCount } = await execFileAsync("git", [
      "-C",
      fixtureRepoPath,
      "rev-list",
      "--all",
      "--count",
    ]);
    expect(branch.trim()).toBe("trunk");
    expect(commitCount.trim()).toBe("0");
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
  const lookalikeDirs: string[] = [];

  afterEach(async () => {
    if (createdRepoPaths.length > 0) {
      const { cleanupFixtureRepos } = await import("./fixture-repo");
      await cleanupFixtureRepos(createdRepoPaths.splice(0));
    }
    // Lookalikes are not the helper's to remove — that is the point of the
    // test — so this suite takes them out itself.
    await Promise.all(
      lookalikeDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  /**
   * A `fixture-XXXX` directory in the shared temp base that this process did
   * not create — what an abandoned run or a concurrent one leaves behind.
   */
  async function materializeLookalikeFixtureDir(): Promise<string> {
    await mkdir(FIXTURE_TEMP_ROOT, { recursive: true });
    const tempDir = await mkdtemp(join(FIXTURE_TEMP_ROOT, "fixture-"));
    lookalikeDirs.push(tempDir);
    const repoPath = join(tempDir, "removal-guard-lookalike");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "tracked.txt"), "not ours\n", "utf8");
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

  it("permits and removes a repo this helper created", async () => {
    const { assertRemovableFixturePath, cleanupFixtureRepos, createFixtureRepo } =
      await import("./fixture-repo");
    const repoPath = await createFixtureRepo("removal-guard-owned");

    expect(() => assertRemovableFixturePath(repoPath)).not.toThrow();
    await cleanupFixtureRepos([repoPath]);

    await expect(access(repoPath)).rejects.toThrow();
    // The mkdtemp owner goes with it: it holds the repo and its bare origin.
    await expect(access(dirname(repoPath))).rejects.toThrow();
  });

  it("refuses a fixture-shaped directory this process did not create", async () => {
    const { assertRemovableFixturePath, cleanupFixtureRepos, createFixtureRepo } =
      await import("./fixture-repo");
    // Own a fixture first, so the refusal cannot be an empty-registry artifact.
    createdRepoPaths.push(await createFixtureRepo("removal-guard-owner"));
    const lookalikeRepoPath = await materializeLookalikeFixtureDir();

    expect(() => assertRemovableFixturePath(lookalikeRepoPath)).toThrow(
      /refusing to remove/,
    );
    expect(() => assertRemovableFixturePath(dirname(lookalikeRepoPath))).toThrow(
      /refusing to remove/,
    );
    await expect(cleanupFixtureRepos([lookalikeRepoPath])).rejects.toThrow(
      /refused 1 unsafe path/,
    );

    await expect(access(lookalikeRepoPath)).resolves.toBeUndefined();
    await expect(access(dirname(lookalikeRepoPath))).resolves.toBeUndefined();
  });

  it("still cleans valid fixtures when handed the incident's unassigned path", async () => {
    const { cleanupFixtureRepos, createFixtureRepo } = await import("./fixture-repo");
    const repoPath = await createFixtureRepo("removal-guard-incident");

    await expect(cleanupFixtureRepos(["", repoPath])).rejects.toThrow(
      /refused 1 unsafe path/,
    );

    await expect(access(repoPath)).rejects.toThrow();
    await expect(access(PACKAGE_ROOT)).resolves.toBeUndefined();
  });

  it("still refuses same-named paths outside the fixture base once that fixture exists", async () => {
    const { assertRemovableFixturePath, createFixtureRepo } = await import("./fixture-repo");
    const fixtureName = "removal-guard-outside-base";
    const fixtureRepoPath = await createFixtureRepo(fixtureName);
    createdRepoPaths.push(fixtureRepoPath);

    expect(() => assertRemovableFixturePath(fixtureRepoPath)).not.toThrow();

    // Creating a fixture must not authorize anything that merely shares its
    // name. A repo the app cloned into the operator's home is not ours to
    // remove, however it is named.
    const impostors = [
      join(homedir(), ".kanna", "repos", fixtureName),
      join(homedir(), ".kanna", "repos", `${fixtureName}-origin`),
      join(tmpdir(), fixtureName),
      join(FIXTURE_TEMP_ROOT, fixtureName),
    ];
    for (const impostor of impostors) {
      expect(() => assertRemovableFixturePath(impostor), impostor).toThrow(/refusing to remove/);
    }
  });
});
