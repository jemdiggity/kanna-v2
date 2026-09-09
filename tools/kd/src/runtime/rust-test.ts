import type { CommandResult, CommandRunner } from "./process";

export interface RustTestCommand {
  name: "agent-protocol" | "frontend" | "sidecars" | "clippy" | "workspace" | "daemon";
  command: "./scripts/check-agent-protocol-types.sh" | "pnpm" | "./kd" | "cargo";
  args: string[];
}

interface ExecutedRustTestCommand extends RustTestCommand, CommandResult {}

/**
 * The lanes `./kd test rust` runs.
 *
 * Off macOS the desktop crate is excluded and its frontend build skipped.
 * That is not a lowered bar: the Tauri app is not part of the headless
 * worker's surface, and Phase 2 is where the GUI's own lane belongs. The
 * sidecars, the daemon and the server are still built and tested in full.
 */
export function buildRustTestCommands(
  platform: NodeJS.Platform = process.platform,
): RustTestCommand[] {
  const headless = platform !== "darwin";
  const commands: RustTestCommand[] = [
    {
      name: "agent-protocol",
      command: "./scripts/check-agent-protocol-types.sh",
      args: [],
    },
  ];
  if (!headless) {
    commands.push({ name: "frontend", command: "pnpm", args: ["--dir", "apps/desktop", "build"] });
  }
  commands.push(
    { name: "sidecars", command: "./kd", args: ["build", "sidecars"] },
    {
      name: "clippy",
      command: "cargo",
      args: [
        "clippy",
        "--workspace",
        "--all-targets",
        ...(headless ? ["--exclude", "kanna-desktop"] : []),
        "--",
        "-D",
        "warnings",
      ],
    },
    {
      name: "workspace",
      command: "cargo",
      args: [
        "test",
        "--workspace",
        "--exclude",
        "kanna-daemon",
        ...(headless ? ["--exclude", "kanna-desktop"] : []),
      ],
    },
    { name: "daemon", command: "cargo", args: ["test", "-p", "kanna-daemon", "--", "--test-threads=1"] },
  );
  return commands;
}

export async function executeRustTests(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}) {
  const commands: ExecutedRustTestCommand[] = [];
  for (const command of buildRustTestCommands()) {
    const result = await input.runner.run(command.command, command.args, {
      cwd: input.repoRoot,
      env: input.env,
      streamOutput: true,
    });
    commands.push({ ...command, ...result });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: result.stderr || result.stdout || `${command.name} Rust tests failed.`,
        data: { commands },
      };
    }
  }
  return { ok: true, message: "Canonical Rust tests passed.", data: { commands } };
}
