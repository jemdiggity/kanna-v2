import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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

  it("refuses production deploys without an explicit production project", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kd-cloud-deploy-"));
    writeFileSync(join(repoRoot, ".firebaserc"), JSON.stringify({ projects: { default: "kanna-local" } }));

    try {
      expect(() => resolveProductionFirebaseProject(repoRoot, {})).toThrow(
        "No production Firebase project configured"
      );
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

  it("deploys the relay to Cloud Run and returns the wss URL", async () => {
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
        if (command === "gcloud" && args.includes("services") && args.includes("describe")) {
          return {
            exitCode: 0,
            stdout: "https://kanna-relay-abc-uc.a.run.app\n",
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    try {
      const result = await deployRelayCloud({
        repoRoot,
        env: {
          KANNA_FIREBASE_PRODUCTION_PROJECT: "prod-project",
          KANNA_CLOUD_RUN_REGION: "us-east1"
        },
        runner,
        environment: "production"
      });

      expect(result).toEqual({
        projectId: "prod-project",
        serviceName: "kanna-relay",
        region: "us-east1",
        image: "gcr.io/prod-project/kanna-relay",
        serviceUrl: "https://kanna-relay-abc-uc.a.run.app",
        relayUrl: "wss://kanna-relay-abc-uc.a.run.app"
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
            "builds",
            "submit",
            ".",
            "--project",
            "prod-project",
            "--config",
            "services/relay/cloudbuild.yaml",
            "--substitutions",
            "_IMAGE=gcr.io/prod-project/kanna-relay"
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "run",
            "deploy",
            "kanna-relay",
            "--project",
            "prod-project",
            "--image",
            "gcr.io/prod-project/kanna-relay",
            "--region",
            "us-east1",
            "--platform",
            "managed",
            "--allow-unauthenticated",
            "--set-env-vars",
            "FIREBASE_PROJECT_ID=prod-project"
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "run",
            "services",
            "describe",
            "kanna-relay",
            "--project",
            "prod-project",
            "--region",
            "us-east1",
            "--platform",
            "managed",
            "--format",
            "value(status.url)"
          ],
          cwd: repoRoot
        }
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
