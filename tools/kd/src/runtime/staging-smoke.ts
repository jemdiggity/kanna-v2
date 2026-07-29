import type { CommandResult, CommandRunner } from "./process";
import {
  buffyStagingCredentialsFromEnv,
  stagingRemoteE2eSkipMessage,
} from "./staging-credentials";

export interface StagingSmokeStep {
  step: "doctor" | "remote-e2e";
  command: "./kd";
  args: string[];
}

interface ExecutedStagingSmokeStep extends StagingSmokeStep, CommandResult {}

export function buildStagingSmokeSteps(): StagingSmokeStep[] {
  return [
    { step: "doctor", command: "./kd", args: ["doctor", "--remote", "--staging"] },
    { step: "remote-e2e", command: "./kd", args: ["test", "remote-e2e", "--staging"] },
  ];
}

/**
 * Composed staging health smoke: remote doctor, then the staging remote E2E
 * lane, failing fast. Credential detection is the same single implementation
 * the staging suite uses — without credentials this is a clean exit-0 skip
 * with the suite's SKIP message, matching how `test remote-e2e --staging`
 * itself degrades.
 */
export async function executeStagingSmoke(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}) {
  const credentials = buffyStagingCredentialsFromEnv(input.env);
  if (!credentials.ok) {
    return {
      ok: true,
      message: stagingRemoteE2eSkipMessage(credentials.missing),
      data: { skipped: true, missing: credentials.missing, steps: [] },
    };
  }

  const steps: ExecutedStagingSmokeStep[] = [];
  for (const step of buildStagingSmokeSteps()) {
    const result = await input.runner.run(step.command, step.args, {
      cwd: input.repoRoot,
      env: input.env,
      streamOutput: true,
    });
    steps.push({ ...step, ...result });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: `staging smoke failed at the ${step.step} step (${step.command} ${step.args.join(" ")}) with exit code ${result.exitCode}.`,
        data: { skipped: false, steps },
      };
    }
  }
  return {
    ok: true,
    message: "Staging smoke passed: remote doctor and staging remote E2E green.",
    data: { skipped: false, steps },
  };
}
