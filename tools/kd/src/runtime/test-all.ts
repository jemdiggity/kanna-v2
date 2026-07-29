import type { CommandResult, CommandRunner } from "./process";

export interface TestAllCommand {
  lane: "workspace" | "rust";
  command: "pnpm" | "./kd";
  args: string[];
}

interface ExecutedTestAllCommand extends TestAllCommand, CommandResult {}

export function buildTestAllCommands(): TestAllCommand[] {
  return [
    { lane: "workspace", command: "pnpm", args: ["test"] },
    { lane: "rust", command: "./kd", args: ["test", "rust"] },
  ];
}

export async function executeTestAll(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}) {
  const commands: ExecutedTestAllCommand[] = [];
  for (const command of buildTestAllCommands()) {
    const result = await input.runner.run(command.command, command.args, {
      cwd: input.repoRoot,
      env: input.env,
      streamOutput: true,
    });
    commands.push({ ...command, ...result });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: `${command.lane} lane failed with exit code ${result.exitCode}.`,
        data: { commands },
      };
    }
  }
  return {
    ok: true,
    message: "Canonical local verification passed.",
    data: { commands },
  };
}
