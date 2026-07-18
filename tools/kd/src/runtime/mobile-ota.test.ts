import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli.js";
import { resolveKdEnvironment } from "./environment.js";
import {
  buildMobileOtaPublishPlan,
  computeExpoUpdateId,
  executeMobileOtaDoctorWithContext,
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
  await mkdir(join(repoRoot, "apps/mobile/dist/_expo/static/js/ios"), { recursive: true });
  await mkdir(join(repoRoot, "apps/mobile/dist/assets"), { recursive: true });
  await writeFile(
    join(repoRoot, "apps/mobile/dist/metadata.json"),
    JSON.stringify({
      fileMetadata: {
        ios: {
          bundle: "_expo/static/js/ios/main.hbc",
          assets: [{ path: "assets/icon.png", ext: "png" }],
        },
      },
    })
  );
  await writeFile(join(repoRoot, "apps/mobile/dist/_expo/static/js/ios/main.hbc"), "bundle bytes");
  await writeFile(join(repoRoot, "apps/mobile/dist/assets/icon.png"), "png bytes");
  return repoRoot;
}

async function writeMinimalSdk57Export(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, "apps/mobile/dist/bundles"), { recursive: true });
  await writeFile(
    join(repoRoot, "apps/mobile/dist/metadata.json"),
    JSON.stringify({
      fileMetadata: { ios: { bundle: "bundles/main.hbc", assets: [] } },
    })
  );
  await writeFile(join(repoRoot, "apps/mobile/dist/bundles/main.hbc"), "bundle");
}

