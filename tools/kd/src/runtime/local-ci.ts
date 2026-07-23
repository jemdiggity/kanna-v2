import type { CommandRunner } from "./process";

export interface LocalCiInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

interface LocalCiStep {
  name: string;
  command: string;
  args: string[];
}

const LOCAL_CI_STEPS: LocalCiStep[] = [
  { name: "JavaScript and TypeScript", command: "pnpm", args: ["test"] },
  { name: "Rust", command: "./kd", args: ["test", "rust"] },
  { name: "Remote E2E", command: "./kd", args: ["test", "remote-e2e"] },
];

export async function executeLocalCi(input: LocalCiInput) {
  const results: Array<LocalCiStep & { exitCode: number }> = [];
  for (const step of LOCAL_CI_STEPS) {
    const result = await input.runner.run(step.command, step.args, {
      cwd: input.repoRoot,
      env: input.env,
      streamOutput: true,
    });
    results.push({ ...step, exitCode: result.exitCode });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: `Local CI failed during ${step.name}.`,
        data: { steps: results },
      };
    }
  }
  return {
    ok: true,
    message: "Local CI passed.",
    data: { steps: results },
  };
}
