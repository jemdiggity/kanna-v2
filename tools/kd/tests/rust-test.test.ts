import { describe, expect, it } from "vitest";
import { buildRustTestCommands, executeRustTests } from "../src/runtime/rust-test";
import type { CommandRunner } from "../src/runtime/process";

describe("Rust test orchestration", () => {
  it("checks generated agent protocol types before Tauri inputs and Rust tests", () => {
    expect(buildRustTestCommands("darwin")).toEqual([
      {
        name: "agent-protocol",
        command: "./scripts/check-agent-protocol-types.sh",
        args: [],
      },
      { name: "frontend", command: "pnpm", args: ["--dir", "apps/desktop", "build"] },
      { name: "sidecars", command: "./kd", args: ["build", "sidecars"] },
      { name: "clippy", command: "cargo", args: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"] },
      { name: "workspace", command: "cargo", args: ["test", "--workspace", "--exclude", "kanna-daemon"] },
      { name: "daemon", command: "cargo", args: ["test", "-p", "kanna-daemon", "--", "--test-threads=1"] },
    ]);
  });

  /**
   * Off macOS there is no Tauri app to build or test yet, but the sidecars,
   * the daemon and the server are still covered in full — the exclusions are
   * the desktop crate and its frontend, nothing else.
   */
  it("skips the desktop crate and its frontend build on a headless platform", () => {
    const planned = buildRustTestCommands("linux");

    expect(planned.map((command) => command.name)).toEqual([
      "agent-protocol",
      "sidecars",
      "clippy",
      "workspace",
      "daemon",
    ]);
    expect(planned.find((command) => command.name === "clippy")?.args).toEqual([
      "clippy",
      "--workspace",
      "--all-targets",
      "--exclude",
      "kanna-desktop",
      "--",
      "-D",
      "warnings",
    ]);
    expect(planned.find((command) => command.name === "workspace")?.args).toEqual([
      "test",
      "--workspace",
      "--exclude",
      "kanna-daemon",
      "--exclude",
      "kanna-desktop",
    ]);
    expect(planned.find((command) => command.name === "daemon")?.args).toEqual([
      "test",
      "-p",
      "kanna-daemon",
      "--",
      "--test-threads=1",
    ]);
  });

  it("stops after the first failed prerequisite", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args });
        expect(options?.streamOutput).toBe(true);
        return { exitCode: 1, stdout: "", stderr: "agent protocol types are stale" };
      },
    };

    const result = await executeRustTests({ repoRoot: "/repo", env: {}, runner });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("agent protocol types are stale");
    expect(calls).toEqual([
      { command: "./scripts/check-agent-protocol-types.sh", args: [] },
    ]);
  });

  it("executes every command in order and returns the accumulated results", async () => {
    const planned = buildRustTestCommands();
    const env: NodeJS.ProcessEnv = { KANNA_DEV_PORT: "1421" };
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        const index = calls.length;
        calls.push({ command, args });
        expect(options?.cwd).toBe("/repo");
        expect(options?.env).toBe(env);
        expect(options?.streamOutput).toBe(true);
        return { exitCode: 0, stdout: `stdout-${index}`, stderr: "" };
      },
    };

    const result = await executeRustTests({ repoRoot: "/repo", env, runner });

    expect(calls).toEqual(planned.map(({ command, args }) => ({ command, args })));
    expect(result).toEqual({
      ok: true,
      message: "Canonical Rust tests passed.",
      data: {
        commands: planned.map((command, index) => ({
          ...command,
          exitCode: 0,
          stdout: `stdout-${index}`,
          stderr: "",
        })),
      },
    });
  });

  it("stops on clippy warnings before running test binaries and retains prior results", async () => {
    const planned = buildRustTestCommands();
    const outcomes = [
      { exitCode: 0, stdout: "agent protocol types passed", stderr: "" },
      { exitCode: 0, stdout: "frontend passed", stderr: "" },
      { exitCode: 0, stdout: "sidecars passed", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "clippy failed" },
    ];
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return outcomes[calls.length - 1];
      },
    };

    const result = await executeRustTests({ repoRoot: "/repo", env: {}, runner });

    expect(calls).toEqual(
      planned.slice(0, 4).map(({ command, args }) => `${command} ${args.join(" ")}`),
    );
    expect(result).toEqual({
      ok: false,
      message: "clippy failed",
      data: {
        commands: planned.slice(0, 4).map((command, index) => ({
          ...command,
          ...outcomes[index],
        })),
      },
    });
  });
});