describe("kd mobile OTA", () => {
  it("parses publish, status, doctor, and preflight commands under mobile ota", () => {
    expect(parseCliArgs(["mobile", "ota", "publish", "--staging", "--dry-run"])).toEqual({
      taskId: "mobile.ota.publish",
      input: { staging: true, production: false, dryRun: true, rollbackTo: undefined },
    });
    expect(parseCliArgs(["mobile", "ota", "status", "--production"])).toEqual({
      taskId: "mobile.ota.status",
      input: { staging: false, production: true },
    });
    expect(parseCliArgs(["mobile", "ota", "provision", "--staging"])).toEqual({
      taskId: "mobile.ota.provision",
      input: { staging: true, production: false },
    });
    expect(parseCliArgs(["mobile", "ota", "provision-secret", "--staging", "--key-path", "/tmp/key.pem"])).toEqual({
      taskId: "mobile.ota.provision-secret",
      input: { staging: true, production: false, keyPath: "/tmp/key.pem" },
    });
    expect(parseCliArgs(["mobile", "ota", "doctor", "--staging"])).toEqual({
      taskId: "mobile.ota.doctor",
      input: { staging: true, production: false },
    });
    expect(parseCliArgs(["mobile", "ota", "preflight", "--production"])).toEqual({
      taskId: "mobile.ota.doctor",
      input: { staging: false, production: true },
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
    const bundleKey = createHash("sha256").update("bundle bytes").digest("base64url");
    const assetKey = createHash("sha256").update("png bytes").digest("base64url");
    const expectedUpdateId = computeExpoUpdateId(Buffer.from(JSON.stringify({
      fileMetadata: {
        ios: {
          bundle: `bundles/${bundleKey}.hbc`,
          assets: [{ path: `assets/${assetKey}`, ext: "png" }],
        },
      },
    })));
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
      updateId: expectedUpdateId,
      pointerObject: "ota/ios/1.0.0/channels/staging.json",
    });
    expect(plan.commands.map((command) => command.command)).toEqual([
      "pnpm",
      "pnpm",
      "gcloud",
      "gcloud",
    ]);
    expect(plan.commands[0]?.args).toContain("export");
    expect(plan.commands[1]?.args).toEqual([
      "exec",
      "expo",
      "config",
      "--type",
      "public",
      "--json",
    ]);
    expect(plan.commands[2]?.args).toContain("--recursive");
    expect(plan.commands[3]?.args).toContain("gs://kanna-staging.firebasestorage.app/ota/ios/1.0.0/channels/staging.json");
  });

  it("checks git cleanliness and runs export before publishing in dry-run mode", async () => {
    const repoRoot = await makeRepoFixture();
    const expoPublicConfig = JSON.stringify({
      name: "Kanna Staging",
      runtimeVersion: "1.0.0",
      extra: { kanna: { appEnv: "staging" } },
    });
    const calls: Array<{
      command: string;
      args: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options?.cwd, env: options?.env });
        if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
        if (command === "pnpm" && args.includes("export")) {
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
          await writeFile(join(repoRoot, "apps/mobile/dist/bundles/main.hbc"), "bundle");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "pnpm" && args.includes("config")) {
          return { exitCode: 0, stdout: expoPublicConfig, stderr: "" };
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
    expect(calls[2]).toMatchObject({
      command: "pnpm",
      args: ["exec", "expo", "config", "--type", "public", "--json"],
      cwd: join(repoRoot, "apps/mobile"),
      env: { KANNA_APP_ENV: "staging" },
    });
    expect(calls.some((call) => call.command === "gcloud")).toBe(false);
    expect(result.message).toContain("Dry run: mobile OTA update");
    expect(result.message).toContain("curl -H 'expo-protocol-version: 1'");
  });

  it("surfaces Expo public config command failures before cloud access", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
        if (command === "pnpm" && args.includes("export")) {
          await writeMinimalSdk57Export(repoRoot);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "pnpm" && args.includes("config")) {
          return { exitCode: 1, stdout: "", stderr: "config failed" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected cloud access" };
      },
    };

    await expect(
      executeMobileOtaPublishWithContext(
        { staging: true, production: false, dryRun: true },
        { repoRoot, env: {}, runner }
      )
    ).rejects.toThrow("config failed");
    expect(calls.some((call) => call.command === "gcloud")).toBe(false);
  });

  it("rejects malformed Expo public config before cloud access", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
        if (command === "pnpm" && args.includes("export")) {
          await writeMinimalSdk57Export(repoRoot);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "pnpm" && args.includes("config")) {
          return { exitCode: 0, stdout: "not-json", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected cloud access" };
      },
    };

    await expect(
      executeMobileOtaPublishWithContext(
        { staging: true, production: false, dryRun: true },
        { repoRoot, env: {}, runner }
      )
    ).rejects.toThrow("Expo public config command did not return valid JSON.");
    expect(calls.some((call) => call.command === "gcloud")).toBe(false);
  });

  it("publishes the update ID derived from the staged metadata uploaded to GCS", async () => {
    const repoRoot = await makeRepoFixture();
    const bundleBytes = Buffer.from("bundle bytes");
    const assetBytes = Buffer.from("asset bytes");
    const bundleKey = createHash("sha256").update(bundleBytes).digest("base64url");
    const assetKey = createHash("sha256").update(assetBytes).digest("base64url");
    const expectedStagedMetadata = JSON.stringify({
      fileMetadata: {
        ios: {
          bundle: `bundles/${bundleKey}.hbc`,
          assets: [
            {
              path: `assets/${assetKey}`,
              ext: "png",
              contentType: "image/png",
            },
          ],
        },
      },
    });
    const expectedUpdateId = computeExpoUpdateId(Buffer.from(expectedStagedMetadata));
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
        if (command === "pnpm" && args.includes("export")) {
          await mkdir(join(repoRoot, "apps/mobile/dist/_expo/static/js/ios"), { recursive: true });
          await mkdir(join(repoRoot, "apps/mobile/dist/assets"), { recursive: true });
          await writeFile(
            join(repoRoot, "apps/mobile/dist/metadata.json"),
            JSON.stringify({
              fileMetadata: {
                ios: {
                  bundle: "_expo/static/js/ios/main.hbc",
                  assets: [
                    {
                      path: "assets/icon.png",
                      ext: "png",
                      contentType: "image/png",
                    },
                  ],
                },
              },
            })
          );
          await writeFile(join(repoRoot, "apps/mobile/dist/_expo/static/js/ios/main.hbc"), bundleBytes);
          await writeFile(join(repoRoot, "apps/mobile/dist/assets/icon.png"), assetBytes);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "pnpm" && args.includes("config")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ name: "Kanna Staging", runtimeVersion: "1.0.0" }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await executeMobileOtaPublishWithContext(
      { staging: true, production: false, dryRun: true },
      { repoRoot, env: {}, runner }
    );

    expect(result.data).toMatchObject({
      updateId: expectedUpdateId,
      runtimeVersion: "1.0.0",
      channel: "staging",
    });
    expect(result.message).toContain(`Dry run: mobile OTA update ${expectedUpdateId}`);
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

  it("runs a read-only staging OTA doctor against GCS, relay, and Secret Manager wiring", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const pointer = {
      currentUpdateId: "11111111-2222-3333-4444-555555555555",
      createdAt: "2026-06-30T00:00:00.000Z",
      runtimeVersion: "1.0.0",
    };
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joined = args.join(" ");
        if (command === "gcloud" && joined.includes("storage cat gs://kanna-staging.firebasestorage.app/ota/ios/1.0.0/channels/staging.json")) {
          return { exitCode: 0, stdout: JSON.stringify(pointer), stderr: "" };
        }
        if (command === "gcloud" && joined.includes("updates/11111111-2222-3333-4444-555555555555/metadata.json")) {
          return { exitCode: 0, stdout: "{\"fileMetadata\":{\"ios\":{\"bundle\":\"bundles/main.hbc\"}}}", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("updates/11111111-2222-3333-4444-555555555555/expoConfig.json")) {
          return { exitCode: 0, stdout: "{\"name\":\"Kanna\"}", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("secrets describe kanna-mobile-ota-private-key-pem")) {
          return { exitCode: 0, stdout: "name: projects/kanna-staging/secrets/kanna-mobile-ota-private-key-pem\n", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("compute instances describe kanna-relay-staging")) {
          return { exitCode: 0, stdout: "relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("secrets get-iam-policy kanna-mobile-ota-private-key-pem")) {
          return { exitCode: 0, stdout: "serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("storage buckets get-iam-policy gs://kanna-staging.firebasestorage.app")) {
          return { exitCode: 0, stdout: "serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        if (command === "curl" && args.at(-1) === "https://relay-staging.kanna.build/health") {
          return { exitCode: 0, stdout: "{\"ok\":true}", stderr: "" };
        }
        if (command === "curl" && args.at(-1) === "https://relay-staging.kanna.build/ota/manifest") {
          return { exitCode: 0, stdout: "multipart manifest", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${command} ${joined}` };
      },
    };

    const result = await executeMobileOtaDoctorWithContext(
      { staging: true, production: false },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Mobile OTA staging preflight");
    expect(result.message).toContain("human-only: install/launch the staging iOS app and confirm the OTA applies on a device");
    expect(calls.some((call) => call.command === "gcloud" && call.args.includes("cp"))).toBe(false);
    expect(calls.some((call) => call.command === "gcloud" && call.args.includes("rsync"))).toBe(false);
    expect(calls.some((call) => call.command === "gcloud" && call.args.includes("create"))).toBe(false);
    expect(calls.some((call) => call.command === "gcloud" && call.args.includes("add-iam-policy-binding"))).toBe(false);
    expect(calls.some((call) => call.command === "gcloud" && call.args.includes("access"))).toBe(false);
  });

  it("reports a missing OTA pointer without probing update objects", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joined = args.join(" ");
        if (command === "gcloud" && joined.includes("storage cat gs://kanna-staging.firebasestorage.app/ota/ios/1.0.0/channels/staging.json")) {
          return { exitCode: 1, stdout: "", stderr: "No URLs matched" };
        }
        if (command === "gcloud" && joined.includes("secrets describe kanna-mobile-ota-private-key-pem")) {
          return { exitCode: 0, stdout: "name: projects/kanna-staging/secrets/kanna-mobile-ota-private-key-pem\n", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("compute instances describe kanna-relay-staging")) {
          return { exitCode: 0, stdout: "relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("secrets get-iam-policy kanna-mobile-ota-private-key-pem")) {
          return { exitCode: 0, stdout: "serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("storage buckets get-iam-policy gs://kanna-staging.firebasestorage.app")) {
          return { exitCode: 0, stdout: "serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        if (command === "curl" && args.at(-1) === "https://relay-staging.kanna.build/health") {
          return { exitCode: 0, stdout: "{\"ok\":true}", stderr: "" };
        }
        if (command === "curl" && args.at(-1) === "https://relay-staging.kanna.build/ota/manifest") {
          return { exitCode: 22, stdout: "", stderr: "HTTP 404" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${command} ${joined}` };
      },
    };

    const result = await executeMobileOtaDoctorWithContext(
      { staging: true, production: false },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("FAIL pointer");
    expect(result.message).toContain("manifest: relay reports no update for the channel");
    expect(calls.some((call) => call.args.join(" ").includes("/updates/"))).toBe(false);
  });
});
