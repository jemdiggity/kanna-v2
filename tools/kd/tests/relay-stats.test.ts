import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli";
import {
  buildRelayStatsPlan,
  executeRelayStats,
  RELAY_STATS_TOKEN_SECRET_NAME,
  relayDashboardUrl,
  resolveRelayStatsToken
} from "../src/runtime/relay-stats";
import type { CommandRunner } from "../src/runtime/process";

function recordingRunner(
  stdout = "",
  exitCode = 0
): { runner: CommandRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    runner: {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode, stdout, stderr: exitCode === 0 ? "" : "PERMISSION_DENIED" };
      }
    }
  };
}

describe("kd relay stats", () => {
  it("parses the command and its flags", () => {
    expect(parseCliArgs(["relay", "stats", "--staging"])).toEqual({
      taskId: "relay.stats",
      input: { staging: true, production: false, open: false, dryRun: false }
    });
    expect(parseCliArgs(["relay", "stats", "--production", "--open"])).toEqual({
      taskId: "relay.stats",
      input: { staging: false, production: true, open: true, dryRun: false }
    });
  });

  it("plans a staging read against the environment's relay and Secret Manager project", () => {
    const plan = buildRelayStatsPlan({ environment: "staging", env: {} });

    expect(plan).toEqual({
      environment: "staging",
      projectId: "kanna-staging",
      domain: "relay-staging.kanna.build",
      statsUrl: "https://relay-staging.kanna.build/stats",
      dashboardUrl: "https://relay-staging.kanna.build/dashboard",
      tokenSource: {
        kind: "secret",
        project: "kanna-staging",
        secret: RELAY_STATS_TOKEN_SECRET_NAME
      },
      tokenCommand: {
        command: "gcloud",
        args: [
          "secrets",
          "versions",
          "access",
          "latest",
          "--secret",
          RELAY_STATS_TOKEN_SECRET_NAME,
          "--project",
          "kanna-staging"
        ]
      }
    });
  });

  it("plans production against the production relay and project", () => {
    const plan = buildRelayStatsPlan({ environment: "production", env: {} });

    expect(plan.projectId).toBe("kanna-build");
    expect(plan.statsUrl).toBe("https://relay.kanna.build/stats");
    expect(plan.dashboardUrl).toBe("https://relay.kanna.build/dashboard");
  });

  it("prefers a KANNA_RELAY_STATS_TOKEN from this shell over the secret", async () => {
    const env = { KANNA_RELAY_STATS_TOKEN: " local-operator-token \n" };
    const plan = buildRelayStatsPlan({ environment: "staging", env });

    expect(plan.tokenSource).toEqual({ kind: "env", variable: "KANNA_RELAY_STATS_TOKEN" });
    expect(plan.tokenCommand).toBeNull();

    const { runner, calls } = recordingRunner();
    await expect(resolveRelayStatsToken({ plan, env, runner, repoRoot: "/repo" }))
      .resolves.toBe("local-operator-token");
    // No secret read at all when the shell already carries the credential.
    expect(calls).toEqual([]);
  });

  it("reads the deploy-time secret when the shell sets nothing", async () => {
    const plan = buildRelayStatsPlan({ environment: "staging", env: {} });
    const { runner, calls } = recordingRunner("secret-operator-token\n");

    await expect(resolveRelayStatsToken({ plan, env: {}, runner, repoRoot: "/repo" }))
      .resolves.toBe("secret-operator-token");
    expect(calls).toEqual([
      {
        command: "gcloud",
        args: [
          "secrets",
          "versions",
          "access",
          "latest",
          "--secret",
          RELAY_STATS_TOKEN_SECRET_NAME,
          "--project",
          "kanna-staging"
        ]
      }
    ]);
  });

  it("explains how to provision the token when the secret cannot be read", async () => {
    const plan = buildRelayStatsPlan({ environment: "staging", env: {} });
    const { runner } = recordingRunner("", 1);

    await expect(resolveRelayStatsToken({ plan, env: {}, runner, repoRoot: "/repo" }))
      .rejects.toThrow(/kanna-relay-stats-token[\s\S]*KANNA_RELAY_STATS_TOKEN/);
  });

  it("puts the token in the dashboard URL, encoded", () => {
    const plan = buildRelayStatsPlan({ environment: "staging", env: {} });

    expect(relayDashboardUrl(plan, "a b/c")).toBe(
      "https://relay-staging.kanna.build/dashboard?token=a%20b%2Fc"
    );
  });

  it("dry-runs without reading the secret, fetching, or opening a browser", async () => {
    const { runner, calls } = recordingRunner("should-not-be-read");

    const result = await executeRelayStats({
      repoRoot: "/repo",
      env: {},
      runner,
      environment: "staging",
      open: true,
      dryRun: true
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(result.data).toMatchObject({
      statsUrl: "https://relay-staging.kanna.build/stats",
      dashboardUrl: "https://relay-staging.kanna.build/dashboard"
    });
    // A plan is printed and pasted around; it must never carry the credential.
    expect(result.message).not.toContain("should-not-be-read");
  });
});
