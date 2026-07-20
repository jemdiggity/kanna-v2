import type { CommandResult, CommandRunner } from "./process";

export interface RustTestCommand {
  name: "agent-protocol" | "frontend" | "sidecars" | "workspace" | "daemon";
  command: "./scripts/check-agent-protocol-types.sh" | "pnpm" | "./kd" | "cargo";
  args: string[];
}

interface ExecutedRustTestCommand extends RustTestCommand, CommandResult {}

export interface RustTestCacheLifecycle {
  begin(): Promise<void>;
  record(): Promise<void>;
}

export function buildRustTestCommands(): RustTestCommand[] {
  return [
    {
      name: "agent-protocol",
      command: "./scripts/check-agent-protocol-types.sh",
      args: [],
    },
    { name: "frontend", command: "pnpm", args: ["--dir", "apps/desktop", "build"] },
    { name: "sidecars", command: "./kd", args: ["build", "sidecars"] },
    { name: "workspace", command: "cargo", args: ["test", "--workspace", "--exclude", "kanna-daemon"] },
    { name: "daemon", command: "cargo", args: ["test", "-p", "kanna-daemon", "--", "--test-threads=1"] },
  ];
}

export async function executeRustTests(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  cache?: RustTestCacheLifecycle;
}) {
  await input.cache?.begin();
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
  try {
    await input.cache?.record();
  } catch {
    // Cache maintenance must never replace the canonical test result.
  }
  return { ok: true, message: "Canonical Rust tests passed.", data: { commands } };
}
