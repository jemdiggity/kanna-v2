import { describe, expect, it } from "vitest";
import { executeLocalCi } from "../src/runtime/local-ci";
import type { CommandRunner } from "../src/runtime/process";

describe("local CI", () => {
  it("runs bounded, canonical verification phases sequentially", async () => {
    const calls: Array<{ command: string; args: string[]; streamOutput?: boolean }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, streamOutput: options?.streamOutput });
        return { exitCode: 0, stdout: `${command} passed`, stderr: "" };
      },
    };

    const result = await executeLocalCi({
      repoRoot: "/repo",
      env: { PATH: "/usr/bin" },
      runner,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { command: "pnpm", args: ["test"], streamOutput: true },
      { command: "./kd", args: ["test", "rust"], streamOutput: true },
      { command: "./kd", args: ["test", "remote-e2e"], streamOutput: true },
    ]);
  });

  it("stops after the first failed phase", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push([command, ...args].join(" "));
        return calls.length === 2
          ? { exitCode: 9, stdout: "", stderr: "rust failed" }
          : { exitCode: 0, stdout: "passed", stderr: "" };
      },
    };

    const result = await executeLocalCi({
      repoRoot: "/repo",
      env: {},
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Rust");
    expect(calls).toEqual(["pnpm test", "./kd test rust"]);
  });
});
