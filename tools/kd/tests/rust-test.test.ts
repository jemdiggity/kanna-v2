import { describe, expect, it } from "vitest";
import { buildRustTestCommands, executeRustTests } from "../src/runtime/rust-test";
import type { CommandRunner } from "../src/runtime/process";

describe("Rust test orchestration", () => {
  it("prepares Tauri inputs before workspace and serialized daemon tests", () => {
    expect(buildRustTestCommands()).toEqual([
      { name: "frontend", command: "pnpm", args: ["--dir", "apps/desktop", "build"] },
      { name: "sidecars", command: "./kd", args: ["build", "sidecars"] },
      { name: "workspace", command: "cargo", args: ["test", "--workspace", "--exclude", "kanna-daemon"] },
      { name: "daemon", command: "cargo", args: ["test", "-p", "kanna-daemon", "--", "--test-threads=1"] },
    ]);
  });

  it("stops after the first failed prerequisite", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push(`${command} ${args.join(" ")}`);
        expect(options?.streamOutput).toBe(true);
        return { exitCode: 1, stdout: "", stderr: "frontend failed" };
      },
    };

    const result = await executeRustTests({ repoRoot: "/repo", env: {}, runner });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("frontend failed");
    expect(calls).toEqual(["pnpm --dir apps/desktop build"]);
  });
});
