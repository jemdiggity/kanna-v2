import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRustCacheEvent,
  ensureKanacheBinary,
  readRustCacheEvents
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
});
