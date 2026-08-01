import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli";

interface KannaRepoConfig {
  setup?: string[];
  teardown?: string[];
}

const root = resolve(import.meta.dirname, "../../..");

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
    expect(config.setup).toEqual(["pnpm install", "./kd env sync", "./kd rust-cache warm"]);
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
