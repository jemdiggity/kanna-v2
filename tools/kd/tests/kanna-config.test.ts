import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli";

interface KannaRepoConfig {
  setup?: string[];
  teardown?: string[];
}

const root = resolve(import.meta.dirname, "../../..");
const localSetupCommand =
  'local_setup="$(git rev-parse --git-common-dir 2>/dev/null)/../.kanna/setup.local.sh"; [ ! -x "$local_setup" ] || "$local_setup" || true';

function readOriginMainConfig(): KannaRepoConfig | undefined {
  try {
    return JSON.parse(
      execFileSync("git", ["show", "origin/main:.kanna/config.json"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    ) as KannaRepoConfig;
  } catch {
    // A clone without the origin/main ref cannot exercise the snapshot boundary.
    return undefined;
  }
}

/** Every `./kd <group> <command>` this config would run at stage setup/teardown. */
function kdCommands(config: KannaRepoConfig): string[][] {
  return [...(config.setup ?? []), ...(config.teardown ?? [])]
    .filter((command) => command.startsWith("./kd "))
    .map((command) => command.slice("./kd ".length).split(/\s+/));
}

describe("Kanna repository cache defaults", () => {
  const config = JSON.parse(
    readFileSync(resolve(root, ".kanna/config.json"), "utf8")
  ) as KannaRepoConfig;

  it("installs the compiler cache after environment sync in every Kanna-managed worktree", () => {
    // Deliberately still the `warm` spelling. Repo config is read from the
    // origin/main snapshot rather than the task branch, so this list runs against
    // *other* branches' kd. `warm` is the only spelling both this kd (via the
    // compatibility alias) and every pre-kache kd accept, so branches cut before
    // this change keep transitioning after it merges. Switch to `install` only
    // once no such branch is open, together with removing the alias in cli.ts.
    //
    // Asserted as presence plus relative order, not as the whole list: setup also
    // carries entries this test has no opinion on (temporary mitigations, for one),
    // and pinning it verbatim turns every unrelated config edit into a red suite.
    const setup = config.setup ?? [];
    const required = ["pnpm install", "./kd env sync", "./kd rust-cache warm", localSetupCommand];

    for (const command of required) {
      expect(setup, `.kanna/config.json setup runs: ${command}`).toContain(command);
    }

    const positions = required.map((command) => setup.indexOf(command));
    expect(positions, "setup keeps the cache install after environment sync").toEqual(
      [...positions].sort((a, b) => a - b)
    );
    expect(setup.slice(setup.indexOf(localSetupCommand) + 1)).toContain("./kd env sync");
  });

  it("runs one shared machine-local hook without letting it block setup", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "kanna-local-setup-"));
    const repo = resolve(fixture, "repo");
    const worktree = resolve(fixture, "worktree");
    const localHook = resolve(repo, ".kanna", "setup.local.sh");
    const marker = resolve(worktree, "hook-ran");

    try {
      mkdirSync(repo);
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo, stdio: "ignore" });
      writeFileSync(resolve(repo, "tracked.txt"), "fixture\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: repo, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Kanna Test", "-c", "user.email=test@kanna.invalid", "commit", "-m", "fixture"],
        { cwd: repo, stdio: "ignore" }
      );
      execFileSync("git", ["worktree", "add", "-b", "fixture-worktree", worktree], {
        cwd: repo,
        stdio: "ignore"
      });

      expect(() =>
        execFileSync("/bin/sh", ["-c", localSetupCommand], { cwd: worktree, stdio: "ignore" })
      ).not.toThrow();

      mkdirSync(resolve(repo, ".kanna"));
      writeFileSync(localHook, `#!/bin/sh\nprintf ran > "$PWD/hook-ran"\nexit 23\n`);
      expect(() =>
        execFileSync("/bin/sh", ["-c", localSetupCommand], { cwd: worktree, stdio: "ignore" })
      ).not.toThrow();
      expect(existsSync(marker)).toBe(false);

      chmodSync(localHook, 0o755);
      expect(() =>
        execFileSync("/bin/sh", ["-c", localSetupCommand], { cwd: worktree, stdio: "ignore" })
      ).not.toThrow();
      expect(readFileSync(marker, "utf8")).toBe("ran");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("keeps external build storage isolated and repairs an unmounted-volume link", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "kanna-external-build-"));
    const repo = resolve(fixture, "repo");
    const volume = resolve(fixture, "external-volume");
    const unmountedVolume = resolve(fixture, "external-volume-unmounted");
    const localHook = resolve(fixture, "setup.local.sh");
    const localBuild = resolve(repo, ".build");
    const targetRecord = resolve(repo, ".kanna-external-build-target");
    const externalBuild = resolve(volume, "kanna-builds", "kanna", "repo");

    try {
      mkdirSync(repo);
      mkdirSync(volume);
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo, stdio: "ignore" });
      mkdirSync(localBuild);
      writeFileSync(resolve(localBuild, "artifact.txt"), "keep me\n");

      const template = readFileSync(resolve(root, ".kanna", "setup.local.sh.example"), "utf8");
      writeFileSync(
        localHook,
        template.replace(
          'external_volume="/path/to/external-volume"',
          `external_volume="${volume}"`
        )
      );

      execFileSync("/bin/sh", [localHook], { cwd: repo, stdio: "ignore" });
      expect(lstatSync(localBuild).isSymbolicLink()).toBe(true);
      expect(readlinkSync(localBuild)).toBe(externalBuild);
      expect(readFileSync(targetRecord, "utf8")).toBe(`${externalBuild}\n`);
      expect(readFileSync(resolve(externalBuild, "artifact.txt"), "utf8")).toBe("keep me\n");

      renameSync(volume, unmountedVolume);
      execFileSync("/bin/sh", [localHook], { cwd: repo, stdio: "ignore" });
      expect(lstatSync(localBuild).isDirectory()).toBe(true);
      expect(lstatSync(localBuild).isSymbolicLink()).toBe(false);
      expect(readFileSync(targetRecord, "utf8")).toBe(`${externalBuild}\n`);
      expect(
        readFileSync(
          resolve(unmountedVolume, "kanna-builds", "kanna", "repo", "artifact.txt"),
          "utf8"
        )
      ).toBe("keep me\n");

      renameSync(unmountedVolume, volume);
      execFileSync("/bin/sh", [localHook], { cwd: repo, stdio: "ignore" });
      expect(lstatSync(localBuild).isSymbolicLink()).toBe(true);
      expect(readlinkSync(localBuild)).toBe(externalBuild);
      expect(readFileSync(targetRecord, "utf8")).toBe(`${externalBuild}\n`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("keeps teardown on private workspace cleanup", () => {
    expect(config.teardown).toEqual(["./kd dev down --kill-daemon", "./kd clean --all"]);
  });

  it("keeps the compiler cache out of release configuration", () => {
    expect(JSON.stringify(config)).not.toContain("release ship");
    const releaseSource = readFileSync(resolve(root, "tools/kd/src/runtime/release.ts"), "utf8");
    expect(releaseSource).not.toContain("rust-cache");
    expect(releaseSource).not.toContain("kache");
  });
});

