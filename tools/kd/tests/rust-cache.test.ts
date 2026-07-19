import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRustCacheEvent,
  ensureKanacheBinary,
  readRustCacheEvents,
  warmRustCache
} from "../src/runtime/rust-cache";
import {
  KANACHE_REPOSITORY,
  KANACHE_REVISION,
  resolveKanachePaths
} from "../src/runtime/rust-cache-policy";
import type { CommandRunner } from "../src/runtime/process";

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
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "git" && args.join(" ") === "worktree list --porcelain") {
          return {
            exitCode: 0,
            stdout: [
              `worktree ${current}`,
              "HEAD abc",
              "",
              `worktree ${first}`,
              "HEAD abc",
              "",
              `worktree ${second}`,
              "HEAD abc",
              ""
            ].join("\n"),
            stderr: ""
          };
        }
        if (command === "git" && args.at(-1) === "--git-common-dir") {
          return { exitCode: 0, stdout: join(root, ".git") + "\n", stderr: "" };
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
      commit: "abc"
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
  });
});
