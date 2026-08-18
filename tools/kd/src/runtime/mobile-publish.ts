import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppStoreConnectClient,
  highestBuildNumber,
  parseReleaseType,
  resolveAppStoreConnectCredentials,
  type AscAppStoreVersion,
  type AscBuild,
  type AscReleaseType
} from "./app-store-connect";
import {
  assertUploaderAvailable,
  buildAltoolUploadCommand,
  executeMobileIosArchiveWithContext,
  parseAltoolDeliveryUuid,
  readCurrentVersion,
  readMobileProductionIdentity,
  resolveOutDir
} from "./mobile-archive";
import {
  formatMobileVerifyResult,
  verifyMobileIpa,
  type MobileVerifyResult
} from "./mobile-verify";
import type { CommandRunner } from "./process";
import { isReleaseBranchName } from "./release-lineage";
import { formatSourceRef, resolveSourceRef, type ResolvedSourceRef } from "./source-ref";

/**
 * `kd mobile publish` — one durable, auditable operation for shipping an iOS
 * build to App Store Connect.
 *
 * It replaces a sequence of hand-run steps that shipped Kanna Mobile 1.0.0
 * three times over two days: create a worktree at the right ref, archive,
 * hand-verify the IPA, upload, poll for processing, attach the build in the web
 * UI. Two of those hand-checks caught real defects, and the first submission
 * was built from `main` rather than `release/0.2` and had to be withdrawn.
 *
 * Three things stay human on purpose and are only printed, never performed:
 * export compliance (a legal attestation), the release type (a judgement call,
 * settable only through an explicit `--release-type`), and submit-for-review
 * (an irreversible external action).
 */

export interface MobilePublishInput {
  production: boolean;
  ref?: string;
  /** A numeric build number, or `auto` to take the next one after the highest already used. */
  buildNumber?: string;
  version?: string;
  outDir?: string;
  releaseType?: string;
  /** Bypass the release-branch requirement; the built-from-main incident is why it exists. */
  allowNonReleaseRef?: boolean;
  forceRebuild?: boolean;
  dryRun?: boolean;
}

/** The App Store Connect surface publish needs; `AppStoreConnectClient` satisfies it. */
export interface AppStoreConnectApi {
  findAppId: (bundleId: string) => Promise<string>;
  listBuilds: (input: { appId: string; version: string }) => Promise<AscBuild[]>;
  findBuild: (input: {
    appId: string;
    version: string;
    buildNumber: string;
  }) => Promise<AscBuild | null>;
  findAppStoreVersion: (input: {
    appId: string;
    version: string;
  }) => Promise<AscAppStoreVersion | null>;
  attachBuildToAppStoreVersion: (input: {
    appStoreVersionId: string;
    buildId: string;
  }) => Promise<void>;
  setReleaseType: (input: {
    appStoreVersionId: string;
    releaseType: AscReleaseType;
  }) => Promise<void>;
}

export interface MobilePublishContext {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  /** Injected by tests; defaults to a real App Store Connect client. */
  createAppStoreConnectApi?: () => Promise<AppStoreConnectApi>;
  archive?: typeof executeMobileIosArchiveWithContext;
  verify?: typeof verifyMobileIpa;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  /** Bounds the processing poll so a stuck build fails instead of hanging. */
  processingTimeoutMs?: number;
  processingPollIntervalMs?: number;
}

export type MobilePublishStage =
  | "resolve"
  | "build-number"
  | "archive"
  | "verify"
  | "upload"
  | "wait"
  | "attach"
  | "tag";

/**
 * The durable publish record.
 *
 * Written after every stage so a rerun resumes rather than redoes, and copied
 * verbatim into the annotated git tag, which is the git-native ledger. The IPA
 * sha256 closes the "uploaded a different binary than the one verified" class
 * of error: the upload stage refuses to run if the bytes on disk no longer
 * hash to what verification signed off on.
 */
export interface MobilePublishRecord {
  version: string;
  buildNumber: string;
  bundleId: string;
  ref: string;
  commit: string;
  shortCommit: string;
  ipaPath?: string;
  ipaSha256?: string;
  deliveryUuid?: string | null;
  ascAppId?: string;
  ascBuildId?: string;
  appStoreVersionId?: string;
  releaseType?: string;
  startedAt: string;
  updatedAt: string;
  completedStages: MobilePublishStage[];
}

const DEFAULT_PROCESSING_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_PROCESSING_POLL_INTERVAL_MS = 30 * 1000;
const TERMINAL_FAILURE_STATES = new Set(["FAILED", "INVALID"]);

