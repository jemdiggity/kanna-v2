import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRustCacheEvent,
  beginRustCacheBuild,
  ensureKanacheBinary,
  getRustCacheStatus,
  recordRustCache,
  readRustCacheEvents,
  warmRustCache,
  withRustCacheBuild,
  withRustCacheLifecycleLock
} from "../src/runtime/rust-cache";
import type { RustCacheRuntimeInput } from "../src/runtime/rust-cache";
import {
  KANACHE_REPOSITORY,
  KANACHE_REVISION,
  resolveKanachePaths
} from "../src/runtime/rust-cache-policy";
import type { CommandRunner } from "../src/runtime/process";

function fakeRuntimeInput(input: {
  calls?: string[];
  clean?: boolean;
  host?: string;
} = {}): RustCacheRuntimeInput {
  const root = mkdtempSync(join(tmpdir(), "kd-kanache-lifecycle-"));
  const home = join(root, "home");
  const repoRoot = join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const binary = resolveKanachePaths(home).binary;
  mkdirSync(join(binary, ".."), { recursive: true });
  writeFileSync(binary, "fake");

  return {
    repoRoot,
    homeDir: home,
    env: {},
    commit: "abc",
    runner: {
      async run(command, args) {
        const renderedCommand = command === binary ? "kanache" : command;
        input.calls?.push(`${renderedCommand} ${args.join(" ")}`);
        if (command === "git" && args.includes("status")) {
          return {
            exitCode: 0,
            stdout: input.clean === false ? " M Cargo.toml\n" : "",
            stderr: ""
          };
        }
        if (command === "git" && args.at(-1) === "--git-common-dir") {
          return { exitCode: 0, stdout: join(root, ".git") + "\n", stderr: "" };
        }
        if (command === "rustc") {
          return {
            exitCode: 0,
            stdout: `host: ${input.host ?? "aarch64-apple-darwin"}\n`,
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
  };
}

describe("Kanache runtime", () => {
  it("installs the pinned locked revision into an atomic version root", async () => {
    const home = mkdtempSync(join(tmpdir(), "kd-kanache-home-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "cargo") {
          const root = args[args.indexOf("--root") + 1]!;
          mkdirSync(join(root, "bin"), { recursive: true });
          writeFileSync(join(root, "bin", "kanache"), "#!/bin/sh\n");
          chmodSync(join(root, "bin", "kanache"), 0o755);
        }
        return {
          exitCode: 0,
          stdout: command === "cargo" ? "" : "kanache 0.1.0\n",
          stderr: ""
        };
      }
    };

    const binary = await ensureKanacheBinary({ homeDir: home, runner });

    expect(binary).toBe(resolveKanachePaths(home).binary);
    expect(existsSync(binary)).toBe(true);
    expect(calls[0]).toMatchObject({
      command: "cargo",
      args: expect.arrayContaining([
        "install",
        "--git",
        KANACHE_REPOSITORY,
        "--rev",
        KANACHE_REVISION,
        "--locked",
        "--root"
      ])
    });
    expect(calls[1]?.command).toContain(`.install-${KANACHE_REVISION}-`);
    expect(calls[1]?.args).toEqual(["--version"]);
  });

  it("writes JSONL and ignores malformed historical lines", () => {
    const home = mkdtempSync(join(tmpdir(), "kd-kanache-events-"));
    appendRustCacheEvent(home, {
      timestamp: "2026-07-20T00:00:00.000Z",
      repository: "repo",
      commit: "abc",
      destination: "/repo/wt",
      layouts: ["host"],
      outcome: "miss",
      category: "no-donor",
      wallMs: 3,
      allocationDeltaBytes: 0
    });
    appendFileSync(resolveKanachePaths(home).events, "not json\n");
    const warnings: string[] = [];
    expect(
      readRustCacheEvents(home, "repo", 10, (warning) => warnings.push(warning))
    ).toHaveLength(1);
    expect(warnings).toEqual(["Ignored malformed Kanache event log line 2."]);
  });

  it("clears donor eligibility locally even when caching is disabled", async () => {
    const cache = fakeRuntimeInput();
    const marker = join(cache.repoRoot, ".build", "cargo-build", ".kanache-success");
    mkdirSync(join(marker, ".."), { recursive: true });
    writeFileSync(marker, "old-success");
    cache.env.KANNA_RUST_CACHE = "off";

    const result = await beginRustCacheBuild(cache);

    expect(result).toMatchObject({ outcome: "record-miss", category: "disabled" });
    expect(existsSync(marker)).toBe(false);
  });

  it("tries ranked exact-HEAD donors until Kanache publishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "kd-kanache-warm-"));
    const home = join(root, "home");
    const current = join(root, "current");
    const first = join(root, "first");
    const second = join(root, "second");
    for (const path of [current, first, second]) {
      mkdirSync(join(path, ".build", "cargo-build"), { recursive: true });
    }
    rmSync(join(current, ".build"), { recursive: true, force: true });

    const binary = resolveKanachePaths(home).binary;
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "fake");
    for (const [path, created] of [
      [first, 20],
      [second, 10]
    ] as const) {
      writeFileSync(
        join(path, ".build/cargo-build/.kanache-manifest.json"),
        JSON.stringify({
          profiles: ["dev"],
          targets: ["host", "aarch64-apple-darwin"],
          extra_inputs: [],
          created_unix_nanos: created
        })
      );
      writeFileSync(join(path, ".build/cargo-build/.kanache-success"), "marker");
    }

    const warmCalls: string[][] = [];
    const fullCommit = "abc1234000000000000000000000000000000000";
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "git" && args.join(" ") === "worktree list --porcelain") {
          return {
            exitCode: 0,
            stdout: [
              `worktree ${current}`,
              `HEAD ${fullCommit}`,
              "",
              `worktree ${first}`,
              `HEAD ${fullCommit}`,
              "",
              `worktree ${second}`,
              `HEAD ${fullCommit}`,
              ""
            ].join("\n"),
            stderr: ""
          };
        }
        if (command === "git" && args.at(-1) === "--git-common-dir") {
          return { exitCode: 0, stdout: join(root, ".git") + "\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return { exitCode: 0, stdout: `${fullCommit}\n`, stderr: "" };
        }
        if (command === "rustc") {
          return { exitCode: 0, stdout: "host: aarch64-apple-darwin\n", stderr: "" };
        }
        if (command === binary) {
          warmCalls.push(args);
          if (warmCalls.length === 1) {
            return { exitCode: 1, stdout: "", stderr: "donor dirty" };
          }
          mkdirSync(join(current, ".build", "cargo-build"), { recursive: true });
          return { exitCode: 0, stdout: "warmed files=100 elapsed_ms=7\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      }
    };

    const result = await warmRustCache({
      repoRoot: current,
      homeDir: home,
      env: {},
      runner,
      commit: "abc1234"
    });

    expect(result).toMatchObject({ ok: true, outcome: "hit", donor: second });
    expect(warmCalls).toHaveLength(2);
  });

  it("cold-falls back without installing or deleting an existing destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "kd-kanache-existing-"));
    mkdirSync(join(root, ".build", "cargo-build"), { recursive: true });
    writeFileSync(join(root, ".build", "cargo-build", "keep"), "user data");
    const calls: string[] = [];

    const result = await warmRustCache({
      repoRoot: root,
      homeDir: join(root, "home"),
      env: {},
      commit: "abc",
      runner: {
        async run(command) {
          calls.push(command);
          return { exitCode: 1, stdout: "", stderr: "" };
        }
      }
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "miss",
      category: "destination-exists"
    });
    expect(readFileSync(join(root, ".build", "cargo-build", "keep"), "utf8")).toBe(
      "user data"
    );
    expect(calls).toEqual([]);
    expect(
      readFileSync(resolveKanachePaths(join(root, "home")).events, "utf8")
    ).toContain('"category":"destination-exists"');
  });

  it("brackets a successful bounded build and records the narrow layout", async () => {
    const calls: string[] = [];
    const cache = fakeRuntimeInput({ calls, clean: true, host: "aarch64-apple-darwin" });
    const value = await withRustCacheBuild(
      cache,
      "sidecars",
      async () => {
        calls.push("BUILD");
        return { ok: true };
      },
      (result) => result.ok
    );

    expect(value).toEqual({ ok: true });
    expect(calls).toEqual([
      `kanache manifest begin ${cache.repoRoot}`,
      "BUILD",
      "git status --porcelain=v1 --untracked-files=all",
      "rustc -vV",
      `kanache manifest record ${cache.repoRoot} --profile dev --target aarch64-apple-darwin`
    ]);
  });

  it("does not record a failed bounded build", async () => {
    const calls: string[] = [];
    const result = await withRustCacheBuild(
      fakeRuntimeInput({ calls, clean: true }),
      "all",
      async () => {
        calls.push("BUILD");
        return { ok: false };
      },
      (value) => value.ok
    );

    expect(result).toEqual({ ok: false });
    expect(calls.filter((call) => call.includes("manifest record"))).toEqual([]);
  });

  it("records why a dirty checkout was not published as a donor", async () => {
    const cache = fakeRuntimeInput({ clean: false });

    const result = await recordRustCache(cache, "all");

    expect(result).toMatchObject({ outcome: "record-miss", category: "dirty-worktree" });
    expect(readFileSync(resolveKanachePaths(cache.homeDir).events, "utf8")).toContain(
      '"category":"dirty-worktree"'
    );
  });

  it("status reports enablement, pin, current manifest, and recent events", async () => {
    const status = await getRustCacheStatus(fakeRuntimeInput({ clean: true }));

    expect(status).toMatchObject({ enabled: true, revision: KANACHE_REVISION });
    expect(status).toHaveProperty("binary");
    expect(status).toHaveProperty("events");
  });

  it("serializes bounded builds while allowing the owning process to reenter", async () => {
    const cache = fakeRuntimeInput();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withRustCacheLifecycleLock(
      cache,
      async (ownerEnv) => {
        order.push("first-enter");
        await withRustCacheLifecycleLock(
          { ...cache, env: ownerEnv },
          async () => order.push("nested-enter"),
          { pollMs: 5, timeoutMs: 500 }
        );
        await firstMayFinish;
        order.push("first-exit");
      },
      { pollMs: 5, timeoutMs: 500 }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = withRustCacheLifecycleLock(
      cache,
      async () => order.push("second-enter"),
      { pollMs: 5, timeoutMs: 500 }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-enter", "nested-enter"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first-enter",
      "nested-enter",
      "first-exit",
      "second-enter"
    ]);
  });

  it("fails closed instead of deleting an unverifiable owner file", async () => {
    const cache = fakeRuntimeInput();
    const lockDirectory = join(cache.repoRoot, ".build", ".kanache-lifecycle-lock");
    const ownerFile = join(lockDirectory, "owner.json");
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(ownerFile, "partially-written-owner");
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockDirectory, old, old);

    await expect(
      withRustCacheLifecycleLock(cache, async () => undefined, {
        pollMs: 5,
        timeoutMs: 20
      })
    ).rejects.toThrow("timed out waiting");
    expect(readFileSync(ownerFile, "utf8")).toBe("partially-written-owner");
  });

  it("fails closed instead of recovering an ownerless lock directory", async () => {
    const cache = fakeRuntimeInput();
    const lockDirectory = join(cache.repoRoot, ".build", ".kanache-lifecycle-lock");
    mkdirSync(lockDirectory, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockDirectory, old, old);

    await expect(
      withRustCacheLifecycleLock(cache, async () => undefined, {
        pollMs: 5,
        timeoutMs: 20
      })
    ).rejects.toThrow("timed out waiting");
    expect(existsSync(lockDirectory)).toBe(true);
  });
});
