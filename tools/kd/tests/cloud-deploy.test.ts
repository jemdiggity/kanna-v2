import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli";
import {
  buildRelayDeployPlan,
  buildRelayProvisionPlan,
  deployRelayCloud,
  deployFirebaseCloud,
  resolveFirebaseProject,
  resolveProductionFirebaseProject,
  resolveWebPortalBuildEnvironment
} from "../src/runtime/cloud-deploy";
import type { CommandRunner } from "../src/runtime/process";

const HEAD_COMMIT = "1f2e3d4c5b6a79880123456789abcdef01234567";
const SHORT_COMMIT = HEAD_COMMIT.slice(0, 12);
const SOURCE = { ref: "release/0.2", commit: HEAD_COMMIT, shortCommit: SHORT_COMMIT };
const PORTAL_ENV = {
  KANNA_WEB_PORTAL_FIREBASE_API_KEY: "web-api-key",
  KANNA_WEB_PORTAL_FIREBASE_APP_ID: "web-app-id",
  KANNA_WEB_PORTAL_STRIPE_PUBLISHABLE_KEY: "pk_test_kanna"
};

/** Answers the git probes `resolveSourceRef` makes before a deploy touches anything. */
function gitSourceResult(
  command: string,
  args: string[],
  status = ""
): { exitCode: number; stdout: string; stderr: string } | null {
  if (command !== "git") return null;
  if (args[0] === "status") return { exitCode: 0, stdout: status, stderr: "" };
  if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
  return null;
}

