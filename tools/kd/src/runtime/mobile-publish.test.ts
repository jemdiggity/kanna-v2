import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli";
import { parseAltoolDeliveryUuid } from "./mobile-archive";
import {
  executeMobilePublishWithContext,
  executeMobileVerifyWithContext,
  formatRemainingHumanSteps,
  publishRecordPath,
  publishTagName,
  type AppStoreConnectApi,
  type MobilePublishContext,
  type MobilePublishInput,
  type MobilePublishRecord
} from "./mobile-publish";
import type { CommandRunner } from "./process";

const HEAD_COMMIT = "9c8b7a6d5e4f30210123456789abcdef01234567";
const SHORT_COMMIT = HEAD_COMMIT.slice(0, 12);
const BUNDLE_ID = "build.kanna.app";
const IPA_BYTES = "kanna-ipa";

interface PublishFixture {
  repoRoot: string;
  outDir: string;
  calls: string[];
  apiCalls: string[];
  context: MobilePublishContext;
  cleanup: () => Promise<void>;
}

interface FixtureOptions {
  /** Build numbers already uploaded to App Store Connect for 1.0.0. */
  existingBuilds?: Array<{ id: string; version: string; processingState: string }>;
  /** Processing states returned by successive findBuild polls. */
  processingStates?: string[];
  appStoreVersion?: { id: string; versionString: string } | null;
  status?: string;
  tagExists?: boolean;
  uploadExitCode?: number;
  uploadStdout?: string;
  verifyOk?: boolean;
  archiveOk?: boolean;
}