export function publishRecordPath(outDir: string, version: string): string {
  return join(outDir, `publish-${version}.json`);
}

export function publishTagName(version: string, buildNumber: string): string {
  return `mobile-v${version}-${buildNumber}`;
}

function isDone(record: MobilePublishRecord, stage: MobilePublishStage): boolean {
  return record.completedStages.includes(stage);
}

function markDone(record: MobilePublishRecord, stage: MobilePublishStage, at: string): void {
  if (!record.completedStages.includes(stage)) {
    record.completedStages.push(stage);
  }
  record.updatedAt = at;
}

async function readPublishRecord(path: string): Promise<MobilePublishRecord | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as MobilePublishRecord;
    if (!parsed.version || !parsed.buildNumber || !Array.isArray(parsed.completedStages)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writePublishRecord(path: string, record: MobilePublishRecord): Promise<void> {
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

function failure(message: string, data?: unknown): { ok: false; message: string; data?: unknown } {
  return { ok: false, message, data };
}

/**
 * The steps a person still owns. Printed at the end of every successful publish
 * and in every dry run, so the operator never has to remember what the tool
 * deliberately did not do.
 */
export function formatRemainingHumanSteps(input: {
  version: string;
  buildNumber: string;
  releaseTypeSet: boolean;
}): string {
  return [
    "Still human — kd deliberately does not do these:",
    "  1. Export compliance. A legal attestation about encryption; answer it yourself in App Store Connect.",
    input.releaseTypeSet
      ? "  2. Release type is set as requested; confirm it reads the way you intended."
      : "  2. Release type. A judgement call, left untouched; pass --release-type to set it.",
    `  3. Submit for review. Irreversible; submit ${input.version} (${input.buildNumber}) from App Store Connect when you are ready.`
  ].join("\n");
}

function assertReleaseRef(source: ResolvedSourceRef, allowNonReleaseRef: boolean): void {
  if (isReleaseBranchName(source.ref) || allowNonReleaseRef) return;
  throw new Error(
    `mobile publish requires a release branch, but --ref ${source.ref} is not one (expected release/X.Y). ` +
      "The first Kanna Mobile 1.0.0 submission was built from main, carried an unreleased feature, and had " +
      "to be withdrawn. Pass --allow-non-release-ref to override deliberately."
  );
}

function resolveRequestedBuildNumber(raw: string | undefined): { auto: boolean; explicit?: string } {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      "mobile publish requires --build-number <number> or --build-number auto. " +
        "Auto is opt-in because a build number is irreversibly consumed once uploaded."
    );
  }
  if (value.toLowerCase() === "auto") return { auto: true };
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`mobile publish --build-number must be numeric or "auto", got: ${raw}`);
  }
  return { auto: false, explicit: value };
}

async function defaultCreateAppStoreConnectApi(
  env: NodeJS.ProcessEnv
): Promise<AppStoreConnectApi> {
  const credentials = await resolveAppStoreConnectCredentials(env, { command: "mobile publish" });
  return new AppStoreConnectClient({ credentials });
}

