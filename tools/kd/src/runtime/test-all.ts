import type { CommandResult, CommandRunner } from "./process";

export interface TestAllCommand {
  lane: "workspace" | "bazel-build-script" | "rust" | "desktop-mock-e2e";
  command: "pnpm" | "bazel" | "./kd";
  args: string[];
}

interface ExecutedTestAllCommand extends TestAllCommand, CommandResult {}

export function buildTestAllCommands(): TestAllCommand[] {
  return [
    { lane: "workspace", command: "pnpm", args: ["test"] },
    {
      lane: "bazel-build-script",
      command: "bazel",
      args: ["build", "//crates/daemon:daemon_build_script"],
    },
    { lane: "rust", command: "./kd", args: ["test", "rust"] },
    // The desktop mock E2E suite drives the real app through WebDriver, so a
    // bare `vitest run` cannot collect it (`apps/desktop/vitest.config.ts`
    // excludes `tests/e2e/mock/**`) and it never ran inside the workspace lane.
    // Left out of every gate, it rotted until a third of the suite was red.
    { lane: "desktop-mock-e2e", command: "./kd", args: ["test", "desktop-mock-e2e"] },
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
