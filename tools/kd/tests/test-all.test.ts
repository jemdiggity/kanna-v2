import { describe, expect, it } from "vitest";
import { buildTestAllCommands, executeTestAll } from "../src/runtime/test-all";
import type { CommandRunner } from "../src/runtime/process";

describe("canonical local verification orchestration", () => {
  it("plans the workspace, Bazel build-script, Rust and desktop mock E2E lanes in order", () => {
    expect(buildTestAllCommands()).toEqual([
      { lane: "workspace", command: "pnpm", args: ["test"] },
      {
        lane: "bazel-build-script",
        command: "bazel",
        args: ["build", "//crates/daemon:daemon_build_script"],
      },
      { lane: "rust", command: "./kd", args: ["test", "rust"] },
      {
        lane: "desktop-mock-e2e",
        command: "./kd",
        args: ["test", "desktop-mock-e2e"],
      },
    ]);
  });

  it("executes every lane in order with streamed output", async () => {
    const planned = buildTestAllCommands();
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

    const result = await executeTestAll({ repoRoot: "/repo", env, runner });

    expect(calls).toEqual(planned.map(({ command, args }) => ({ command, args })));
    expect(result).toEqual({
      ok: true,
      message: "Canonical local verification passed.",
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

  it("stops before the later lanes when the workspace lane fails", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 2, stdout: "", stderr: "workspace failed" };
      },
    };

    const result = await executeTestAll({ repoRoot: "/repo", env: {}, runner });

    expect(calls).toEqual(["pnpm test"]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("workspace lane failed with exit code 2.");
  });

  it("reports the Bazel lane and exit code after the workspace lane passes", async () => {
    const outcomes = [
      { exitCode: 0, stdout: "workspace passed", stderr: "" },
      { exitCode: 7, stdout: "", stderr: "bazel failed" },
    ];
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return outcomes[calls.length - 1];
      },
    };

    const result = await executeTestAll({ repoRoot: "/repo", env: {}, runner });

    expect(calls).toEqual([
      "pnpm test",
      "bazel build //crates/daemon:daemon_build_script",
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("bazel-build-script lane failed with exit code 7.");
  });

  it("reports the Rust lane after the workspace and Bazel lanes pass", async () => {
    const outcomes = [
      { exitCode: 0, stdout: "workspace passed", stderr: "" },
      { exitCode: 0, stdout: "bazel passed", stderr: "" },
      { exitCode: 9, stdout: "", stderr: "rust failed" },
    ];
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return outcomes[calls.length - 1];
      },
    };

    const result = await executeTestAll({ repoRoot: "/repo", env: {}, runner });

    expect(calls).toEqual([
      "pnpm test",
      "bazel build //crates/daemon:daemon_build_script",
      "./kd test rust",
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("rust lane failed with exit code 9.");
  });

  it("reports the desktop mock E2E lane after every other lane passes", async () => {
    const outcomes = [
      { exitCode: 0, stdout: "workspace passed", stderr: "" },
      { exitCode: 0, stdout: "bazel passed", stderr: "" },
      { exitCode: 0, stdout: "rust passed", stderr: "" },
      { exitCode: 3, stdout: "", stderr: "mock e2e failed" },
    ];
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return outcomes[calls.length - 1];
      },
    };

    const result = await executeTestAll({ repoRoot: "/repo", env: {}, runner });

    expect(calls).toEqual([
      "pnpm test",
      "bazel build //crates/daemon:daemon_build_script",
      "./kd test rust",
      "./kd test desktop-mock-e2e",
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("desktop-mock-e2e lane failed with exit code 3.");
  });
});
