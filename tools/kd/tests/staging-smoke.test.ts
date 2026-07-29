import { describe, expect, it } from "vitest";
import { buildStagingSmokeSteps, executeStagingSmoke } from "../src/runtime/staging-smoke";
import type { CommandRunner } from "../src/runtime/process";
import {
  STAGING_DEVICE_TOKEN_ENV,
  STAGING_PASSWORD_ENV,
  stagingRemoteE2eSkipMessage,
} from "../src/runtime/staging-credentials";

const credentialedEnv = (): NodeJS.ProcessEnv => ({
  [STAGING_DEVICE_TOKEN_ENV]: "buffy-device-token",
  [STAGING_PASSWORD_ENV]: "buffy-password",
});

describe("staging smoke orchestration", () => {
  it("plans the remote doctor step before the staging remote E2E step", () => {
    expect(buildStagingSmokeSteps()).toEqual([
      { step: "doctor", command: "./kd", args: ["doctor", "--remote", "--staging"] },
      { step: "remote-e2e", command: "./kd", args: ["test", "remote-e2e", "--staging"] },
    ]);
  });

  it("executes both steps in order with streamed output when credentials are present", async () => {
    const planned = buildStagingSmokeSteps();
    const env = credentialedEnv();
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

    const result = await executeStagingSmoke({ repoRoot: "/repo", env, runner });

    expect(calls).toEqual(planned.map(({ command, args }) => ({ command, args })));
    expect(result).toEqual({
      ok: true,
      message: "Staging smoke passed: remote doctor and staging remote E2E green.",
      data: {
        skipped: false,
        steps: planned.map((step, index) => ({
          ...step,
          exitCode: 0,
          stdout: `stdout-${index}`,
          stderr: "",
        })),
      },
    });
  });

  it("stops before the remote E2E step when the doctor step fails", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 3, stdout: "", stderr: "doctor failed" };
      },
    };

    const result = await executeStagingSmoke({ repoRoot: "/repo", env: credentialedEnv(), runner });

    expect(calls).toEqual(["./kd doctor --remote --staging"]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "staging smoke failed at the doctor step (./kd doctor --remote --staging) with exit code 3."
    );
  });

  it("reports the remote E2E step and exit code after the doctor step passes", async () => {
    const outcomes = [
      { exitCode: 0, stdout: "doctor passed", stderr: "" },
      { exitCode: 5, stdout: "", stderr: "staging lane failed" },
    ];
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return outcomes[calls.length - 1];
      },
    };

    const result = await executeStagingSmoke({ repoRoot: "/repo", env: credentialedEnv(), runner });

    expect(calls).toEqual(["./kd doctor --remote --staging", "./kd test remote-e2e --staging"]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "staging smoke failed at the remote-e2e step (./kd test remote-e2e --staging) with exit code 5."
    );
  });

  it("skips cleanly without running any step when credentials are absent", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await executeStagingSmoke({ repoRoot: "/repo", env: {}, runner });

    expect(calls).toEqual([]);
    expect(result).toEqual({
      ok: true,
      message: stagingRemoteE2eSkipMessage([STAGING_DEVICE_TOKEN_ENV, STAGING_PASSWORD_ENV]),
      data: {
        skipped: true,
        missing: [STAGING_DEVICE_TOKEN_ENV, STAGING_PASSWORD_ENV],
        steps: [],
      },
    });
  });

  it("treats a blank password as missing and skips without running steps", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await executeStagingSmoke({
      repoRoot: "/repo",
      env: { [STAGING_DEVICE_TOKEN_ENV]: "buffy-device-token", [STAGING_PASSWORD_ENV]: "  " },
      runner,
    });

    expect(calls).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.message).toBe(stagingRemoteE2eSkipMessage([STAGING_PASSWORD_ENV]));
  });
});
