import {
  cloudEnvironmentToKdEnvironment,
  resolveKdEnvironment,
  type CloudEnvironmentName,
} from "./environment";
import type { CommandRunner } from "./process";

/**
 * `kd relay stats` — the operator's way into the relay's status surface.
 *
 * `GET /stats` and `GET /dashboard` are gated on `KANNA_RELAY_STATS_TOKEN`, an
 * operator credential that lives in Secret Manager, is written onto the VM by
 * `kd cloud deploy --relay`, and is read back here so the operator never has to
 * `gcloud compute ssh` to see what the relay is doing.
 *
 * The token is deliberately allowed in the dashboard URL's query string: a page
 * cannot set a header on its own navigation, this is a single-operator tool,
 * both routes answer `no-store`/`no-referrer`, and the credential grants
 * nothing but this read. See `docs/relay-vm-operations.md`.
 */

/** Secret Manager secret holding the relay's operator stats token. */
export const RELAY_STATS_TOKEN_SECRET_NAME = "kanna-relay-stats-token";

/** Where a resolved token came from, so the plan can say so out loud. */
export type RelayStatsTokenSource =
  | { kind: "env"; variable: string }
  | { kind: "secret"; project: string; secret: string };

export interface RelayStatsPlan {
  environment: CloudEnvironmentName;
  projectId: string;
  domain: string;
  statsUrl: string;
  dashboardUrl: string;
  /** How the token would be obtained; never the token itself. */
  tokenSource: RelayStatsTokenSource;
  /** The command that reads the secret, or null when the env supplies it. */
  tokenCommand: { command: string; args: string[] } | null;
}

/**
 * Everything `kd relay stats` would do, without doing any of it — no secret
 * read, no HTTP request, no browser. A plan never contains the token: it is
 * printed in dry runs and lands in scrollback.
 */
export function buildRelayStatsPlan(input: {
  environment: CloudEnvironmentName;
  env: NodeJS.ProcessEnv;
}): RelayStatsPlan {
  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(input.environment));
  if (!identity.relayDomain) {
    throw new Error(`Relay status is not configured for ${input.environment}.`);
  }

  const override = input.env.KANNA_RELAY_STATS_TOKEN?.trim();
  const projectId = identity.firebaseProjectId;
  const base = `https://${identity.relayDomain}`;

  return {
    environment: input.environment,
    projectId,
    domain: identity.relayDomain,
    statsUrl: `${base}/stats`,
    dashboardUrl: `${base}/dashboard`,
    tokenSource: override
      ? { kind: "env", variable: "KANNA_RELAY_STATS_TOKEN" }
      : { kind: "secret", project: projectId, secret: RELAY_STATS_TOKEN_SECRET_NAME },
    tokenCommand: override ? null : {
      command: "gcloud",
      args: [
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret",
        RELAY_STATS_TOKEN_SECRET_NAME,
        "--project",
        projectId,
      ],
    },
  };
}

/** The dashboard URL an operator can paste into a browser, token included. */
export function relayDashboardUrl(plan: RelayStatsPlan, token: string): string {
  return `${plan.dashboardUrl}?token=${encodeURIComponent(token)}`;
}

/**
 * Resolve the operator token: the local environment override first — the escape
 * hatch for a machine without Secret Manager access — then the secret the
 * deploy itself reads.
 */
export async function resolveRelayStatsToken(input: {
  plan: RelayStatsPlan;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  repoRoot: string;
}): Promise<string> {
  const override = input.env.KANNA_RELAY_STATS_TOKEN?.trim();
  if (override) return override;

  const command = input.plan.tokenCommand;
  if (!command) {
    throw new Error("Relay stats plan resolved no token source.");
  }
  const result = await input.runner.run(command.command, command.args, {
    cwd: input.repoRoot,
    env: input.env,
  });
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || !token) {
    throw new Error(
      `Could not read the relay stats token from Secret Manager secret ${RELAY_STATS_TOKEN_SECRET_NAME} `
      + `in ${input.plan.projectId}. Provision it (docs/relay-vm-operations.md) or set `
      + "KANNA_RELAY_STATS_TOKEN for this shell."
      + (result.stderr.trim() ? `\n${result.stderr.trim()}` : ""),
    );
  }
  return token;
}

export interface RelayStatsResult {
  ok: boolean;
  message: string;
  data: unknown;
}

/**
 * Fetch `/stats`, or hand the operator the dashboard URL.
 *
 * `--open` prints the URL and launches it; the URL is printed either way so a
 * headless shell is still useful.
 */
export async function executeRelayStats(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  environment: CloudEnvironmentName;
  open: boolean;
  dryRun: boolean;
}): Promise<RelayStatsResult> {
  const plan = buildRelayStatsPlan({ environment: input.environment, env: input.env });
  if (input.dryRun) {
    return {
      ok: true,
      message: JSON.stringify(plan, null, 2),
      data: plan,
    };
  }

  const token = await resolveRelayStatsToken({
    plan,
    env: input.env,
    runner: input.runner,
    repoRoot: input.repoRoot,
  });

  if (input.open) {
    const url = relayDashboardUrl(plan, token);
    const opened = await input.runner.run("open", [url], {
      cwd: input.repoRoot,
      env: input.env,
    });
    return {
      ok: true,
      // The URL carries the token, so this line is the one piece of kd output
      // that is itself a credential. It is printed because an operator on a
      // remote shell has no browser to launch and needs to paste it.
      message: [
        `Relay status dashboard (${input.environment}): ${url}`,
        opened.exitCode === 0
          ? "Opened in your browser."
          : "Could not launch a browser; open the URL above.",
      ].join("\n"),
      data: { environment: input.environment, dashboardUrl: plan.dashboardUrl },
    };
  }

  const response = await fetch(plan.statsUrl, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      message: `${plan.statsUrl} answered HTTP ${response.status}: ${body}`,
      data: { status: response.status },
    };
  }

  const stats: unknown = JSON.parse(body);
  return {
    ok: true,
    message: JSON.stringify(stats, null, 2),
    data: stats,
  };
}