/**
 * A forked stage worktree runs the *origin/main* setup list against the *branch's*
 * kd, so config and code cross the stage boundary independently. Dropping a
 * command this kd no longer accepts fails the stage transition before the agent
 * ever starts — which is exactly how `rust-cache warm` broke this branch.
 */
describe("stage setup commands across the config/code boundary", () => {
  const originMain = readOriginMainConfig();
  const itWithOriginMain = originMain ? it : it.skip;

  itWithOriginMain("resolves every kd command in origin/main's config", () => {
    const commands = kdCommands(originMain!);
    expect(commands.length).toBeGreaterThan(0);
    for (const argv of commands) {
      expect(() => parseCliArgs(argv), `origin/main setup runs: ./kd ${argv.join(" ")}`).not.toThrow();
    }
  });

  it("resolves every kd command in this branch's config", () => {
    for (const argv of kdCommands(JSON.parse(
      readFileSync(resolve(root, ".kanna/config.json"), "utf8")
    ) as KannaRepoConfig)) {
      expect(() => parseCliArgs(argv), `./kd ${argv.join(" ")}`).not.toThrow();
    }
  });

  it("routes both cache command spellings to the same task", () => {
    const install = parseCliArgs(["rust-cache", "install"]);
    expect(install).toEqual({ taskId: "rust-cache.install", input: {} });
    expect(parseCliArgs(["rust-cache", "warm"])).toEqual(install);
  });
});
