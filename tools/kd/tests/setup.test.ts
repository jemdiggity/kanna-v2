import { describe, expect, it } from "vitest";
import { checkSetupPrerequisites } from "../src/runtime/setup";
import type { CommandResult, CommandRunner } from "../src/runtime/process";

function recordingRunner(results: Record<string, CommandResult>): { runner: CommandRunner; commands: string[] } {
  const commands: string[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      commands.push([command, ...args].join(" "));
      return results[command] ?? { exitCode: 0, stdout: `${command} ok`, stderr: "" };
    }
  };
  return { runner, commands };
}

describe("checkSetupPrerequisites", () => {
  it("checks the Xcode command line tools on macOS", async () => {
    const { runner, commands } = recordingRunner({});
    const result = await checkSetupPrerequisites(runner, "/repo", "darwin");

    expect(commands).toContain("xcode-select -p");
    expect(result.checks.map((check) => check.name)).toContain("xcode");
    expect(result.checks.some((check) => check.name === "webkitgtk")).toBe(false);
  });

  it("checks the compiler and WebKitGTK development packages on Linux", async () => {
    const { runner, commands } = recordingRunner({});
    const result = await checkSetupPrerequisites(runner, "/repo", "linux");

    expect(commands).not.toContain("xcode-select -p");
    expect(commands).toContain("cc --version");
    expect(commands).toContain("pkg-config --exists gtk+-3.0 webkit2gtk-4.1");
    const names = result.checks.map((check) => check.name);
    expect(names).toContain("cc");
    expect(names).toContain("webkitgtk");
    expect(names).not.toContain("xcode");
  });

  it("reports the missing GTK packages with an install hint on Linux", async () => {
    const { runner } = recordingRunner({
      "pkg-config": { exitCode: 1, stdout: "", stderr: "" }
    });
    const result = await checkSetupPrerequisites(runner, "/repo", "linux");

    expect(result.ok).toBe(false);
    const webkit = result.checks.find((check) => check.name === "webkitgtk");
    expect(webkit?.ok).toBe(false);
    expect(webkit?.message).toContain("libwebkit2gtk-4.1-dev");
  });

  it("keeps checking the shared toolchain on both platforms", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { runner } = recordingRunner({});
      const result = await checkSetupPrerequisites(runner, "/repo", platform);
      const names = result.checks.map((check) => check.name);
      for (const shared of ["rust", "cargo", "node", "pnpm", "bazel", "git", "zig", "tmux", "node_modules"]) {
        expect(names).toContain(shared);
      }
    }
  });
});