async function waitForProcessedBuild(input: {
  api: AppStoreConnectApi;
  appId: string;
  version: string;
  buildNumber: string;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<{ ok: true; build: AscBuild } | { ok: false; message: string }> {
  const deadline = input.now().getTime() + input.timeoutMs;
  for (;;) {
    const build = await input.api.findBuild({
      appId: input.appId,
      version: input.version,
      buildNumber: input.buildNumber
    });
    if (build && build.processingState === "VALID") {
      return { ok: true, build };
    }
    if (build && TERMINAL_FAILURE_STATES.has(build.processingState)) {
      return {
        ok: false,
        message:
          `App Store Connect reports build ${input.version} (${input.buildNumber}) as ` +
          `${build.processingState}. Apple emails the reason; fix it and publish a new build number.`
      };
    }
    if (input.now().getTime() >= deadline) {
      return {
        ok: false,
        message:
          `Timed out after ${Math.round(input.timeoutMs / 60000)} minutes waiting for build ` +
          `${input.version} (${input.buildNumber}) to finish processing` +
          `${build ? ` (last state ${build.processingState})` : " (it has not appeared yet)"}. ` +
          "The upload is recorded; rerun `kd mobile publish` to resume from the wait stage."
      };
    }
    await input.sleep(input.pollIntervalMs);
  }
}

export async function executeMobilePublishWithContext(
  input: MobilePublishInput,
  context: MobilePublishContext
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  if (!input.production) {
    throw new Error("mobile publish requires --production.");
  }
  const releaseType = input.releaseType ? parseReleaseType(input.releaseType) : undefined;
  const requested = resolveRequestedBuildNumber(input.buildNumber);
  const now = context.now ?? (() => new Date());
  const sleep =
    context.sleep ?? ((milliseconds: number) => new Promise((r) => setTimeout(r, milliseconds)));
  const archive = context.archive ?? executeMobileIosArchiveWithContext;
  const verify = context.verify ?? verifyMobileIpa;

  // --- resolve -------------------------------------------------------------
  const source = await resolveSourceRef({
    repoRoot: context.repoRoot,
    runner: context.runner,
    env: context.env,
    ref: input.ref,
    requireRef: true,
    command: "mobile publish"
  });
  assertReleaseRef(source, input.allowNonReleaseRef === true);

  const version = input.version?.trim() || (await readCurrentVersion(context.repoRoot));
  const identity = await readMobileProductionIdentity(context.repoRoot);
  const outDir = resolveOutDir(context.repoRoot, input.outDir);
  const recordPath = publishRecordPath(outDir, version);

  const api = await (context.createAppStoreConnectApi
    ? context.createAppStoreConnectApi()
    : defaultCreateAppStoreConnectApi(context.env));
  const appId = await api.findAppId(identity.bundleId);

  // --- build-number --------------------------------------------------------
  const existing = await readPublishRecord(recordPath);
  // A record is resumable when it describes the same publish: same commit, and
  // either the operator named its build number again or asked for auto, which
  // must not silently consume a second number mid-resume.
  const resumable =
    existing !== null &&
    existing.commit === source.commit &&
    (requested.auto || requested.explicit === existing.buildNumber);

  let record: MobilePublishRecord;
  if (resumable && existing) {
    record = existing;
  } else {
    const builds = await api.listBuilds({ appId, version });
    const highest = highestBuildNumber(builds);
    let buildNumber: string;
    if (requested.auto) {
      buildNumber = String(highest + 1);
    } else {
      buildNumber = requested.explicit as string;
      if (Number.parseInt(buildNumber, 10) <= highest) {
        throw new Error(
          `Build number ${buildNumber} is not above the highest already uploaded for ${version} (${highest}). ` +
            "App Store Connect refuses a repeated build number. Pass --build-number " +
            `${highest + 1} or --build-number auto.`
        );
      }
    }
    const startedAt = now().toISOString();
    record = {
      version,
      buildNumber,
      bundleId: identity.bundleId,
      ref: source.ref,
      commit: source.commit,
      shortCommit: source.shortCommit,
      ascAppId: appId,
      startedAt,
      updatedAt: startedAt,
      completedStages: []
    };
    markDone(record, "resolve", startedAt);
    markDone(record, "build-number", startedAt);
  }
  record.ascAppId = appId;
  if (releaseType) record.releaseType = releaseType;

  if (input.dryRun === true) {
    return {
      ok: true,
      message: [
        `Dry run: mobile publish ${record.version} (${record.buildNumber})`,
        formatSourceRef(source),
        `Bundle ID: ${record.bundleId} (App Store Connect app ${appId})`,
        resumable
          ? `Resuming the record at ${recordPath}; completed: ${record.completedStages.join(", ") || "none"}`
          : `New publish record at ${recordPath}`,
        "Would run: archive → verify → upload (altool) → wait for processing → attach" +
          (releaseType ? ` → set release type ${releaseType}` : "") +
          ` → tag ${publishTagName(record.version, record.buildNumber)}`,
        formatRemainingHumanSteps({
          version: record.version,
          buildNumber: record.buildNumber,
          releaseTypeSet: releaseType !== undefined
        })
      ].join("\n"),
      data: { record, appId, dryRun: true }
    };
  }

  await mkdir(outDir, { recursive: true });
  await writePublishRecord(recordPath, record);

  // --- archive -------------------------------------------------------------
  const archivePlan = {
    production: true,
    ref: source.ref,
    buildNumber: record.buildNumber,
    version: record.version,
    outDir: input.outDir,
    upload: false,
    forceRebuild: input.forceRebuild
  };
  const archiveResult = await archive(archivePlan, {
    repoRoot: context.repoRoot,
    env: context.env,
    runner: context.runner
  });
  if (!archiveResult.ok) {
    return failure(`Archive failed; nothing was uploaded.\n${archiveResult.message}`, {
      record,
      archiveResult
    });
  }
  const ipaPath = join(outDir, "export", "Kanna.ipa");
  record.ipaPath = ipaPath;
  markDone(record, "archive", now().toISOString());
  await writePublishRecord(recordPath, record);

  // --- verify --------------------------------------------------------------
  // Deliberately re-run on every attempt rather than skipped when already
  // recorded: verification is the guard, not the work, and it costs seconds.
  const verification: MobileVerifyResult = await verify({
    ipaPath,
    expected: {
      bundleId: record.bundleId,
      version: record.version,
      buildNumber: record.buildNumber,
      // Version and build number do not identify a commit, and reuse keys on
      // exactly those two. Without this an archive left by an earlier attempt
      // at another commit would pass every other check and ship under this
      // publish's ref — the wrong-source incident, silently.
      sourceCommit: record.commit
    },
    runner: context.runner
  });
  if (!verification.ok) {
    return failure(
      ["Pre-upload verification failed; nothing was uploaded.", formatMobileVerifyResult(verification)].join(
        "\n"
      ),
      { record, verification }
    );
  }
  if (record.ipaSha256 && record.ipaSha256 !== verification.sha256) {
    return failure(
      `The IPA at ${ipaPath} now hashes to ${verification.sha256}, but this publish recorded ` +
        `${record.ipaSha256}. A different binary is on disk than the one this record describes. ` +
        `Delete ${recordPath} to start a fresh publish, or restore the verified artifact.`,
      { record, verification }
    );
  }
  record.ipaSha256 = verification.sha256;
  markDone(record, "verify", now().toISOString());
  await writePublishRecord(recordPath, record);

  // --- upload --------------------------------------------------------------
  if (!isDone(record, "upload")) {
    const apiKey = context.env.APP_STORE_CONNECT_API_KEY_ID?.trim();
    const apiIssuer = context.env.APP_STORE_CONNECT_API_ISSUER_ID?.trim();
    if (!apiKey || !apiIssuer) {
      throw new Error(
        "mobile publish requires APP_STORE_CONNECT_API_KEY_ID and APP_STORE_CONNECT_API_ISSUER_ID."
      );
    }
    await assertUploaderAvailable(context.runner);
    const uploadCommand = buildAltoolUploadCommand({
      repoRoot: context.repoRoot,
      ipaPath,
      apiKey,
      apiIssuer
    });
    const uploadResult = await context.runner.run(uploadCommand.command, uploadCommand.args, {
      cwd: uploadCommand.cwd,
      env: context.env,
      streamOutput: true
    });
    if (uploadResult.exitCode !== 0) {
      return failure(
        [
          `Upload failed for ${record.version} (${record.buildNumber}).`,
          uploadResult.stderr.trim() || uploadResult.stdout.trim() || "altool reported no output.",
          "If Apple in fact accepted the binary, the build number is consumed; publish the next one.",
          `Otherwise rerun \`kd mobile publish\` to resume from ${recordPath}.`
        ].join("\n"),
        { record, uploadResult }
      );
    }
    record.deliveryUuid = parseAltoolDeliveryUuid(`${uploadResult.stdout}\n${uploadResult.stderr}`);
    markDone(record, "upload", now().toISOString());
    await writePublishRecord(recordPath, record);
  }

  // --- wait ----------------------------------------------------------------
  if (!isDone(record, "wait")) {
    const processed = await waitForProcessedBuild({
      api,
      appId,
      version: record.version,
      buildNumber: record.buildNumber,
      sleep,
      now,
      timeoutMs: context.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS,
      pollIntervalMs: context.processingPollIntervalMs ?? DEFAULT_PROCESSING_POLL_INTERVAL_MS
    });
    if (!processed.ok) {
      await writePublishRecord(recordPath, record);
      return failure(processed.message, { record });
    }
    record.ascBuildId = processed.build.id;
    markDone(record, "wait", now().toISOString());
    await writePublishRecord(recordPath, record);
  }

  // --- attach --------------------------------------------------------------
  if (!isDone(record, "attach")) {
    const appStoreVersion = await api.findAppStoreVersion({ appId, version: record.version });
    if (!appStoreVersion) {
      await writePublishRecord(recordPath, record);
      return failure(
        `Build ${record.version} (${record.buildNumber}) is uploaded and processed, but App Store Connect ` +
          `has no ${record.version} App Store version to attach it to. Create it in App Store Connect, ` +
          "then rerun `kd mobile publish` to resume from the attach stage.",
        { record }
      );
    }
    if (!record.ascBuildId) {
      return failure(
        `The publish record has no App Store Connect build id for ${record.version} (${record.buildNumber}); ` +
          `delete ${recordPath} and republish.`,
        { record }
      );
    }
    await api.attachBuildToAppStoreVersion({
      appStoreVersionId: appStoreVersion.id,
      buildId: record.ascBuildId
    });
    record.appStoreVersionId = appStoreVersion.id;
    if (releaseType) {
      await api.setReleaseType({ appStoreVersionId: appStoreVersion.id, releaseType });
    }
    markDone(record, "attach", now().toISOString());
    await writePublishRecord(recordPath, record);
  }

  // --- tag -----------------------------------------------------------------
  const tag = publishTagName(record.version, record.buildNumber);
  if (!isDone(record, "tag")) {
    const tagged = await tagPublish({
      tag,
      record,
      repoRoot: context.repoRoot,
      env: context.env,
      runner: context.runner
    });
    if (!tagged.ok) {
      await writePublishRecord(recordPath, record);
      return failure(tagged.message, { record });
    }
    markDone(record, "tag", now().toISOString());
    await writePublishRecord(recordPath, record);
  }

  return {
    ok: true,
    message: [
      `Published mobile ${record.version} (${record.buildNumber}) to App Store Connect.`,
      formatSourceRef(source),
      `Bundle ID: ${record.bundleId}`,
      `IPA SHA-256: ${record.ipaSha256}`,
      `Delivery UUID: ${record.deliveryUuid ?? "not reported by altool"}`,
      `App Store Connect build: ${record.ascBuildId ?? "unknown"}`,
      `Attached to App Store version ${record.version} (${record.appStoreVersionId ?? "unknown"})`,
      releaseType ? `Release type set to ${releaseType}.` : "Release type left untouched.",
      `Ledger: git tag ${tag} at ${record.shortCommit}; record at ${recordPath}`,
      "",
      formatRemainingHumanSteps({
        version: record.version,
        buildNumber: record.buildNumber,
        releaseTypeSet: releaseType !== undefined
      })
    ].join("\n"),
    data: { record }
  };
}

/**
 * The git-native half of the ledger.
 *
 * The record file lives under `.build/`, which is disposable; the annotated tag
 * carries the same JSON at the resolved commit and is pushed, so the mapping
 * from an App Store build back to a commit survives the machine.
 */
async function tagPublish(input: {
  tag: string;
  record: MobilePublishRecord;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const existing = await input.runner.run(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/tags/${input.tag}`],
    { cwd: input.repoRoot, env: input.env }
  );
  if (existing.exitCode !== 0) {
    const created = await input.runner.run(
      "git",
      [
        "tag",
        "-a",
        input.tag,
        input.record.commit,
        "-m",
        JSON.stringify(input.record, null, 2)
      ],
      { cwd: input.repoRoot, env: input.env }
    );
    if (created.exitCode !== 0) {
      return {
        ok: false,
        message:
          `The build is uploaded, processed, and attached, but tagging ${input.tag} failed: ` +
          (created.stderr.trim() || created.stdout.trim() || "git tag failed.")
      };
    }
  }
  const pushed = await input.runner.run("git", ["push", "origin", `refs/tags/${input.tag}`], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (pushed.exitCode !== 0) {
    return {
      ok: false,
      message:
        `The build is uploaded, processed, and attached, and ${input.tag} exists locally, but ` +
        `pushing it failed: ${pushed.stderr.trim() || pushed.stdout.trim() || "git push failed."}`
    };
  }
  return { ok: true };
}

// --- standalone verification -----------------------------------------------

export interface MobileVerifyInput {
  ipa?: string;
  version?: string;
  buildNumber?: string;
}

/**
 * `kd mobile verify --ipa <path>` — the same five checks publish runs, exposed
 * on their own so an IPA built any other way can be held to the same bar.
 */
export async function executeMobileVerifyWithContext(
  input: MobileVerifyInput,
  context: { repoRoot: string; env: NodeJS.ProcessEnv; runner: CommandRunner; verify?: typeof verifyMobileIpa }
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const ipaPath = input.ipa?.trim();
  if (!ipaPath) {
    throw new Error("mobile verify requires --ipa <path>.");
  }
  const buildNumber = input.buildNumber?.trim();
  if (buildNumber && !/^[0-9]+$/.test(buildNumber)) {
    throw new Error(`mobile verify --build-number must be numeric, got: ${input.buildNumber}`);
  }
  const identity = await readMobileProductionIdentity(context.repoRoot);
  const version = input.version?.trim() || (await readCurrentVersion(context.repoRoot));
  const verify = context.verify ?? verifyMobileIpa;
  const result = await verify({
    ipaPath,
    expected: { bundleId: identity.bundleId, version, buildNumber: buildNumber || undefined },
    runner: context.runner
  });
  return { ok: result.ok, message: formatMobileVerifyResult(result), data: result };
}
