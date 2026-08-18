import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli.js";
import { resolveKdEnvironment } from "./environment.js";
import * as mobileOtaRuntime from "./mobile-ota.js";
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
const repositoryCertificatePath = fileURLToPath(
  new URL("../../../../apps/mobile/certs/ota-codesign.pem", import.meta.url)
);
const acceptOtaCertificate = async () => ({
  keyId: "kanna-mobile-ota-v1" as const,
  codeSigning: true as const,
  validFrom: "Jul 19 19:34:32 2026 GMT",
  validTo: "Jul 16 19:34:32 2036 GMT",
});

type MobileOtaProvisionExecutor = (
  input: { staging: boolean; production: boolean },
  context: {
    repoRoot: string;
    env: NodeJS.ProcessEnv;
    runner: CommandRunner;
    request?: (input: {
      url: string;
      method: "POST";
      headers: Record<string, string>;
      body: unknown;
    }) => Promise<{ ok: boolean; status: number; body: string }>;
  }
) => Promise<{ ok: boolean; message: string; data?: unknown }>;

function getMobileOtaProvisionExecutor(): MobileOtaProvisionExecutor {
  const executor = Reflect.get(mobileOtaRuntime, "executeMobileOtaProvisionWithContext") as unknown;
  expect(executor).toBeTypeOf("function");
  return executor as MobileOtaProvisionExecutor;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeRepoFixture(
  options: { certificatePem?: string } = {}
): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-ota-"));
  tempDirs.push(repoRoot);
  await mkdir(join(repoRoot, "apps/mobile/src"), { recursive: true });
  await mkdir(join(repoRoot, "apps/mobile/certs"), { recursive: true });
  await mkdir(join(repoRoot, "apps/mobile/dist"), { recursive: true });
  await writeFile(
    join(repoRoot, "apps/mobile/certs/ota-codesign.pem"),
    options.certificatePem ?? (await readFile(repositoryCertificatePath, "utf8"))
  );
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

const HEAD_COMMIT = "9".repeat(40);
const SHORT_HEAD_COMMIT = HEAD_COMMIT.slice(0, 12);

/**
 * `resolveSourceRef` runs `git status --porcelain` then `git rev-parse` per ref,
 * so the publish tests have to answer both rather than a blanket exit 0.
 */
function gitResult(
  args: string[],
  options: { status?: string; commits?: Record<string, string> } = {}
): { exitCode: number; stdout: string; stderr: string } {
  if (args[0] === "status") {
    return { exitCode: 0, stdout: options.status ?? "", stderr: "" };
  }
  if (args[0] === "rev-parse") {
    const ref = args[args.length - 1].replace("^{commit}", "");
    const commit = (options.commits ?? { HEAD: HEAD_COMMIT })[ref];
    return commit
      ? { exitCode: 0, stdout: `${commit}\n`, stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "" };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

/** A runner that answers git, the Expo export, and the Expo public config. */
function publishRunner(
  repoRoot: string,
  options: {
    commits?: Record<string, string>;
    onGcloud?: (args: string[]) => { exitCode: number; stdout: string; stderr: string };
  } = {}
): CommandRunner {
  return {
    async run(command, args) {
      if (command === "git") return gitResult(args, { commits: options.commits });
      if (command === "pnpm" && args.includes("export")) {
        await writeMinimalSdk57Export(repoRoot);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "pnpm" && args.includes("config")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ name: "Kanna", runtimeVersion: "1.0.0" }),
          stderr: "",
        };
      }
      if (command === "gcloud" && options.onGcloud) return options.onGcloud(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
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
      input: { staging: true, production: false, dryRun: true, rollbackTo: undefined, ref: undefined },
    });
    expect(parseCliArgs(["mobile", "ota", "publish", "--production", "--ref", "release/0.2"])).toEqual({
      taskId: "mobile.ota.publish",
      input: {
        staging: false,
        production: true,
        dryRun: false,
        rollbackTo: undefined,
        ref: "release/0.2",
      },
    });
    expect(() => parseCliArgs(["mobile", "ota", "publish", "--production", "--ref"])).toThrow(
      "--ref requires a value"
    );
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
        if (command === "git") return gitResult(args);
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
    expect(calls[1]).toMatchObject({
      command: "git",
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      cwd: repoRoot,
    });
    expect(calls[2]).toMatchObject({ command: "pnpm", cwd: join(repoRoot, "apps/mobile") });
    expect(calls[3]).toMatchObject({
      command: "pnpm",
      args: ["exec", "expo", "config", "--type", "public", "--json"],
      cwd: join(repoRoot, "apps/mobile"),
      env: { KANNA_APP_ENV: "staging" },
    });
    expect(calls.some((call) => call.command === "gcloud")).toBe(false);
    expect(result.message).toContain("Dry run: mobile OTA update");
    expect(result.message).toContain(`Source: HEAD (${SHORT_HEAD_COMMIT})`);
    expect(result.message).toContain("curl -H 'expo-protocol-version: 1'");
  });

  it("rejects publish before export when the committed certificate is invalid", async () => {
    const repoRoot = await makeRepoFixture({ certificatePem: "not a certificate" });
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return command === "git" ? gitResult(args) : { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(executeMobileOtaPublishWithContext(
      { staging: true, production: false, dryRun: true },
      { repoRoot, env: {}, runner }
    )).rejects.toThrow("not valid X.509");
    expect(calls).toEqual([
      { command: "git", args: ["status", "--porcelain"] },
      { command: "git", args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"] },
    ]);
  });

  it("surfaces Expo public config command failures before cloud access", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "git") return gitResult(args);
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
        if (command === "git") return gitResult(args);
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
        if (command === "git") return gitResult(args);
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
      source: { ref: "HEAD", commit: HEAD_COMMIT, shortCommit: SHORT_HEAD_COMMIT },
    });
    expect(result.message).toContain(`Dry run: mobile OTA update ${expectedUpdateId}`);
  });

  it("requires an explicit --ref to publish to the production channel", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return command === "git" ? gitResult(args) : { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(
      executeMobileOtaPublishWithContext(
        { staging: false, production: true, dryRun: true },
        { repoRoot, env: {}, runner }
      )
    ).rejects.toThrow("mobile ota publish --production requires --ref <branch|tag|sha>");
    expect(calls).toEqual([]);
  });

  it("publishes to staging without a --ref and reports the resolved HEAD", async () => {
    const repoRoot = await makeRepoFixture();
    const runner = publishRunner(repoRoot);

    const result = await executeMobileOtaPublishWithContext(
      { staging: true, production: false, dryRun: true },
      { repoRoot, env: {}, runner }
    );

    expect(result.message).toContain(`Source: HEAD (${SHORT_HEAD_COMMIT})`);
    expect(result.data).toMatchObject({
      source: { ref: "HEAD", commit: HEAD_COMMIT, shortCommit: SHORT_HEAD_COMMIT },
    });
  });

  it("rolls a production channel back without a --ref", async () => {
    const repoRoot = await makeRepoFixture();
    const runner = publishRunner(repoRoot);

    const result = await executeMobileOtaPublishWithContext(
      {
        staging: false,
        production: true,
        dryRun: true,
        rollbackTo: "11111111-2222-3333-4444-555555555555",
      },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Dry run: mobile OTA rollback");
  });

  it("refuses to publish from a dirty git worktree", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return command === "git"
          ? gitResult(args, { status: " M apps/mobile/src/App.tsx\n" })
          : { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(
      executeMobileOtaPublishWithContext(
        { staging: true, production: false, dryRun: true },
        { repoRoot, env: {}, runner }
      )
    ).rejects.toThrow("Refusing to run mobile ota publish from a dirty git worktree");
    expect(calls).toEqual([{ command: "git", args: ["status", "--porcelain"] }]);
  });

  it("refuses a --ref that is not the checked-out commit", async () => {
    const repoRoot = await makeRepoFixture();
    const runner: CommandRunner = {
      async run(command, args) {
        return command === "git"
          ? gitResult(args, { commits: { HEAD: HEAD_COMMIT, "release/0.2": "1".repeat(40) } })
          : { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(
      executeMobileOtaPublishWithContext(
        { staging: false, production: true, dryRun: true, ref: "release/0.2" },
        { repoRoot, env: {}, runner }
      )
    ).rejects.toThrow("--ref release/0.2");
  });

  it("records the resolved source commit in the channel pointer and the update itself", async () => {
    const repoRoot = await makeRepoFixture();
    const uploads: Array<{ args: string[] }> = [];
    const runner = publishRunner(repoRoot, {
      commits: { HEAD: HEAD_COMMIT, "release/0.2": HEAD_COMMIT },
      onGcloud: (args) => {
        uploads.push({ args });
        // A missing metadata.json is what makes the publish upload the update.
        if (args[1] === "ls") return { exitCode: 1, stdout: "", stderr: "not found" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const result = await executeMobileOtaPublishWithContext(
      { staging: false, production: true, ref: "release/0.2" },
      { repoRoot, env: {}, runner }
    );

    expect(result.message).toContain(`Source: release/0.2 (${SHORT_HEAD_COMMIT})`);
    expect(result.data).toMatchObject({
      source: { ref: "release/0.2", commit: HEAD_COMMIT, shortCommit: SHORT_HEAD_COMMIT },
    });

    const rsync = uploads.find((call) => call.args[1] === "rsync");
    expect(rsync).toBeDefined();
    const sourceRecord = JSON.parse(
      await readFile(join(rsync?.args[3] ?? "", "kanna-source.json"), "utf8")
    ) as Record<string, unknown>;
    expect(sourceRecord).toEqual({
      updateId: (result.data as { updateId: string }).updateId,
      ref: "release/0.2",
      commit: HEAD_COMMIT,
      shortCommit: SHORT_HEAD_COMMIT,
    });

    const pointerUpload = uploads.find((call) => call.args[1] === "cp");
    expect(pointerUpload).toBeDefined();
    const pointer = JSON.parse(
      await readFile(pointerUpload?.args[2] ?? "", "utf8")
    ) as Record<string, unknown>;
    expect(pointer).toMatchObject({
      currentUpdateId: (result.data as { updateId: string }).updateId,
      runtimeVersion: "1.0.0",
      sourceRef: "release/0.2",
      sourceCommit: HEAD_COMMIT,
    });
  });

  it("provisions a missing staging OTA bucket and relay storage access", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const requests: Array<{
      url: string;
      method: "POST";
      headers: Record<string, string>;
      body: unknown;
    }> = [];
    const serviceAccount = "kanna-relay-staging@kanna-staging.iam.gserviceaccount.com";
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joined = args.join(" ");
        if (joined.includes("storage buckets describe")) {
          return { exitCode: 1, stdout: "", stderr: "not found: 404" };
        }
        if (joined.includes("auth print-access-token")) {
          return { exitCode: 0, stdout: "test-access-token\n", stderr: "" };
        }
        if (joined.includes("compute instances describe")) {
          return { exitCode: 0, stdout: `${serviceAccount}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await getMobileOtaProvisionExecutor()(
      { staging: true, production: false },
      {
        repoRoot,
        env: {},
        runner,
        async request(input) {
          requests.push(input);
          return { ok: true, status: 200, body: "{}" };
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(calls.map(({ args }) => args)).toContainEqual([
      "services", "enable", "storage.googleapis.com", "firebasestorage.googleapis.com",
      "--project", "kanna-staging",
    ]);
    expect(calls.map(({ args }) => args)).toContainEqual([
      "auth", "print-access-token",
    ]);
    expect(calls.some(({ args }) => args.includes("create"))).toBe(false);
    expect(requests).toEqual([{
      url: "https://firebasestorage.googleapis.com/v1alpha/projects/kanna-staging/defaultBucket",
      method: "POST",
      headers: {
        authorization: "Bearer test-access-token",
        "content-type": "application/json",
      },
      body: { location: "US-CENTRAL1" },
    }]);
    expect(calls.map(({ args }) => args)).toContainEqual([
      "storage", "buckets", "add-iam-policy-binding",
      "gs://kanna-staging.firebasestorage.app", "--project", "kanna-staging",
      "--member", `serviceAccount:${serviceAccount}`,
      "--role", "roles/storage.objectViewer",
    ]);
    expect(result.message).toContain("kanna-staging.firebasestorage.app");
    expect(result.message).toContain(serviceAccount);
  });

  it("reuses an existing staging OTA bucket", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    let requested = false;
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joined = args.join(" ");
        if (joined.includes("storage buckets describe")) {
          return { exitCode: 0, stdout: "{}", stderr: "" };
        }
        if (joined.includes("compute instances describe")) {
          return {
            exitCode: 0,
            stdout: "kanna-relay-staging@kanna-staging.iam.gserviceaccount.com\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await getMobileOtaProvisionExecutor()(
      { staging: true, production: false },
      {
        repoRoot,
        env: {},
        runner,
        async request() {
          requested = true;
          return { ok: true, status: 200, body: "{}" };
        },
      }
    );

    expect(calls.some(({ args }) => args.includes("create"))).toBe(false);
    expect(calls.some(({ args }) => args.includes("print-access-token"))).toBe(false);
    expect(requested).toBe(false);
  });

  it("does not create an OTA bucket when bucket inspection is forbidden", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (args.join(" ").includes("storage buckets describe")) {
          return { exitCode: 1, stdout: "", stderr: "PERMISSION_DENIED" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(getMobileOtaProvisionExecutor()(
      { staging: true, production: false },
      { repoRoot, env: {}, runner }
    )).rejects.toThrow("PERMISSION_DENIED");
    expect(calls.some(({ args }) => args.includes("create"))).toBe(false);
    expect(calls.some(({ args }) => args.includes("print-access-token"))).toBe(false);
  });

  it("stops before IAM and hides the access token when Firebase bucket provisioning fails", async () => {
    const repoRoot = await makeRepoFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joined = args.join(" ");
        if (joined.includes("storage buckets describe")) {
          return { exitCode: 1, stdout: "", stderr: "not found: 404" };
        }
        if (joined.includes("auth print-access-token")) {
          return { exitCode: 0, stdout: "test-access-token\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = getMobileOtaProvisionExecutor()(
      { staging: true, production: false },
      {
        repoRoot,
        env: {},
        runner,
        async request() {
          return {
            ok: false,
            status: 400,
            body: "Blaze plan required; token=test-access-token",
          };
        },
      }
    );

    await expect(result).rejects.toThrow(
      "Firebase default-bucket provisioning failed (HTTP 400): Blaze plan required; token=[redacted]"
    );
    await expect(result).rejects.not.toThrow("test-access-token");
    expect(calls.some(({ args }) => args.includes("add-iam-policy-binding"))).toBe(false);
  });

  it("requires exactly one environment for OTA infrastructure provisioning", async () => {
    const repoRoot = await makeRepoFixture();
    const runner: CommandRunner = {
      async run() {
        throw new Error("cloud command must not run");
      },
    };
    const executeProvision = getMobileOtaProvisionExecutor();

    await expect(executeProvision(
      { staging: false, production: false },
      { repoRoot, env: {}, runner }
    )).rejects.toThrow("mobile ota provision requires --staging or --production");
    await expect(executeProvision(
      { staging: true, production: true },
      { repoRoot, env: {}, runner }
    )).rejects.toThrow("mobile ota provision accepts only one of --staging or --production");
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
          return { exitCode: 1, stdout: "", stderr: "not found: 404" };
        }
        if (args.includes("instances") && args.includes("describe")) {
          return { exitCode: 0, stdout: "relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await executeMobileOtaProvisionSecretWithContext(
      { staging: true, production: false, keyPath },
      { repoRoot, env: {}, runner, validateOtaCertificate: acceptOtaCertificate }
    );

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.args)).toContainEqual([
      "services", "enable", "secretmanager.googleapis.com", "--project", "kanna-staging",
    ]);
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).toContain("secrets create kanna-mobile-ota-private-key-pem");
    expect(calls.map((call) => call.args.slice(0, 4).join(" "))).toContain("secrets versions add kanna-mobile-ota-private-key-pem");
    expect(calls.at(-1)?.args).toContain("roles/secretmanager.secretAccessor");
  });

  it("rejects provision-secret before cloud commands when the key mismatches", async () => {
    const repoRoot = await makeRepoFixture();
    const keyPath = join(repoRoot, "mismatched-private-key.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(
      keyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(executeMobileOtaProvisionSecretWithContext(
      { staging: true, production: false, keyPath },
      { repoRoot, env: {}, runner }
    )).rejects.toThrow("does not match the committed mobile OTA certificate");
    expect(calls).toEqual([]);
  });

  it("does not create or version an OTA secret when secret inspection is forbidden", async () => {
    const repoRoot = await makeRepoFixture();
    const keyPath = join(repoRoot, "ota-private-key.pem");
    await writeFile(keyPath, "private key");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (args.includes("describe") && args.includes("kanna-mobile-ota-private-key-pem")) {
          return { exitCode: 1, stdout: "", stderr: "PERMISSION_DENIED" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(executeMobileOtaProvisionSecretWithContext(
      { staging: true, production: false, keyPath },
      { repoRoot, env: {}, runner, validateOtaCertificate: acceptOtaCertificate }
    )).rejects.toThrow("PERMISSION_DENIED");
    expect(calls.some(({ args }) => args.includes("create"))).toBe(false);
    expect(calls.some(({ args }) => args.includes("versions"))).toBe(false);
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
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              bindings: [{
                role: "roles/secretmanager.secretAccessor",
                members: ["serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com"],
              }],
            }),
            stderr: "",
          };
        }
        if (command === "gcloud" && joined.includes("storage buckets get-iam-policy gs://kanna-staging.firebasestorage.app")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              bindings: [{
                role: "roles/storage.objectViewer",
                members: ["serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com"],
              }],
            }),
            stderr: "",
          };
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
    const iamCalls = calls.filter((call) => call.args.includes("get-iam-policy"));
    expect(iamCalls).toHaveLength(2);
    for (const call of iamCalls) {
      expect(call.args).toContain("--format=json");
      expect(call.args.some((arg) => arg.startsWith("--filter"))).toBe(false);
      expect(call.args.some((arg) => arg.startsWith("--flatten"))).toBe(false);
    }
  });

  it("reports an invalid committed certificate as a read-only doctor failure", async () => {
    const repoRoot = await makeRepoFixture({ certificatePem: "not a certificate" });
    const calls: Array<{ command: string; args: string[] }> = [];
    const pointer = {
      currentUpdateId: "11111111-2222-3333-4444-555555555555",
      createdAt: "2026-06-30T00:00:00.000Z",
      runtimeVersion: "1.0.0",
    };
    const member = "serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com";
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joined = args.join(" ");
        if (command === "gcloud" && joined.includes("channels/staging.json")) {
          return { exitCode: 0, stdout: JSON.stringify(pointer), stderr: "" };
        }
        if (command === "gcloud" && joined.includes("updates/11111111-2222-3333-4444-555555555555/")) {
          return { exitCode: 0, stdout: "{}", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("secrets describe")) {
          return { exitCode: 0, stdout: "{}", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("compute instances describe")) {
          return { exitCode: 0, stdout: "relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("get-iam-policy")) {
          const role = joined.includes("secrets get-iam-policy")
            ? "roles/secretmanager.secretAccessor"
            : "roles/storage.objectViewer";
          return {
            exitCode: 0,
            stdout: JSON.stringify({ bindings: [{ role, members: [member] }] }),
            stderr: "",
          };
        }
        if (command === "curl") {
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${command} ${joined}` };
      },
    };

    const result = await executeMobileOtaDoctorWithContext(
      { staging: true, production: false },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("FAIL certificate");
    expect(result.message).toContain("not valid X.509");
    expect(calls.some(({ args }) => args.includes("cp"))).toBe(false);
    expect(calls.some(({ args }) => args.includes("rsync"))).toBe(false);
    expect(calls.some(({ args }) => args.includes("create"))).toBe(false);
    expect(calls.some(({ args }) => args.includes("add-iam-policy-binding"))).toBe(false);
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
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              bindings: [{
                role: "roles/secretmanager.secretAccessor",
                members: ["serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com"],
              }],
            }),
            stderr: "",
          };
        }
        if (command === "gcloud" && joined.includes("storage buckets get-iam-policy gs://kanna-staging.firebasestorage.app")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              bindings: [{
                role: "roles/storage.objectViewer",
                members: ["serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com"],
              }],
            }),
            stderr: "",
          };
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

  it("rejects a relay storage member bound to the wrong IAM role", async () => {
    const repoRoot = await makeRepoFixture();
    const member = "serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com";
    const pointer = {
      currentUpdateId: "11111111-2222-3333-4444-555555555555",
      runtimeVersion: "1.0.0",
    };
    const runner: CommandRunner = {
      async run(command, args) {
        const joined = args.join(" ");
        if (command === "gcloud" && joined.includes("channels/staging.json")) {
          return { exitCode: 0, stdout: JSON.stringify(pointer), stderr: "" };
        }
        if (command === "gcloud" && joined.includes("updates/11111111-2222-3333-4444-555555555555/")) {
          return { exitCode: 0, stdout: "{}", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("secrets describe")) {
          return { exitCode: 0, stdout: "{}", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("compute instances describe")) {
          return { exitCode: 0, stdout: "relay-sa@kanna-staging.iam.gserviceaccount.com\n", stderr: "" };
        }
        if (command === "gcloud" && joined.includes("secrets get-iam-policy")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              bindings: [{ role: "roles/secretmanager.secretAccessor", members: [member] }],
            }),
            stderr: "",
          };
        }
        if (command === "gcloud" && joined.includes("storage buckets get-iam-policy")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              bindings: [{ role: "roles/storage.objectCreator", members: [member] }],
            }),
            stderr: "",
          };
        }
        if (command === "curl") {
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${command} ${joined}` };
      },
    };

    const result = await executeMobileOtaDoctorWithContext(
      { staging: true, production: false },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("FAIL GCS IAM");
  });
});
