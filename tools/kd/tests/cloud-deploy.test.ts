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

  it("deploys the relay to the VM over scp+ssh and returns the hostname URL", async () => {
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
        env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "kanna-build" },
        runner,
        environment: "production"
      });

      expect(result).toEqual({
        projectId: "kanna-build",
        vmName: "kanna-relay-vm",
        zone: "us-central1-a",
        image: "gcr.io/kanna-build/kanna-relay",
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
            "builds",
            "submit",
            ".",
            "--project",
            "kanna-build",
            "--config",
            "services/relay/cloudbuild.yaml",
            "--substitutions",
            "_IMAGE=gcr.io/kanna-build/kanna-relay"
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
            "rm -rf ~/kanna-relay && mkdir -p ~/kanna-relay"
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "scp",
            "services/relay/deploy/compose.yaml",
            "services/relay/deploy/Caddyfile",
            "services/relay/deploy/vm-deploy.sh",
            "kanna-relay-vm:~/kanna-relay/",
            "--project",
            "kanna-build",
            "--zone",
            "us-central1-a"
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
            "sudo bash ~/kanna-relay/vm-deploy.sh"
          ],
          cwd: repoRoot,
          streamOutput: true
        }
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses relay deploys for projects other than the compose-pinned kanna-build image", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      deployRelayCloud({
        repoRoot: "/repo",
        env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "other-project" },
        runner,
        environment: "production"
      })
    ).rejects.toThrow("stale image");
    expect(calls.length).toBe(0);
  });

  it("refuses staging relay deploys", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      deployRelayCloud({
        repoRoot: "/repo",
        env: { KANNA_FIREBASE_STAGING_PROJECT: "kanna-staging" },
        runner,
        environment: "staging"
      })
    ).rejects.toThrow("staging relay is retired");
    expect(calls.length).toBe(0);
  });

  it("refuses staging Firebase deploys with --relay before doing any work", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      deployFirebaseCloud({
        repoRoot: "/repo",
        env: { KANNA_FIREBASE_STAGING_PROJECT: "kanna-staging" },
        runner,
        environment: "staging",
        relay: true
      })
    ).rejects.toThrow("staging relay is retired");
    expect(calls.length).toBe(0);
  });
});