async function publishFixture(options: FixtureOptions = {}): Promise<PublishFixture> {
  const repoRoot = await mkdtemp(join(tmpdir(), "kanna-publish-"));
  await mkdir(join(repoRoot, "apps/mobile/src"), { recursive: true });
  await writeFile(join(repoRoot, "VERSION"), "0.0.67\n");
  await writeFile(join(repoRoot, "apps/mobile/VERSION"), "1.0.0\n");
  await writeFile(
    join(repoRoot, "apps/mobile/src/mobileEnvironments.json"),
    JSON.stringify({ prod: { name: "prod", displayName: "Kanna", iosBundleId: BUNDLE_ID } })
  );
  const outDir = join(repoRoot, ".build/mobile/ios-production");
  await mkdir(join(outDir, "export"), { recursive: true });
  await writeFile(join(outDir, "export", "Kanna.ipa"), IPA_BYTES);

  const calls: string[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: options.status ?? "", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        const target = args[args.length - 1];
        if (target.startsWith("refs/tags/")) {
          return options.tagExists
            ? { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
      }
      if (command === "xcrun" && args[0] === "--find") {
        return { exitCode: 0, stdout: "/Applications/Xcode.app/.../altool", stderr: "" };
      }
      if (command === "xcrun" && args[0] === "altool") {
        return {
          exitCode: options.uploadExitCode ?? 0,
          stdout: options.uploadStdout ?? "Delivery UUID: 4bd1e79a-1234-4b0f-9d63-6c0d1f2a3b4c\nUPLOAD SUCCEEDED",
          stderr: options.uploadExitCode ? "altool exploded" : ""
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };

  const apiCalls: string[] = [];
  let pollIndex = 0;
  const processingStates = options.processingStates ?? ["VALID"];
  const api: AppStoreConnectApi = {
    async findAppId(bundleId) {
      apiCalls.push(`findAppId ${bundleId}`);
      return "app-222";
    },
    async listBuilds({ version }) {
      apiCalls.push(`listBuilds ${version}`);
      return options.existingBuilds ?? [];
    },
    async findBuild({ buildNumber }) {
      apiCalls.push(`findBuild ${buildNumber}`);
      const state = processingStates[Math.min(pollIndex, processingStates.length - 1)];
      pollIndex += 1;
      return state === "MISSING" ? null : { id: "build-77", version: buildNumber, processingState: state };
    },
    async findAppStoreVersion({ version }) {
      apiCalls.push(`findAppStoreVersion ${version}`);
      return options.appStoreVersion === undefined
        ? { id: "asv-9", versionString: version }
        : options.appStoreVersion;
    },
    async attachBuildToAppStoreVersion({ appStoreVersionId, buildId }) {
      apiCalls.push(`attach ${buildId} -> ${appStoreVersionId}`);
    },
    async setReleaseType({ appStoreVersionId, releaseType }) {
      apiCalls.push(`setReleaseType ${releaseType} on ${appStoreVersionId}`);
    }
  };

  const context: MobilePublishContext = {
    repoRoot,
    env: {
      APP_STORE_CONNECT_API_KEY_ID: "KEY",
      APP_STORE_CONNECT_API_ISSUER_ID: "ISSUER"
    },
    runner,
    createAppStoreConnectApi: async () => api,
    archive: async () => ({
      ok: options.archiveOk !== false,
      message: options.archiveOk === false ? "xcodebuild failed" : "Built mobile production archive 1.0.0 (3)."
    }),
    verify: async ({ ipaPath }) => ({
      ok: options.verifyOk !== false,
      ipaPath,
      sha256: await hashOf(ipaPath),
      appPath: join(ipaPath, "Payload/Kanna.app"),
      checks:
        options.verifyOk === false
          ? [{ status: "FAIL" as const, name: "1024 marketing icon", detail: "has an alpha channel" }]
          : [{ status: "PASS" as const, name: "codesign authority", detail: "Apple Distribution" }]
    }),
    sleep: async () => undefined,
    now: () => new Date("2026-08-18T12:00:00.000Z"),
    processingTimeoutMs: 1000,
    processingPollIntervalMs: 1
  };

  return {
    repoRoot,
    outDir,
    calls,
    apiCalls,
    context,
    cleanup: () => rm(repoRoot, { recursive: true, force: true })
  };
}

async function hashOf(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function publishInput(overrides: Partial<MobilePublishInput> = {}): MobilePublishInput {
  return { production: true, ref: "release/0.2", buildNumber: "3", ...overrides };
}

async function readRecord(outDir: string): Promise<MobilePublishRecord> {
  return JSON.parse(await readFile(publishRecordPath(outDir, "1.0.0"), "utf8")) as MobilePublishRecord;
}

describe("kd mobile publish — CLI", () => {
  it("parses the publish command", () => {
    expect(
      parseCliArgs([
        "mobile",
        "publish",
        "--production",
        "--ref",
        "release/0.2",
        "--build-number",
        "auto",
        "--release-type",
        "MANUAL",
        "--dry-run"
      ])
    ).toEqual({
      taskId: "mobile.publish",
      input: {
        production: true,
        ref: "release/0.2",
        buildNumber: "auto",
        releaseType: "MANUAL",
        dryRun: true,
        forceRebuild: false,
        allowNonReleaseRef: false
      }
    });
    expect(() => parseCliArgs(["mobile", "publish", "--production", "--rollback-to", "1"])).toThrow(
      "mobile publish only accepts"
    );
  });

  it("parses the standalone verify command and requires an IPA", () => {
    expect(
      parseCliArgs(["mobile", "verify", "--ipa", "/tmp/Kanna.ipa", "--build-number", "3"])
    ).toEqual({
      taskId: "mobile.verify",
      input: { ipa: "/tmp/Kanna.ipa", buildNumber: "3" }
    });
    expect(() => parseCliArgs(["mobile", "verify"])).toThrow("mobile verify requires --ipa");
  });
});

describe("kd mobile publish — refusals", () => {
  it("requires --production", async () => {
    const fixture = await publishFixture();
    try {
      await expect(
        executeMobilePublishWithContext(publishInput({ production: false }), fixture.context)
      ).rejects.toThrow("mobile publish requires --production");
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires a build number and refuses a non-numeric one", async () => {
    const fixture = await publishFixture();
    try {
      await expect(
        executeMobilePublishWithContext(publishInput({ buildNumber: undefined }), fixture.context)
      ).rejects.toThrow("requires --build-number <number> or --build-number auto");
      await expect(
        executeMobilePublishWithContext(publishInput({ buildNumber: "3a" }), fixture.context)
      ).rejects.toThrow("must be numeric");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a ref that is not a release branch", async () => {
    const fixture = await publishFixture();
    try {
      await expect(
        executeMobilePublishWithContext(publishInput({ ref: "main" }), fixture.context)
      ).rejects.toThrow("requires a release branch");
      // Deliberate override still works.
      const result = await executeMobilePublishWithContext(
        publishInput({ ref: "main", allowNonReleaseRef: true, dryRun: true }),
        fixture.context
      );
      expect(result.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a dirty worktree before touching App Store Connect", async () => {
    const fixture = await publishFixture({ status: " M apps/mobile/app.config.ts\n" });
    try {
      await expect(
        executeMobilePublishWithContext(publishInput(), fixture.context)
      ).rejects.toThrow("dirty git worktree");
      expect(fixture.apiCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a build number App Store Connect has already consumed", async () => {
    const fixture = await publishFixture({
      existingBuilds: [
        { id: "b1", version: "2", processingState: "VALID" },
        { id: "b2", version: "10", processingState: "VALID" }
      ]
    });
    try {
      await expect(
        executeMobilePublishWithContext(publishInput({ buildNumber: "3" }), fixture.context)
      ).rejects.toThrow("is not above the highest already uploaded for 1.0.0 (10)");
      await expect(
        executeMobilePublishWithContext(publishInput({ buildNumber: "10" }), fixture.context)
      ).rejects.toThrow("--build-number 11 or --build-number auto");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an unknown --release-type before doing anything", async () => {
    const fixture = await publishFixture();
    try {
      await expect(
        executeMobilePublishWithContext(publishInput({ releaseType: "immediately" }), fixture.context)
      ).rejects.toThrow("--release-type must be one of");
      expect(fixture.apiCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("hard-fails on a verification failure and never uploads", async () => {
    const fixture = await publishFixture({ verifyOk: false });
    try {
      const result = await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Pre-upload verification failed; nothing was uploaded.");
      expect(result.message).toContain("FAIL 1024 marketing icon");
      expect(fixture.calls.some((call) => call.startsWith("xcrun altool"))).toBe(false);
      const record = await readRecord(fixture.outDir);
      expect(record.completedStages).not.toContain("upload");
    } finally {
      await fixture.cleanup();
    }
  });

  it("stops at a failed archive without uploading", async () => {
    const fixture = await publishFixture({ archiveOk: false });
    try {
      const result = await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Archive failed; nothing was uploaded.");
      expect(fixture.calls.some((call) => call.startsWith("xcrun altool"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses to continue when the IPA no longer hashes to the recorded value", async () => {
    const fixture = await publishFixture();
    try {
      await mkdir(fixture.outDir, { recursive: true });
      await writeFile(
        publishRecordPath(fixture.outDir, "1.0.0"),
        JSON.stringify({
          version: "1.0.0",
          buildNumber: "3",
          bundleId: BUNDLE_ID,
          ref: "release/0.2",
          commit: HEAD_COMMIT,
          shortCommit: SHORT_COMMIT,
          ipaSha256: "0".repeat(64),
          startedAt: "2026-08-18T11:00:00.000Z",
          updatedAt: "2026-08-18T11:00:00.000Z",
          completedStages: ["resolve", "build-number", "archive", "verify"]
        })
      );

      const result = await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("A different binary is on disk");
      expect(fixture.calls.some((call) => call.startsWith("xcrun altool"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports a build App Store Connect rejected during processing", async () => {
    const fixture = await publishFixture({ processingStates: ["PROCESSING", "INVALID"] });
    try {
      const result = await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("INVALID");
      expect(result.message).toContain("publish a new build number");
    } finally {
      await fixture.cleanup();
    }
  });

  it("stops with instructions when there is no App Store version to attach to", async () => {
    const fixture = await publishFixture({ appStoreVersion: null });
    try {
      const result = await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("has no 1.0.0 App Store version to attach it to");
      const record = await readRecord(fixture.outDir);
      // The expensive work is banked so a rerun resumes at attach.
      expect(record.completedStages).toContain("upload");
      expect(record.completedStages).toContain("wait");
      expect(record.completedStages).not.toContain("attach");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("kd mobile publish — plan and dry run", () => {
  it("resolves everything and performs nothing", async () => {
    const fixture = await publishFixture({ existingBuilds: [{ id: "b", version: "2", processingState: "VALID" }] });
    try {
      const result = await executeMobilePublishWithContext(
        publishInput({ buildNumber: "auto", dryRun: true, releaseType: "MANUAL" }),
        fixture.context
      );

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Dry run: mobile publish 1.0.0 (3)");
      expect(result.message).toContain(`Source: release/0.2 (${SHORT_COMMIT})`);
      expect(result.message).toContain("set release type MANUAL");
      expect(result.message).toContain("tag mobile-v1.0.0-3");
      expect(result.message).toContain("Export compliance");
      expect(fixture.calls.some((call) => call.startsWith("xcrun altool"))).toBe(false);
      expect(fixture.apiCalls).toEqual(["findAppId build.kanna.app", "listBuilds 1.0.0"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("auto picks the next build number above the highest already uploaded", async () => {
    const fixture = await publishFixture({
      existingBuilds: [
        { id: "b1", version: "9", processingState: "VALID" },
        { id: "b2", version: "10", processingState: "VALID" }
      ]
    });
    try {
      const result = await executeMobilePublishWithContext(
        publishInput({ buildNumber: "auto", dryRun: true }),
        fixture.context
      );

      expect(result.message).toContain("Dry run: mobile publish 1.0.0 (11)");
    } finally {
      await fixture.cleanup();
    }
  });

  it("names every step it deliberately leaves to a human", () => {
    const unset = formatRemainingHumanSteps({ version: "1.0.0", buildNumber: "3", releaseTypeSet: false });
    expect(unset).toContain("Export compliance");
    expect(unset).toContain("left untouched");
    expect(unset).toContain("Submit for review. Irreversible");

    expect(
      formatRemainingHumanSteps({ version: "1.0.0", buildNumber: "3", releaseTypeSet: true })
    ).toContain("set as requested");
  });
});

describe("kd mobile publish — the happy path", () => {
  it("runs every stage, records the publish, and tags the commit", async () => {
    const fixture = await publishFixture();
    try {
      const result = await executeMobilePublishWithContext(
        publishInput({ releaseType: "AFTER_APPROVAL" }),
        fixture.context
      );

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Published mobile 1.0.0 (3) to App Store Connect.");
      expect(result.message).toContain("Release type set to AFTER_APPROVAL.");
      expect(result.message).toContain("Submit for review. Irreversible");

      expect(fixture.apiCalls).toEqual([
        "findAppId build.kanna.app",
        "listBuilds 1.0.0",
        "findBuild 3",
        "findAppStoreVersion 1.0.0",
        "attach build-77 -> asv-9",
        "setReleaseType AFTER_APPROVAL on asv-9"
      ]);

      const record = await readRecord(fixture.outDir);
      expect(record).toMatchObject({
        version: "1.0.0",
        buildNumber: "3",
        bundleId: BUNDLE_ID,
        ref: "release/0.2",
        commit: HEAD_COMMIT,
        shortCommit: SHORT_COMMIT,
        deliveryUuid: "4bd1e79a-1234-4b0f-9d63-6c0d1f2a3b4c",
        ascAppId: "app-222",
        ascBuildId: "build-77",
        appStoreVersionId: "asv-9",
        releaseType: "AFTER_APPROVAL"
      });
      expect(record.ipaSha256).toBe(await hashOf(join(fixture.outDir, "export/Kanna.ipa")));
      expect(record.completedStages).toEqual([
        "resolve",
        "build-number",
        "archive",
        "verify",
        "upload",
        "wait",
        "attach",
        "tag"
      ]);

      // The annotated tag carries the record verbatim and is pushed.
      const tagCall = fixture.calls.find((call) => call.startsWith("git tag -a"));
      expect(tagCall).toContain(`mobile-v1.0.0-3 ${HEAD_COMMIT}`);
      expect(tagCall).toContain('"ipaSha256"');
      expect(fixture.calls).toContain("git push origin refs/tags/mobile-v1.0.0-3");
    } finally {
      await fixture.cleanup();
    }
  });

  it("leaves the release type untouched when none was named", async () => {
    const fixture = await publishFixture();
    try {
      const result = await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Release type left untouched.");
      expect(fixture.apiCalls.some((call) => call.startsWith("setReleaseType"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("polls until processing finishes", async () => {
    const fixture = await publishFixture({
      processingStates: ["MISSING", "PROCESSING", "PROCESSING", "VALID"]
    });
    try {
      const result = await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(result.ok).toBe(true);
      expect(fixture.apiCalls.filter((call) => call === "findBuild 3")).toHaveLength(4);
    } finally {
      await fixture.cleanup();
    }
  });

  it("records an unknown delivery uuid rather than failing", async () => {
    const fixture = await publishFixture({ uploadStdout: "UPLOAD SUCCEEDED with 0 warnings" });
    try {
      await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect((await readRecord(fixture.outDir)).deliveryUuid).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("kd mobile publish — resume", () => {
  it("resumes after a failed upload without redoing the archive's build number choice", async () => {
    const failed = await publishFixture({ uploadExitCode: 1 });
    try {
      const first = await executeMobilePublishWithContext(
        publishInput({ buildNumber: "auto" }),
        failed.context
      );
      expect(first.ok).toBe(false);
      expect(first.message).toContain("Upload failed for 1.0.0 (1).");
      const record = await readRecord(failed.outDir);
      expect(record.buildNumber).toBe("1");
      expect(record.completedStages).toEqual(["resolve", "build-number", "archive", "verify"]);
    } finally {
      await failed.cleanup();
    }
  });

  it("keeps the recorded build number on an auto rerun instead of consuming another", async () => {
    const fixture = await publishFixture();
    try {
      await mkdir(fixture.outDir, { recursive: true });
      await writeFile(
        publishRecordPath(fixture.outDir, "1.0.0"),
        JSON.stringify({
          version: "1.0.0",
          buildNumber: "7",
          bundleId: BUNDLE_ID,
          ref: "release/0.2",
          commit: HEAD_COMMIT,
          shortCommit: SHORT_COMMIT,
          startedAt: "2026-08-18T11:00:00.000Z",
          updatedAt: "2026-08-18T11:00:00.000Z",
          completedStages: ["resolve", "build-number"]
        })
      );

      const result = await executeMobilePublishWithContext(
        publishInput({ buildNumber: "auto" }),
        fixture.context
      );

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Published mobile 1.0.0 (7)");
      // No listBuilds call: the number was already chosen and banked.
      expect(fixture.apiCalls).not.toContain("listBuilds 1.0.0");
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips the upload and the wait when the record says they succeeded", async () => {
    const fixture = await publishFixture();
    try {
      await mkdir(fixture.outDir, { recursive: true });
      await writeFile(
        publishRecordPath(fixture.outDir, "1.0.0"),
        JSON.stringify({
          version: "1.0.0",
          buildNumber: "3",
          bundleId: BUNDLE_ID,
          ref: "release/0.2",
          commit: HEAD_COMMIT,
          shortCommit: SHORT_COMMIT,
          ipaSha256: await hashOf(join(fixture.outDir, "export/Kanna.ipa")),
          ascBuildId: "build-77",
          deliveryUuid: "4bd1e79a-1234-4b0f-9d63-6c0d1f2a3b4c",
          startedAt: "2026-08-18T11:00:00.000Z",
          updatedAt: "2026-08-18T11:00:00.000Z",
          completedStages: ["resolve", "build-number", "archive", "verify", "upload", "wait"]
        })
      );

      const result = await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(result.ok).toBe(true);
      expect(fixture.calls.some((call) => call.startsWith("xcrun altool"))).toBe(false);
      expect(fixture.apiCalls).toEqual([
        "findAppId build.kanna.app",
        "findAppStoreVersion 1.0.0",
        "attach build-77 -> asv-9"
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("starts a fresh record when a different build number is named", async () => {
    const fixture = await publishFixture({
      existingBuilds: [{ id: "b", version: "3", processingState: "VALID" }]
    });
    try {
      await mkdir(fixture.outDir, { recursive: true });
      await writeFile(
        publishRecordPath(fixture.outDir, "1.0.0"),
        JSON.stringify({
          version: "1.0.0",
          buildNumber: "3",
          bundleId: BUNDLE_ID,
          ref: "release/0.2",
          commit: HEAD_COMMIT,
          shortCommit: SHORT_COMMIT,
          startedAt: "2026-08-18T11:00:00.000Z",
          updatedAt: "2026-08-18T11:00:00.000Z",
          completedStages: ["resolve", "build-number", "archive", "verify", "upload", "wait", "attach", "tag"]
        })
      );

      const result = await executeMobilePublishWithContext(
        publishInput({ buildNumber: "4" }),
        fixture.context
      );

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Published mobile 1.0.0 (4)");
      expect(fixture.apiCalls).toContain("listBuilds 1.0.0");
      expect(fixture.calls.some((call) => call.startsWith("xcrun altool"))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not re-create a tag that already exists but still pushes it", async () => {
    const fixture = await publishFixture({ tagExists: true });
    try {
      await executeMobilePublishWithContext(publishInput(), fixture.context);

      expect(fixture.calls.some((call) => call.startsWith("git tag -a"))).toBe(false);
      expect(fixture.calls).toContain("git push origin refs/tags/mobile-v1.0.0-3");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("kd mobile verify — standalone", () => {
  it("defaults the expectation from the repo and reports the sha256", async () => {
    const fixture = await publishFixture();
    try {
      const ipaPath = join(fixture.outDir, "export", "Kanna.ipa");
      const seen: Array<{ bundleId: string; version: string; buildNumber?: string }> = [];
      const result = await executeMobileVerifyWithContext(
        { ipa: ipaPath },
        {
          repoRoot: fixture.repoRoot,
          env: {},
          runner: fixture.context.runner,
          verify: async ({ expected }) => {
            seen.push(expected);
            return {
              ok: true,
              ipaPath,
              sha256: await hashOf(ipaPath),
              appPath: `${ipaPath}/Payload/Kanna.app`,
              checks: [{ status: "PASS", name: "codesign authority", detail: "Apple Distribution" }]
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      expect(seen).toEqual([{ bundleId: BUNDLE_ID, version: "1.0.0", buildNumber: undefined }]);
      expect(result.message).toContain(await hashOf(ipaPath));
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires --ipa and a numeric --build-number", async () => {
    const fixture = await publishFixture();
    const context = { repoRoot: fixture.repoRoot, env: {}, runner: fixture.context.runner };
    try {
      await expect(executeMobileVerifyWithContext({}, context)).rejects.toThrow(
        "mobile verify requires --ipa"
      );
      await expect(
        executeMobileVerifyWithContext({ ipa: "/tmp/a.ipa", buildNumber: "three" }, context)
      ).rejects.toThrow("must be numeric");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("publish naming and altool output", () => {
  it("names the record and the tag deterministically", () => {
    expect(publishRecordPath("/out", "1.0.0")).toBe("/out/publish-1.0.0.json");
    expect(publishTagName("1.0.0", "3")).toBe("mobile-v1.0.0-3");
  });

  it("reads the delivery uuid from either altool spelling", () => {
    expect(parseAltoolDeliveryUuid("DELIVERY_UUID: 4bd1e79a-1234-4b0f-9d63-6c0d1f2a3b4c")).toBe(
      "4bd1e79a-1234-4b0f-9d63-6c0d1f2a3b4c"
    );
    expect(parseAltoolDeliveryUuid("Delivery UUID 4BD1E79A-1234-4B0F-9D63-6C0D1F2A3B4C")).toBe(
      "4bd1e79a-1234-4b0f-9d63-6c0d1f2a3b4c"
    );
    expect(parseAltoolDeliveryUuid("UPLOAD SUCCEEDED with 0 warnings")).toBeNull();
  });
});
