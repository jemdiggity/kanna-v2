import { describe, expect, it } from "vitest";
import { buildRustTestCommands, executeRustTests } from "../src/runtime/rust-test";
import type { CommandRunner } from "../src/runtime/process";

describe("Rust test orchestration", () => {
  it("checks generated agent protocol types before Tauri inputs and Rust tests", () => {
    expect(buildRustTestCommands()).toEqual([
      {
        name: "agent-protocol",
        command: "./scripts/check-agent-protocol-types.sh",
        args: [],
      },
      { name: "frontend", command: "pnpm", args: ["--dir", "apps/desktop", "build"] },
      { name: "sidecars", command: "./kd", args: ["build", "sidecars"] },
      { name: "workspace", command: "cargo", args: ["test", "--workspace", "--exclude", "kanna-daemon"] },
      { name: "daemon", command: "cargo", args: ["test", "-p", "kanna-daemon", "--", "--test-threads=1"] },
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

  it("stops after an intermediate failure and retains prior and failed results", async () => {
    const planned = buildRustTestCommands();
    const outcomes = [
      { exitCode: 0, stdout: "agent protocol types passed", stderr: "" },
      { exitCode: 0, stdout: "frontend passed", stderr: "" },
      { exitCode: 0, stdout: "sidecars passed", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "workspace failed" },
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
      message: "workspace failed",
      data: {
        commands: planned.slice(0, 4).map((command, index) => ({
          ...command,
          ...outcomes[index],
        })),
      },
    });
  });

  it("begins before canonical Rust tests and records all layouts only after success", async () => {
    const order: string[] = [];
    const result = await executeRustTests({
      repoRoot: "/repo",
      env: {},
      runner: {
        async run(command) {
          order.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      },
      cache: {
        async begin() {
          order.push("cache.begin");
        },
        async record() {
          order.push("cache.record.all");
        }
      }
    });

    expect(result.ok).toBe(true);
    expect(order[0]).toBe("cache.begin");
    expect(order.at(-1)).toBe("cache.record.all");
  });

  it("leaves the marker cleared when a canonical Rust test fails", async () => {
    const order: string[] = [];
    const result = await executeRustTests({
      repoRoot: "/repo",
      env: {},
      runner: {
        async run(command) {
          order.push(command);
          return { exitCode: 1, stdout: "", stderr: "failed" };
        }
      },
      cache: {
        async begin() {
          order.push("cache.begin");
        },
        async record() {
          order.push("cache.record.all");
        }
      }
    });

    expect(result.ok).toBe(false);
    expect(order).not.toContain("cache.record.all");
  });

  it("does not mutate Cargo state when donor eligibility cannot be revoked", async () => {
    const commands: string[] = [];

    await expect(
      executeRustTests({
        repoRoot: "/repo",
        env: {},
        runner: {
          async run(command) {
            commands.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        },
        cache: {
          async begin() {
            throw new Error("marker is not removable");
          },
          async record() {}
        }
      })
    ).rejects.toThrow("marker is not removable");
    expect(commands).toEqual([]);
  });
});
