import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRelayDeployPlan,
  buildRelayProvisionPlan,
  deployRelayCloud,
  deployFirebaseCloud,
  resolveFirebaseProject,
  resolveProductionFirebaseProject
} from "../src/runtime/cloud-deploy";
import type { CommandRunner } from "../src/runtime/process";

describe("cloud deploy runtime", () => {
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
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    try {
      const result = await deployFirebaseCloud({
        repoRoot,
        env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "prod-project" },
        runner,
        environment: "production"
      });

      expect(result).toEqual({ projectId: "prod-project", deployed: true });
      expect(calls).toEqual([
        {
          command: "git",
          args: ["status", "--porcelain"],
          cwd: repoRoot
        },
        {
          command: "pnpm",
          args: ["--dir", "services/firebase-functions", "build"],
          cwd: repoRoot
        },
        {
          command: "pnpm",
          args: [
            "exec",
            "firebase",
            "deploy",
            "--only",
            "functions,firestore:rules",
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
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return { exitCode: 0, stdout: " M tools/kd/src/runtime/cloud-deploy.ts\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    try {
      await expect(
        deployFirebaseCloud({
          repoRoot,
          env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "prod-project" },
          runner,
          environment: "production"
        })
      ).rejects.toThrow("Refusing to deploy cloud services from a dirty git worktree");

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

    expect(plan.projectId).toBe("kanna-staging");
    expect(plan.domain).toBe("relay-staging.kanna.build");
    expect(plan.vmName).toBe("kanna-relay-staging");
    expect(plan.commands.map((command) => command.command)).toEqual(["gcloud", "gcloud", "gcloud"]);
    expect(plan.commands[0]?.args).toEqual([
      "compute",
      "addresses",
      "create",
      "kanna-relay-staging-ip",
      "--project",
      "kanna-staging",
      "--region",
      "us-central1"
    ]);
    expect(plan.commands[1]?.args).toContain("kanna-relay-staging");
    expect(plan.commands[1]?.args).toContain("--machine-type");
    expect(plan.commands[1]?.args).toContain("e2-micro");
    expect(plan.commands[1]?.args).toContain("--zone");
    expect(plan.commands[1]?.args).toContain("us-central1-a");
    expect(plan.commands[1]?.args.join("\n")).toContain("startup-script");
    expect(plan.commands[1]?.args.join("\n")).toContain("relay-staging.kanna.build");
    expect(plan.commands[2]?.args).toEqual([
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
    const plan = buildRelayDeployPlan({ repoRoot: "/repo", environment: "production" });

    expect(plan.projectId).toBe("kanna-build");
    expect(plan.relayUrl).toBe("wss://relay.kanna.build");
    expect(plan.commands).toEqual([
      {
        command: "pnpm",
        args: ["--dir", "services/relay", "build"],
        cwd: "/repo"
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "scp",
          "--recurse",
          "--project",
          "kanna-build",
          "--zone",
          "us-central1-a",
          "/repo/package.json",
          "/repo/pnpm-lock.yaml",
          "/repo/pnpm-workspace.yaml",
          "/repo/services/relay",
          "/repo/tools/kd/package.json",
          "kanna-relay-prod:/opt/kanna-relay/source/"
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
          "/repo/services/relay/deploy/startup-script.sh",
          "kanna-relay-prod:/opt/kanna-relay/"
        ],
        cwd: "/repo",
        streamOutput: true
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "ssh",
          "kanna-relay-prod",
          "--project",
          "kanna-build",
          "--zone",
          "us-central1-a",
          "--command",
          "cd /opt/kanna-relay && sudo sh -c 'touch .env && grep -v -E \"^(KANNA_RELAY_DOMAIN|FIREBASE_PROJECT_ID)=\" .env > .env.tmp && printf \"%s\\n\" '\\''KANNA_RELAY_DOMAIN=relay.kanna.build'\\'' '\\''FIREBASE_PROJECT_ID=kanna-build'\\'' >> .env.tmp && mv .env.tmp .env && docker compose up --build -d'"
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
        environment: "production"
      });

      expect(result).toEqual({
        projectId: "kanna-build",
        vmName: "kanna-relay-prod",
        zone: "us-central1-a",
        relayUrl: "wss://relay.kanna.build"
      });
      expect(calls).toEqual([
        {
          command: "pnpm",
          args: ["--dir", "services/relay", "build"],
          cwd: repoRoot
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "scp",
            "--recurse",
            "--project",
            "kanna-build",
            "--zone",
            "us-central1-a",
            join(repoRoot, "package.json"),
            join(repoRoot, "pnpm-lock.yaml"),
            join(repoRoot, "pnpm-workspace.yaml"),
            join(repoRoot, "services/relay"),
            join(repoRoot, "tools/kd/package.json"),
            "kanna-relay-prod:/opt/kanna-relay/source/"
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
            join(repoRoot, "services/relay/deploy/startup-script.sh"),
            "kanna-relay-prod:/opt/kanna-relay/"
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "ssh",
            "kanna-relay-prod",
            "--project",
            "kanna-build",
            "--zone",
            "us-central1-a",
            "--command",
            "cd /opt/kanna-relay && sudo sh -c 'touch .env && grep -v -E \"^(KANNA_RELAY_DOMAIN|FIREBASE_PROJECT_ID)=\" .env > .env.tmp && printf \"%s\\n\" '\\''KANNA_RELAY_DOMAIN=relay.kanna.build'\\'' '\\''FIREBASE_PROJECT_ID=kanna-build'\\'' >> .env.tmp && mv .env.tmp .env && docker compose up --build -d'"
          ],
          cwd: repoRoot,
          streamOutput: true
        }
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
