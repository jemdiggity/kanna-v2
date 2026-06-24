import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli.js";
import { resolveKdEnvironment } from "./environment.js";
import {
  buildMobileOtaPublishPlan,
  computeExpoUpdateId,
  executeMobileOtaPublishWithContext,
  executeMobileOtaProvisionSecretWithContext,
  resolveMobileRuntimeVersion,
} from "./mobile-ota.js";
import type { CommandRunner } from "./process.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeRepoFixture(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-ota-"));
  tempDirs.push(repoRoot);
  await mkdir(join(repoRoot, "apps/mobile/src"), { recursive: true });
  await mkdir(join(repoRoot, "apps/mobile/dist"), { recursive: true });
  await writeFile(
    join(repoRoot, "apps/mobile/src/mobileEnvironments.json"),
    JSON.stringify({
      dev: { runtimeVersion: "1.0.0" },
      staging: { runtimeVersion: "1.0.0" },
      prod: { runtimeVersion: "1.0.0" },
    })
  );
  await writeFile(join(repoRoot, "apps/mobile/dist/metadata.json"), "{\"hello\":\"world\"}");
  return repoRoot;
}

describe("kd mobile OTA", () => {
  it("parses publish and status commands under mobile ota", () => {
    expect(parseCliArgs(["mobile", "ota", "publish", "--staging", "--dry-run"])).toEqual({
      taskId: "mobile.ota.publish",
      input: { staging: true, production: false, dryRun: true, rollbackTo: undefined },
    });
    expect(parseCliArgs(["mobile", "ota", "status", "--production"])).toEqual({
      taskId: "mobile.ota.status",
      input: { staging: false, production: true },
    });
    expect(parseCliArgs(["mobile", "ota", "provision-secret", "--staging", "--key-path", "/tmp/key.pem"])).toEqual({
      taskId: "mobile.ota.provision-secret",
      input: { staging: true, production: false, keyPath: "/tmp/key.pem" },
    });
  });

  it("extends environment identity with OTA bucket and channel", () => {
    expect(resolveKdEnvironment("staging")).toMatchObject({
      otaBucket: "kanna-staging.firebasestorage.app",
      otaChannel: "staging",
    });
    expect(resolveKdEnvironment("prod")).toMatchObject({
      otaBucket: "kanna-build.firebasestorage.app",
      otaChannel: "production",
    });
  });

  it("resolves the mobile runtime version from mobileEnvironments.json", async () => {
    const repoRoot = await makeRepoFixture();
    await expect(resolveMobileRuntimeVersion(repoRoot, "staging")).resolves.toBe("1.0.0");
    await expect(resolveMobileRuntimeVersion(repoRoot, "prod")).resolves.toBe("1.0.0");
  });

  it("computes a deterministic Expo update ID from metadata.json bytes", () => {
    expect(computeExpoUpdateId(Buffer.from("{\"hello\":\"world\"}"))).toBe(
      "93a23971-a914-e5ea-cbf0-a8d25154cda3"
    );
  });

  it("builds a dry-run publish plan without uploading to GCS", async () => {
    const repoRoot = await makeRepoFixture();
    const plan = await buildMobileOtaPublishPlan({
      repoRoot,
      environment: "staging",
      distDir: join(repoRoot, "apps/mobile/dist"),
      dryRun: true,
    });

    expect(plan).toMatchObject({
      bucket: "kanna-staging.firebasestorage.app",
      channel: "staging",
      runtimeVersion: "1.0.0",
      updateId: "93a23971-a914-e5ea-cbf0-a8d25154cda3",
      pointerObject: "ota/ios/1.0.0/channels/staging.json",
    });
    expect(plan.commands.map((command) => command.command)).toEqual(["pnpm", "gcloud", "gcloud"]);
    expect(plan.commands[0]?.args).toContain("expo");
    expect(plan.commands[1]?.args).toContain("--recursive");
    expect(plan.commands[2]?.args).toContain("gs://kanna-staging.firebasestorage.app/ota/ios/1.0.0/channels/staging.json");
  });

  it("checks git cleanliness and runs export before publishing in dry-run mode", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options?.cwd });
        if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
        if (command === "pnpm") {
          await mkdir(join(repoRoot, "apps/mobile/dist"), { recursive: true });
          await mkdir(join(repoRoot, "apps/mobile/dist/bundles"), { recursive: true });
          await writeFile(
            join(repoRoot, "apps/mobile/dist/metadata.json"),
            JSON.stringify({
              fileMetadata: {
                ios: {
                  bundle: "bundles/main.hbc",
                  assets: [],
                },
              },
            })
          );
          await writeFile(join(repoRoot, "apps/mobile/dist/expoConfig.json"), "{}");
          await writeFile(join(repoRoot, "apps/mobile/dist/bundles/main.hbc"), "bundle");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await executeMobileOtaPublishWithContext(
      {
        staging: true,
        production: false,
        dryRun: true,
      },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({ command: "git", args: ["status", "--porcelain"], cwd: repoRoot });
    expect(calls[1]).toMatchObject({ command: "pnpm", cwd: join(repoRoot, "apps/mobile") });
    expect(result.message).toContain("Dry run: mobile OTA update");
    expect(result.message).toContain("curl -H 'expo-protocol-version: 1'");
  });

  it("provisions the private key through kd-managed gcloud commands", async () => {
    const repoRoot = await makeRepoFixture();
    const keyPath = join(repoRoot, "ota-private-key.pem");
    await writeFile(keyPath, "private key");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (args.includes("describe") && args.includes("kanna-mobile-ota-private-key-pem")) {
          return { exitCode: 1, stdout: "", stderr: "missing" };
        }
        if (args.includes("instances") && args.includes("describe")) {
          return { exitCode: 0, stdout: "relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await executeMobileOtaProvisionSecretWithContext(
      { staging: true, production: false, keyPath },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).toContain("secrets create kanna-mobile-ota-private-key-pem");
    expect(calls.map((call) => call.args.slice(0, 4).join(" "))).toContain("secrets versions add kanna-mobile-ota-private-key-pem");
    expect(calls.at(-1)?.args).toContain("roles/secretmanager.secretAccessor");
  });
});