describe("cloud deploy runtime", () => {
  it("includes workspace patched dependencies in the relay Docker build context", () => {
    const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
    const dockerfile = readFileSync(resolve(repoRoot, "services/relay/Dockerfile"), "utf8");
    const manifests = dockerfile.indexOf("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./");
    const patches = dockerfile.indexOf("COPY patches/ ./patches/");
    const install = dockerfile.indexOf("RUN pnpm install --frozen-lockfile --filter kanna-relay...");
    const deploy = dockerfile.indexOf(
      "RUN pnpm --config.allowUnusedPatches=true --filter kanna-relay deploy --prod --legacy /relay"
    );

    expect(manifests).toBeGreaterThanOrEqual(0);
    expect(patches).toBeGreaterThan(manifests);
    expect(install).toBeGreaterThan(patches);
    expect(deploy).toBeGreaterThan(install);
  });

  it("resolves the production Firebase project from env before .firebaserc", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kd-cloud-deploy-"));
    writeFileSync(
      join(repoRoot, ".firebaserc"),
      JSON.stringify({ projects: { production: "firebaserc-prod" } })
    );

    try {
      expect(
        resolveProductionFirebaseProject(repoRoot, {
          KANNA_FIREBASE_PRODUCTION_PROJECT: "env-prod"
        })
      ).toBe("env-prod");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolves the production Firebase project from .firebaserc", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kd-cloud-deploy-"));
    writeFileSync(
      join(repoRoot, ".firebaserc"),
      JSON.stringify({ projects: { production: "firebaserc-prod" } })
    );

    try {
      expect(resolveProductionFirebaseProject(repoRoot, {})).toBe("firebaserc-prod");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolves the staging Firebase project from env", () => {
    expect(
      resolveFirebaseProject("/repo", {
        KANNA_FIREBASE_STAGING_PROJECT: "kanna-staging"
      }, "staging")
    ).toBe("kanna-staging");
  });

  it("falls back to the registry production Firebase project", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kd-cloud-deploy-"));
    writeFileSync(join(repoRoot, ".firebaserc"), JSON.stringify({ projects: { default: "kanna-local" } }));

    try {
      expect(resolveProductionFirebaseProject(repoRoot, {})).toBe("kanna-build");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("builds the portal with environment-scoped public Firebase and Stripe configuration", () => {
    const buildEnv = resolveWebPortalBuildEnvironment({
      ...PORTAL_ENV,
      KANNA_WEB_PORTAL_CLOUD_PRICE: "$12/month"
    }, "kanna-staging");

    expect(buildEnv).toMatchObject({
      VITE_FIREBASE_API_KEY: "web-api-key",
      VITE_FIREBASE_APP_ID: "web-app-id",
      VITE_FIREBASE_PROJECT_ID: "kanna-staging",
      VITE_FIREBASE_AUTH_DOMAIN: "kanna-staging.firebaseapp.com",
      VITE_FIREBASE_FUNCTIONS_REGION: "us-central1",
      VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_kanna",
      VITE_KANNA_CLOUD_PRICE: "$12/month"
    });
  });

  it("refuses to build a deploy with missing portal configuration", () => {
    expect(() => resolveWebPortalBuildEnvironment({}, "kanna-staging"))
      .toThrow("cloud deploy requires KANNA_WEB_PORTAL_FIREBASE_API_KEY");
  });

  it("refuses cloud deploys without an explicit environment", async () => {
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      deployFirebaseCloud({
        repoRoot: "/repo",
        env: {},
        runner,
        environment: "none" as never,
        relay: false
      })
    ).rejects.toThrow("cloud deploy requires staging or production");
  });

  it("builds functions before deploying Firebase cloud services", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kd-cloud-deploy-"));
    mkdirSync(join(repoRoot, "services/firebase-functions"), { recursive: true });
    const calls: Array<{ command: string; args: string[]; cwd?: string; streamOutput?: boolean }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({
          command,
          args,
          cwd: options?.cwd,
          ...(options?.streamOutput === undefined ? {} : { streamOutput: options.streamOutput })
        });
        return gitSourceResult(command, args) ?? { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    try {
      const result = await deployFirebaseCloud({
        repoRoot,
        env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "prod-project", ...PORTAL_ENV },
        runner,
        environment: "production",
        ref: "release/0.2"
      });

      expect(result).toEqual({ projectId: "prod-project", deployed: true, source: SOURCE });
      expect(calls).toEqual([
        {
          command: "git",
          args: ["status", "--porcelain"],
          cwd: repoRoot
        },
        {
          command: "git",
          args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
          cwd: repoRoot
        },
        {
          command: "git",
          args: ["rev-parse", "--verify", "--quiet", "release/0.2^{commit}"],
          cwd: repoRoot
        },
        {
          command: "pnpm",
          args: ["--dir", "services/firebase-functions", "build"],
          cwd: repoRoot
        },
        {
          command: "pnpm",
          args: ["--dir", "apps/web-portal", "build"],
          cwd: repoRoot
        },
        {
          command: "pnpm",
          args: [
            "exec",
            "firebase",
            "deploy",
            "--only",
            "functions,firestore:rules,firestore:indexes,hosting:account",
            "--project",
            "prod-project",
            "--force"
          ],
          cwd: repoRoot,
          streamOutput: true
        }
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses to deploy Firebase cloud services from a dirty git worktree", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kd-cloud-deploy-"));
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({
          command,
          args,
          cwd: options?.cwd
        });
        return (
          gitSourceResult(command, args, " M tools/kd/src/runtime/cloud-deploy.ts\n") ??
          { exitCode: 0, stdout: "", stderr: "" }
        );
      }
    };

    try {
      await expect(
        deployFirebaseCloud({
          repoRoot,
          env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "prod-project" },
          runner,
          environment: "production",
          ref: "release/0.2"
        })
      ).rejects.toThrow("Refusing to run cloud deploy from a dirty git worktree");

      expect(calls).toEqual([
        {
          command: "git",
          args: ["status", "--porcelain"],
          cwd: repoRoot
        }
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("builds a staging relay VM provision plan without executing it", () => {
    const plan = buildRelayProvisionPlan({ environment: "staging" });
    const serviceAccount = "kanna-relay-staging@kanna-staging.iam.gserviceaccount.com";

    expect(plan.projectId).toBe("kanna-staging");
    expect(plan.domain).toBe("relay-staging.kanna.build");
    expect(plan.vmName).toBe("kanna-relay-staging");
    expect(plan.commands.map((command) => command.command)).toEqual([
      "gcloud",
      "gcloud",
      "gcloud",
      "gcloud",
      "gcloud",
      "gcloud",
      "gcloud",
      "gcloud",
      "gcloud"
    ]);
    expect(plan.commands[0]?.args).toEqual([
      "services",
      "enable",
      "compute.googleapis.com",
      "--project",
      "kanna-staging"
    ]);
    expect(plan.commands[1]?.args).toEqual([
      "iam",
      "service-accounts",
      "create",
      "kanna-relay-staging",
      "--project",
      "kanna-staging",
      "--display-name",
      "Kanna relay VM (staging)"
    ]);
    for (const role of [
      "roles/datastore.user",
      "roles/artifactregistry.reader",
      "roles/storage.objectViewer",
      "roles/firebasecloudmessaging.admin"
    ]) {
      expect(plan.commands.some((command) =>
        command.args.includes("add-iam-policy-binding") &&
        command.args.includes(`serviceAccount:${serviceAccount}`) &&
        command.args.includes(role)
      )).toBe(true);
    }
    expect(plan.commands[6]?.args).toEqual([
      "compute",
      "addresses",
      "create",
      "relay-staging-ip",
      "--project",
      "kanna-staging",
      "--region",
      "us-central1"
    ]);
    expect(plan.commands[7]?.args).toContain("kanna-relay-staging");
    expect(plan.commands[7]?.args).toContain("--machine-type");
    expect(plan.commands[7]?.args).toContain("e2-micro");
    expect(plan.commands[7]?.args).toContain("--service-account");
    expect(plan.commands[7]?.args).toContain(serviceAccount);
    expect(plan.commands[7]?.args).toContain("--scopes");
    expect(plan.commands[7]?.args).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(plan.commands[7]?.args).toContain("--zone");
    expect(plan.commands[7]?.args).toContain("us-central1-a");
    expect(plan.commands[7]?.args.join("\n")).toContain("startup-script");
    expect(plan.commands[7]?.args.join("\n")).toContain("relay-staging.kanna.build");
    expect(plan.commands[8]?.args).toEqual([
      "compute",
      "firewall-rules",
      "create",
      "allow-kanna-relay-staging-web",
      "--project",
      "kanna-staging",
      "--allow",
      "tcp:80,tcp:443",
      "--target-tags",
      "kanna-relay-staging",
      "--description",
      "Allow HTTP and HTTPS for Kanna staging relay"
    ]);
  });

  it("builds a production relay VM deploy plan", () => {
    const plan = buildRelayDeployPlan({ repoRoot: "/repo", environment: "production", commit: SHORT_COMMIT });

    expect(plan.projectId).toBe("kanna-build");
    expect(plan.relayUrl).toBe("wss://relay.kanna.build");
    expect(plan.artifactRegistryImage).toBe("us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest");
    expect(plan.commands).toEqual([
      {
        command: "gcloud",
        args: [
          "builds",
          "submit",
          "--project",
          "kanna-build",
          "--config",
          "services/relay/cloudbuild.yaml",
          "--substitutions",
          `_IMAGE=us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest,_COMMIT=${SHORT_COMMIT}`,
          "."
        ],
        cwd: "/repo",
        streamOutput: true
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "ssh",
          "kanna-relay-vm",
          "--project",
          "kanna-build",
          "--zone",
          "us-central1-a",
          "--command",
          'sudo mkdir -p /opt/kanna-relay && sudo chown -R "$(id -un):$(id -gn)" /opt/kanna-relay'
        ],
        cwd: "/repo",
        streamOutput: true
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "scp",
          "--project",
          "kanna-build",
          "--zone",
          "us-central1-a",
          "/repo/services/relay/deploy/docker-compose.yml",
          "/repo/services/relay/deploy/Caddyfile",
          "kanna-relay-vm:/opt/kanna-relay/"
        ],
        cwd: "/repo",
        streamOutput: true
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "ssh",
          "kanna-relay-vm",
          "--project",
          "kanna-build",
          "--zone",
          "us-central1-a",
          "--command",
          [
            "cd /opt/kanna-relay",
            "TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')",
            "SECRET_NAME=kanna-mobile-ota-private-key-pem",
            "SECRET_DATA=$(curl -fsS -H \"Authorization: Bearer $TOKEN\" \"https://secretmanager.googleapis.com/v1/projects/kanna-build/secrets/$SECRET_NAME/versions/latest:access\" | sed -n 's/.*\"data\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p')",
            "test -n \"$SECRET_DATA\"",
            "printf '%s' \"$SECRET_DATA\" | base64 -d > .ota-private-key.tmp",
            "sudo install -m 0444 .ota-private-key.tmp /opt/kanna-relay/ota-private-key.pem",
            "rm .ota-private-key.tmp",
            "printf '%s' \"$TOKEN\" | docker login -u oauth2accesstoken --password-stdin https://us-central1-docker.pkg.dev",
            "cat > .env.tmp <<'KANNA_RELAY_ENV'",
            "KANNA_RELAY_DOMAIN=relay.kanna.build",
            "FIREBASE_PROJECT_ID=kanna-build",
            "KANNA_RELAY_IMAGE=us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest",
            "KANNA_OTA_BUCKET=kanna-build.firebasestorage.app",
            "KANNA_OTA_KEY_ID=kanna-mobile-ota-v1",
            "KANNA_OTA_PRIVATE_KEY_PATH=/run/secrets/kanna_ota_private_key.pem",
            "KANNA_RELAY_ENV",
            "sudo install -m 0644 .env.tmp /opt/kanna-relay/.env",
            "rm .env.tmp",
            "docker compose pull",
            "docker compose up -d"
          ].join("\n")
        ],
        cwd: "/repo",
        streamOutput: true
      }
    ]);
  });

  it("deploys the relay to the environment VM and returns the registry wss URL", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kd-cloud-deploy-"));
    const calls: Array<{ command: string; args: string[]; cwd?: string; streamOutput?: boolean }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({
          command,
          args,
          cwd: options?.cwd,
          ...(options?.streamOutput === undefined ? {} : { streamOutput: options.streamOutput })
        });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    try {
      const result = await deployRelayCloud({
        repoRoot,
        env: {},
        runner,
        environment: "production",
        source: SOURCE
      });

      expect(result).toEqual({
        projectId: "kanna-build",
        vmName: "kanna-relay-vm",
        zone: "us-central1-a",
        relayUrl: "wss://relay.kanna.build",
        commit: SHORT_COMMIT
      });
      expect(calls).toEqual([
        {
          command: "gcloud",
          args: [
            "builds",
            "submit",
            "--project",
            "kanna-build",
            "--config",
            "services/relay/cloudbuild.yaml",
            "--substitutions",
            `_IMAGE=us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest,_COMMIT=${SHORT_COMMIT}`,
            "."
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "ssh",
            "kanna-relay-vm",
            "--project",
            "kanna-build",
            "--zone",
            "us-central1-a",
            "--command",
            'sudo mkdir -p /opt/kanna-relay && sudo chown -R "$(id -un):$(id -gn)" /opt/kanna-relay'
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "scp",
            "--project",
            "kanna-build",
            "--zone",
            "us-central1-a",
            join(repoRoot, "services/relay/deploy/docker-compose.yml"),
            join(repoRoot, "services/relay/deploy/Caddyfile"),
            "kanna-relay-vm:/opt/kanna-relay/"
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "ssh",
            "kanna-relay-vm",
            "--project",
            "kanna-build",
            "--zone",
            "us-central1-a",
            "--command",
            [
              "cd /opt/kanna-relay",
              "TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')",
              "SECRET_NAME=kanna-mobile-ota-private-key-pem",
              "SECRET_DATA=$(curl -fsS -H \"Authorization: Bearer $TOKEN\" \"https://secretmanager.googleapis.com/v1/projects/kanna-build/secrets/$SECRET_NAME/versions/latest:access\" | sed -n 's/.*\"data\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p')",
              "test -n \"$SECRET_DATA\"",
              "printf '%s' \"$SECRET_DATA\" | base64 -d > .ota-private-key.tmp",
              "sudo install -m 0444 .ota-private-key.tmp /opt/kanna-relay/ota-private-key.pem",
              "rm .ota-private-key.tmp",
              "printf '%s' \"$TOKEN\" | docker login -u oauth2accesstoken --password-stdin https://us-central1-docker.pkg.dev",
              "cat > .env.tmp <<'KANNA_RELAY_ENV'",
              "KANNA_RELAY_DOMAIN=relay.kanna.build",
              "FIREBASE_PROJECT_ID=kanna-build",
              "KANNA_RELAY_IMAGE=us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest",
              "KANNA_OTA_BUCKET=kanna-build.firebasestorage.app",
              "KANNA_OTA_KEY_ID=kanna-mobile-ota-v1",
              "KANNA_OTA_PRIVATE_KEY_PATH=/run/secrets/kanna_ota_private_key.pem",
              "KANNA_RELAY_ENV",
              "sudo install -m 0644 .env.tmp /opt/kanna-relay/.env",
              "rm .env.tmp",
              "docker compose pull",
              "docker compose up -d"
            ].join("\n")
          ],
          cwd: repoRoot,
          streamOutput: true
        }
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("propagates a failed relay VM step", async () => {
    const runner: CommandRunner = {
      async run(command) {
        if (command === "gcloud") {
          return { exitCode: 1, stdout: "", stderr: "cloud build failed" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      deployRelayCloud({
        repoRoot: "/repo",
        env: {},
        runner,
        environment: "staging",
        source: SOURCE
      })
    ).rejects.toThrow("cloud build failed");
  });

  it("parses --ref for cloud deploy", () => {
    expect(parseCliArgs(["cloud", "deploy", "--production", "--relay", "--ref", "release/0.2"])).toEqual({
      taskId: "cloud.deploy",
      input: { staging: false, production: true, relay: true, ref: "release/0.2" }
    });
    expect(() => parseCliArgs(["cloud", "deploy", "--production", "--ref"])).toThrow("--ref requires a value");
  });

  it("requires an explicit --ref for a production deploy", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return gitSourceResult(command, args) ?? { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      deployFirebaseCloud({
        repoRoot: "/repo",
        env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "prod-project" },
        runner,
        environment: "production",
        relay: true
      })
    ).rejects.toThrow("cloud deploy --production requires --ref <branch|tag|sha>");
    expect(calls).toEqual([]);
  });

  it("refuses a --ref that is not the checked-out commit", async () => {
    const otherCommit = "b".repeat(40);
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "rev-parse") {
          const resolved = args[args.length - 1].startsWith("HEAD") ? HEAD_COMMIT : otherCommit;
          return { exitCode: 0, stdout: `${resolved}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      deployFirebaseCloud({
        repoRoot: "/repo",
        env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "prod-project" },
        runner,
        environment: "production",
        ref: "release/0.2"
      })
    ).rejects.toThrow(`--ref release/0.2 (${otherCommit}) is not checked out; HEAD is ${HEAD_COMMIT}`);
  });

  it("reports the resolved source commit and bakes it into the relay image", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return gitSourceResult(command, args) ?? { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await deployFirebaseCloud({
      repoRoot: "/repo",
      env: { KANNA_FIREBASE_STAGING_PROJECT: "kanna-staging", ...PORTAL_ENV },
      runner,
      environment: "staging",
      relay: true
    });

    expect(result.source).toEqual({ ref: "HEAD", commit: HEAD_COMMIT, shortCommit: SHORT_COMMIT });
    expect(result.relay?.commit).toBe(SHORT_COMMIT);
    expect(calls.some((call) => call.includes(`_COMMIT=${SHORT_COMMIT}`))).toBe(true);
  });

  it("refuses to plan a relay deploy without a resolved source commit", () => {
    expect(() =>
      buildRelayDeployPlan({ repoRoot: "/repo", environment: "staging", commit: "HEAD" })
    ).toThrow("Relay VM deploy requires a resolved source commit");
  });
});
