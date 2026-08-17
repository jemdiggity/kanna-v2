import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./process";
import {
  composePostPromotionTrunkBody,
  composeStagingChannelBody,
  evaluateCandidateLineage,
  evaluatePromotionGate,
  evaluateSoak,
  evaluateStagingPublishGate,
  isReleaseBranchName,
  normalizeStagingVersion,
  parseLineageResetRecord,
  parsePostPromotionTrunkRecord,
  type CandidateLineage,
  type LineageResetRecord,
  type PostPromotionTrunkRecord,
  type SoakEvaluation,
  type StagingCandidate,
  type StagingLineageRelationship
} from "./release-lineage";
import { readReleasePolicy, type ReleasePolicy } from "./release-policy";
import {
  preflightUpdaterSigningKey,
  resolveUpdaterSigningKey,
  updaterSignerEnvironment
} from "./updater-key";

export type ReleaseBump = "major" | "minor" | "patch";
export type ReleaseArchLabel = "arm64" | "x86_64";
export type ReleaseEnvironment = "production" | "staging";

/**
 * The git/GitHub facts every release command needs. `ReleaseShipInput`,
 * `ReleaseStatusInput`, and `ReleaseResetStagingInput` all satisfy it, so the
 * lineage and soak helpers run identically from ship, status, and promote.
 */
export interface ReleaseCommandContext {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface ReleaseShipInput {
  repoRoot: string;
  bump: ReleaseBump;
  archLabels: ReleaseArchLabel[];
  environment?: ReleaseEnvironment;
  release: boolean;
  dryRun: boolean;
  rollbackTo?: string;
  promoteFrom?: string;
  sourceBranch?: string;
  /** Explicit human reason for promoting before the policy soak window elapses. */
  soakOverrideReason?: string;
  /** Fixed clock for soak arithmetic; defaults to `Date.now()`. */
  now?: number;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface ReleaseShipResult {
  version: string;
  dmgPaths: string[];
  updaterPaths: string[];
  latestJson: string;
  /** Present when stale trunk VERSION was raised to the production floor. */
  versionFloor?: MainStagingVersionFloor;
}

const STAGING_CHANNEL_TAG = "desktop-staging";
const STAGING_MANIFEST_NAME = "latest-staging.json";
const STAGING_RETENTION_COUNT = 5;

export function bumpVersion(sourceVersion: string, bump: ReleaseBump): string {
  const [majorRaw, minorRaw, patchRaw] = sourceVersion.split(".");
  let major = Number.parseInt(majorRaw ?? "0", 10);
  let minor = Number.parseInt(minorRaw ?? "0", 10);
  let patch = Number.parseInt(patchRaw ?? "0", 10);
  if ([major, minor, patch].some(Number.isNaN)) {
    throw new Error(`Invalid VERSION: ${sourceVersion}`);
  }
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function releaseEnvironment(input: ReleaseEnvironment | undefined): ReleaseEnvironment {
  return input ?? "production";
}

function releaseOutputDir(repoRoot: string, environment: ReleaseEnvironment): string {
  return environment === "staging" ? join(repoRoot, ".build", "release", "staging") : join(repoRoot, ".build", "release");
}

export function releaseAssetName(version: string, label: ReleaseArchLabel, environment: ReleaseEnvironment = "production"): string {
  if (environment === "staging") return `Kanna_Staging_${version}_${label}.dmg`;
  return `Kanna_${version}_${label}.dmg`;
}

export function updaterAssetName(version: string, label: ReleaseArchLabel, environment: ReleaseEnvironment = "production"): string {
  if (environment === "staging") return `Kanna_Staging_${version}_${label}.app.tar.gz`;
  return `Kanna_${version}_${label}.app.tar.gz`;
}

export function updaterSignatureName(version: string, label: ReleaseArchLabel, environment: ReleaseEnvironment = "production"): string {
  return `${updaterAssetName(version, label, environment)}.sig`;
}

export function updaterPlatformKey(label: ReleaseArchLabel): string {
  return label === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
}

export function bazelTargetForLabel(label: ReleaseArchLabel, dryRun: boolean, environment: ReleaseEnvironment = "production"): string {
  if (environment === "staging") {
    return dryRun ? `//:kanna_signed_dmg_staging_${label}` : `//:kanna_notarized_dmg_staging_${label}`;
  }
  return dryRun ? `//:kanna_signed_dmg_release_${label}` : `//:kanna_notarized_dmg_release_${label}`;
}

export function signedAppTargetForLabel(label: ReleaseArchLabel, environment: ReleaseEnvironment = "production"): string {
  if (environment === "staging") {
    return label === "arm64" ? "//:kanna_signed_app_staging_arm64" : "//:kanna_signed_app_staging_x86_64";
  }
  return label === "arm64" ? "//:kanna_signed_app_release_arm64" : "//:kanna_signed_app_release_x86_64";
}

export function updaterBundleTargetForLabel(label: ReleaseArchLabel, environment: ReleaseEnvironment = "production"): string {
  if (environment === "staging") {
    return label === "arm64" ? "//:kanna_updater_bundle_staging_arm64" : "//:kanna_updater_bundle_staging_x86_64";
  }
  return label === "arm64" ? "//:kanna_updater_bundle_release_arm64" : "//:kanna_updater_bundle_release_x86_64";
}

export function releaseRepoSlug(remoteUrl: string): string {
  let normalized = remoteUrl.trim();
  if (normalized.startsWith("git@github.com:")) normalized = normalized.slice("git@github.com:".length);
  else if (normalized.startsWith("ssh://git@github.com/")) normalized = normalized.slice("ssh://git@github.com/".length);
  else if (normalized.startsWith("https://github.com/")) normalized = normalized.slice("https://github.com/".length);
  else throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
  return normalized.replace(/\.git$/, "");
}

function readCurrentVersion(repoRoot: string): string {
  return readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
}

function syncVersionFiles(repoRoot: string, version: string): void {
  writeFileSync(join(repoRoot, "VERSION"), `${version}\n`);
  const tauriPath = join(repoRoot, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const cargoPath = join(repoRoot, "apps", "desktop", "src-tauri", "Cargo.toml");
  writeFileSync(tauriPath, readFileSync(tauriPath, "utf8").replace(/"version": "[^"]*"/, `"version": "${version}"`));
  writeFileSync(cargoPath, readFileSync(cargoPath, "utf8").replace(/^version = "[^"]*"/m, `version = "${version}"`));
}

function versionFilePaths(repoRoot: string): string[] {
  return [
    join(repoRoot, "VERSION"),
    join(repoRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"),
    join(repoRoot, "apps", "desktop", "src-tauri", "Cargo.toml")
  ];
}

function snapshotVersionFiles(repoRoot: string): Array<{ path: string; contents: string }> {
  return versionFilePaths(repoRoot).map((path) => ({ path, contents: readFileSync(path, "utf8") }));
}

function restoreVersionFiles(snapshot: Array<{ path: string; contents: string }>): void {
  for (const file of snapshot) {
    writeFileSync(file.path, file.contents);
  }
}

function stagingTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

async function mustRun(runner: CommandRunner, command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runner.run(command, args, { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function assertCleanGitWorktree(repoRoot: string, runner: CommandRunner, env?: NodeJS.ProcessEnv): Promise<void> {
  const status = await mustRun(runner, "git", ["status", "--porcelain"], repoRoot, env);
  if (status.trim().length > 0) {
    throw new Error(
      "Refusing to ship a release from a dirty git worktree. Commit or stash changes first."
    );
  }
}

async function ensureStagingGithubRelease(input: ReleaseCommandContext, repoSlug: string): Promise<void> {
  const view = await input.runner.run("gh", ["release", "view", STAGING_CHANNEL_TAG, "--repo", repoSlug], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (view.exitCode === 0) return;

  await mustRun(input.runner, "gh", [
    "release",
    "create",
    STAGING_CHANNEL_TAG,
    "--repo",
    repoSlug,
    "--title",
    "Kanna Desktop Staging",
    "--notes",
    "Pointer-only desktop staging updater channel.",
    "--prerelease"
  ], input.repoRoot, input.env);
}

function parseExistingStagingNumbers(output: string, baseVersion: string): number[] {
  const pattern = new RegExp(`(?:refs/tags/)?v${baseVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-staging\\.(\\d+)(?:\\^\\{\\})?$`);
  const numbers = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const ref = line.trim().split(/\s+/).at(-1) ?? "";
    const match = pattern.exec(ref);
    if (!match) continue;
    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isNaN(value)) numbers.add(value);
  }
  return [...numbers];
}

async function resolveNextStagingVersion(input: ReleaseShipInput, baseVersion: string): Promise<string> {
  const tags = await mustRun(input.runner, "git", ["ls-remote", "--tags", "origin", `v${baseVersion}-staging.*`], input.repoRoot, input.env);
  const highest = Math.max(0, ...parseExistingStagingNumbers(tags, baseVersion));
  return `${baseVersion}-staging.${highest + 1}`;
}

export interface ReleaseSeries {
  major: number;
  minor: number;
}

export function releaseSeriesFromVersion(version: string): ReleaseSeries {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(version.replace(/^v/, ""));
  const major = Number.parseInt(match?.[1] ?? "", 10);
  const minor = Number.parseInt(match?.[2] ?? "", 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    throw new Error(`Invalid version: ${version}`);
  }
  return { major, minor };
}

export function releaseSeriesBranch(series: ReleaseSeries): string {
  return `release/${series.major}.${series.minor}`;
}

export function parseReleaseBranchSeries(branchName: string): ReleaseSeries | null {
  const match = /^release\/(\d+)\.(\d+)$/.exec(branchName.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return null;
  return { major, minor };
}

/**
 * Whether `git ls-remote --tags origin 'vX.Y.*'` output contains a real
 * production tag for the series. The glob matches prereleases too, so the
 * decision has to come from the ref names, not from the output being non-empty.
 */
export function hasProductionTagForSeries(tagsOutput: string, series: ReleaseSeries): boolean {
  const pattern = new RegExp(`^(?:refs/tags/)?v${series.major}\\.${series.minor}\\.(\\d+)(?:\\^\\{\\})?$`);
  return tagsOutput.split(/\r?\n/).some((line) => {
    const ref = line.trim().split(/\s+/).at(-1) ?? "";
    return pattern.test(ref);
  });
}

export function nextSeriesPatchVersion(tagsOutput: string, series: ReleaseSeries): string {
  const pattern = new RegExp(`^(?:refs/tags/)?v${series.major}\\.${series.minor}\\.(\\d+)(?:\\^\\{\\})?$`);
  const patches: number[] = [];
  for (const line of tagsOutput.split(/\r?\n/)) {
    const ref = line.trim().split(/\s+/).at(-1) ?? "";
    const match = pattern.exec(ref);
    if (!match) continue;
    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isNaN(value)) patches.push(value);
  }
  if (patches.length === 0) return `${series.major}.${series.minor}.0`;
  return `${series.major}.${series.minor}.${Math.max(...patches) + 1}`;
}

interface StagingContext {
  baseVersion: string;
  sourceBranch: string;
  commit: string;
  versionFloor: MainStagingVersionFloor | null;
}

export interface MainStagingVersionFloor {
  versionFile: string;
  latestProduction: string;
  baseVersion: string;
  detail: string;
}

export function deriveMainStagingBaseVersion(
  versionFile: string,
  latestProduction: string | null,
  bump: ReleaseBump
): { baseVersion: string; versionFloor: MainStagingVersionFloor | null } {
  const floorApplied = latestProduction !== null && compareVersions(versionFile, latestProduction) < 0;
  const sourceVersion = floorApplied ? latestProduction : versionFile;
  const baseVersion = bumpVersion(sourceVersion, bump);
  return {
    baseVersion,
    versionFloor: floorApplied && latestProduction
      ? {
          versionFile,
          latestProduction,
          baseVersion,
          detail:
            `VERSION ${versionFile} lags latest production v${latestProduction}; ` +
            `derived main staging version ${baseVersion} from the production floor.`
        }
      : null
  };
}

function parseLatestProductionVersion(raw: string): string | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Could not parse the latest production release from gh output.");
  if (parsed.length === 0) return null;
  const first = parsed[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("Could not parse the latest production release from gh output.");
  }
  const record = first as { tagName?: unknown; isPrerelease?: unknown };
  if (
    record.isPrerelease !== false ||
    typeof record.tagName !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(record.tagName)
  ) {
    throw new Error(`Latest production release metadata is invalid: ${raw}`);
  }
  return record.tagName.slice(1);
}

async function readLatestProductionVersion(input: ReleaseShipInput): Promise<string | null> {
  const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
  const repoSlug = releaseRepoSlug(remoteUrl);
  const raw = await mustRun(
    input.runner,
    "gh",
    [
      "release",
      "list",
      "--repo",
      repoSlug,
      "--limit",
      "1",
      "--exclude-drafts",
      "--exclude-pre-releases",
      "--json",
      "tagName,isPrerelease"
    ],
    input.repoRoot,
    input.env
  );
  return parseLatestProductionVersion(raw);
}

async function resolveStagingContext(input: ReleaseShipInput): Promise<StagingContext> {
  const requested = input.sourceBranch?.trim();
  let branchName: string;
  if (requested) {
    if (requested !== "main" && !parseReleaseBranchSeries(requested)) {
      throw new Error(`Invalid --branch ${requested}. Expected main or release/X.Y.`);
    }
    branchName = requested;
  } else {
    const currentBranch = await mustRun(input.runner, "git", ["rev-parse", "--abbrev-ref", "HEAD"], input.repoRoot, input.env);
    branchName = parseReleaseBranchSeries(currentBranch) ? currentBranch : "main";
  }

  const head = await mustRun(input.runner, "git", ["rev-parse", "HEAD"], input.repoRoot, input.env);

  if (branchName === "main") {
    const sourceVersion = readCurrentVersion(input.repoRoot);
    const derivation = deriveMainStagingBaseVersion(sourceVersion, await readLatestProductionVersion(input), input.bump);
    return { ...derivation, sourceBranch: "main", commit: head };
  }

  const series = parseReleaseBranchSeries(branchName);
  if (!series) {
    throw new Error(`Invalid release branch: ${branchName}`);
  }
  const branchRefs = await mustRun(input.runner, "git", ["ls-remote", "origin", `refs/heads/${branchName}`], input.repoRoot, input.env);
  const branchSha = branchRefs.trim().split(/\s+/)[0] ?? "";
  if (!branchSha) {
    throw new Error(`${branchName} does not exist on origin. Cut it first (kd release cut).`);
  }
  const abandoned = await readAbandonedSeries(input, branchName);
  if (abandoned) {
    throw new Error(
      `${branchName} was abandoned${abandoned.abandonedAt ? ` on ${abandoned.abandonedAt}` : ""}` +
        `${abandoned.reason ? `: ${abandoned.reason}` : "."} No release candidate ships from an abandoned series. ` +
        `Ship from the current series branch instead, or cut one (kd release cut --version X.Y.0).`
    );
  }
  await mustRun(input.runner, "git", ["fetch", "origin", branchName], input.repoRoot, input.env);
  // Exact provenance, not containment: a branch RC must be a build of the
  // remote branch tip itself. Containment let a worktree ship an RC carrying
  // commits that were never on the branch it claims as its promotion base, so
  // the recorded Source-Branch and the artifact could disagree.
  if (branchSha !== head) {
    throw new Error(
      `${branchName} tip (${branchSha}) is not HEAD (${head}). A release-branch RC must build the branch tip exactly. ` +
        `Push backports to ${branchName} first, then check this worktree out at that commit ` +
        `(git fetch origin ${branchName} && git checkout --detach FETCH_HEAD).`
    );
  }
  const tags = await mustRun(input.runner, "git", ["ls-remote", "--tags", "origin", `v${series.major}.${series.minor}.*`], input.repoRoot, input.env);
  return { baseVersion: nextSeriesPatchVersion(tags, series), sourceBranch: branchName, commit: head, versionFloor: null };
}

const SOURCE_BRANCH_TRAILER = "Source-Branch:";

export function parseSourceBranch(rawView: string): string | null {
  try {
    const parsed = JSON.parse(rawView) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const body = (parsed as { body?: unknown }).body;
    if (typeof body !== "string") return null;
    const match = /^Source-Branch:[ \t]*(\S+)[ \t]*$/m.exec(body);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface PromotionVersions {
  stagingVersion: string;
  stagingTag: string;
  productionVersion: string;
}

export function parsePromotionVersions(promoteFrom: string): PromotionVersions {
  const stagingVersion = promoteFrom.trim().replace(/^v/, "");
  const match = /^(\d+\.\d+\.\d+)-staging\.\d+$/.exec(stagingVersion);
  const productionVersion = match?.[1];
  if (!productionVersion) {
    throw new Error(`Invalid staging version to promote: ${promoteFrom}. Expected X.Y.Z-staging.N (a staging prerelease version).`);
  }
  return { stagingVersion, stagingTag: `v${stagingVersion}`, productionVersion };
}

interface StagingReleaseMetadata {
  tagName: string;
  targetCommitish: string;
  body: string;
  publishedAt: string | null;
  isPrerelease: boolean;
}

function parseStagingReleaseMetadata(raw: string): StagingReleaseMetadata {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const record = parsed as {
      tagName?: unknown;
      targetCommitish?: unknown;
      body?: unknown;
      publishedAt?: unknown;
      isPrerelease?: unknown;
    };
    if (
      typeof record.tagName !== "string" ||
      typeof record.targetCommitish !== "string" ||
      typeof record.body !== "string" ||
      typeof record.isPrerelease !== "boolean"
    ) {
      throw new Error("missing required fields");
    }
    return {
      tagName: record.tagName,
      targetCommitish: record.targetCommitish,
      body: record.body,
      publishedAt: typeof record.publishedAt === "string" ? record.publishedAt : null,
      isPrerelease: record.isPrerelease
    };
  } catch {
    throw new Error(`Could not read immutable staging release metadata from gh output: ${raw}`);
  }
}

function validateStagingReleaseMetadata(raw: string, stagingVersion: string): StagingCandidate {
  const tag = stagingTag(stagingVersion);
  const productionVersion = parsePromotionVersions(stagingVersion).productionVersion;
  const metadata = parseStagingReleaseMetadata(raw);
  if (metadata.tagName !== tag) {
    throw new Error(`Staging release metadata tag ${metadata.tagName} does not match selected tag ${tag}.`);
  }
  if (!metadata.isPrerelease) {
    throw new Error(`${tag} is not marked as a GitHub prerelease.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(metadata.targetCommitish)) {
    throw new Error(`${tag} targetCommitish is not an immutable full commit SHA: ${metadata.targetCommitish}`);
  }
  const expectedNotesPrefix = `Staging updater manifest for v${stagingVersion}`;
  if (
    metadata.body !== expectedNotesPrefix &&
    !metadata.body.startsWith(`${expectedNotesPrefix}\n`) &&
    !metadata.body.startsWith(`${expectedNotesPrefix}\r\n`)
  ) {
    throw new Error(`${tag} release notes do not identify the expected staging version ${stagingVersion}.`);
  }
  const sourceBranch = parseSourceBranch(raw);
  const expectedReleaseBranch = releaseSeriesBranch(releaseSeriesFromVersion(productionVersion));
  if (sourceBranch !== "main" && sourceBranch !== expectedReleaseBranch) {
    throw new Error(
      `${tag} has invalid or missing Source-Branch metadata; expected main or ${expectedReleaseBranch}.`
    );
  }
  return {
    version: stagingVersion,
    tag,
    commit: metadata.targetCommitish.toLowerCase(),
    sourceBranch,
    publishedAt: metadata.publishedAt
  };
}

function parseRemoteTagCommit(raw: string, tag: string): string | null {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  let direct: string | null = null;
  let peeled: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) continue;
    if (ref === directRef) direct = sha;
    if (ref === peeledRef) peeled = sha;
  }
  return peeled ?? direct;
}

function parseTargetCommitish(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && "targetCommitish" in parsed) {
      const commit = (parsed as { targetCommitish?: unknown }).targetCommitish;
      if (typeof commit === "string" && commit.trim().length > 0) return commit.trim();
    }
  } catch {
    // Fall through to the shared error below for unparseable gh output.
  }
  throw new Error(`Could not read targetCommitish from gh release view output: ${raw}`);
}

function parsePublishedAt(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { publishedAt?: unknown; createdAt?: unknown };
    if (typeof record.publishedAt === "string" && record.publishedAt.trim().length > 0) return record.publishedAt.trim();
    if (typeof record.createdAt === "string" && record.createdAt.trim().length > 0) return record.createdAt.trim();
    return null;
  } catch {
    return null;
  }
}

async function readStagingChannelBody(context: ReleaseCommandContext, repoSlug: string): Promise<string> {
  const view = await context.runner.run(
    "gh",
    ["release", "view", STAGING_CHANNEL_TAG, "--repo", repoSlug, "--json", "body"],
    { cwd: context.repoRoot, env: context.env }
  );
  if (view.exitCode !== 0) return "";
  try {
    const parsed = JSON.parse(view.stdout) as unknown;
    const body = typeof parsed === "object" && parsed !== null ? (parsed as { body?: unknown }).body : undefined;
    return typeof body === "string" ? body : "";
  } catch {
    return "";
  }
}

async function readLineageReset(context: ReleaseCommandContext, repoSlug: string): Promise<LineageResetRecord | null> {
  return parseLineageResetRecord(await readStagingChannelBody(context, repoSlug));
}

async function readLineageAudit(
  context: ReleaseCommandContext,
  repoSlug: string
): Promise<{ reset: LineageResetRecord | null; postPromotion: PostPromotionTrunkRecord | null }> {
  const body = await readStagingChannelBody(context, repoSlug);
  return {
    reset: parseLineageResetRecord(body),
    postPromotion: parsePostPromotionTrunkRecord(body)
  };
}

interface CandidateLookup {
  candidate: StagingCandidate | null;
  error: string | null;
}

async function readStagingCandidate(
  context: ReleaseCommandContext,
  repoSlug: string,
  version: string
): Promise<CandidateLookup> {
  const tag = stagingTag(version);
  const view = await context.runner.run(
    "gh",
    ["release", "view", tag, "--repo", repoSlug, "--json", "targetCommitish,body,publishedAt"],
    { cwd: context.repoRoot, env: context.env }
  );
  if (view.exitCode !== 0) {
    return {
      candidate: { version, tag, commit: null, sourceBranch: null, publishedAt: null },
      error: `prerelease ${tag} could not be read from GitHub`
    };
  }
  let commit: string | null = null;
  try {
    commit = parseTargetCommitish(view.stdout);
  } catch {
    commit = null;
  }
  return {
    candidate: {
      version,
      tag,
      commit,
      sourceBranch: parseSourceBranch(view.stdout),
      publishedAt: parsePublishedAt(view.stdout)
    },
    error: commit ? null : `prerelease ${tag} records no target commit`
  };
}

async function readVerifiedStagingCandidate(
  context: ReleaseCommandContext,
  repoSlug: string,
  version: string
): Promise<CandidateLookup> {
  const tag = stagingTag(version);
  const view = await context.runner.run(
    "gh",
    ["release", "view", tag, "--repo", repoSlug, "--json", "tagName,targetCommitish,body,publishedAt,isPrerelease"],
    { cwd: context.repoRoot, env: context.env }
  );
  if (view.exitCode !== 0) {
    return {
      candidate: { version, tag, commit: null, sourceBranch: null, publishedAt: null },
      error: `Staging prerelease not found: ${tag}`
    };
  }
  try {
    return { candidate: validateStagingReleaseMetadata(view.stdout, version), error: null };
  } catch (error) {
    let commit: string | null = null;
    try {
      commit = parseTargetCommitish(view.stdout);
    } catch {
      commit = null;
    }
    return {
      candidate: {
        version,
        tag,
        commit,
        sourceBranch: parseSourceBranch(view.stdout),
        publishedAt: parsePublishedAt(view.stdout)
      },
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readVersionedStagingManifestVersion(
  context: ReleaseCommandContext,
  repoSlug: string,
  tag: string
): Promise<string> {
  const manifestDir = mkdtempSync(join(tmpdir(), "kanna-release-candidate-"));
  try {
    const download = await context.runner.run(
      "gh",
      ["release", "download", tag, "--repo", repoSlug, "--pattern", STAGING_MANIFEST_NAME, "--dir", manifestDir, "--clobber"],
      { cwd: context.repoRoot, env: context.env }
    );
    if (download.exitCode !== 0) {
      throw new Error(
        `Staging manifest asset not found on ${tag}: ${download.stderr.trim() || download.stdout.trim() || STAGING_MANIFEST_NAME}`
      );
    }
    const manifestPath = join(manifestDir, STAGING_MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      throw new Error(`Staging manifest asset not found on ${tag}: ${STAGING_MANIFEST_NAME}`);
    }
    const version = parseManifestVersion(readFileSync(manifestPath, "utf8"));
    if (!version) throw new Error(`${tag}/${STAGING_MANIFEST_NAME} has no valid version.`);
    return version;
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
  }
}

async function verifyImmutableStagingCandidate(
  context: ReleaseCommandContext,
  repoSlug: string,
  candidate: StagingCandidate
): Promise<void> {
  if (!candidate.commit) {
    throw new Error(`${candidate.tag} records no target commit, so its immutable identity cannot be verified.`);
  }
  const manifestVersion = await readVersionedStagingManifestVersion(context, repoSlug, candidate.tag);
  if (manifestVersion !== candidate.version) {
    throw new Error(
      `${candidate.tag}/${STAGING_MANIFEST_NAME} version ${manifestVersion} does not match selected version ${candidate.version}.`
    );
  }
  const tagRefs = await mustRun(
    context.runner,
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/${candidate.tag}`, `refs/tags/${candidate.tag}^{}`],
    context.repoRoot,
    context.env
  );
  const remoteCommit = parseRemoteTagCommit(tagRefs, candidate.tag);
  if (!remoteCommit) throw new Error(`Immutable staging tag not found on origin: ${candidate.tag}`);
  if (remoteCommit.toLowerCase() !== candidate.commit.toLowerCase()) {
    throw new Error(
      `${candidate.tag} tag resolves to ${remoteCommit}, but its GitHub release metadata records ${candidate.commit}.`
    );
  }
  await mustRun(context.runner, "git", ["fetch", "--no-tags", "origin", `refs/tags/${candidate.tag}`], context.repoRoot, context.env);
  const fetchedCommit = await mustRun(context.runner, "git", ["rev-parse", "FETCH_HEAD^{commit}"], context.repoRoot, context.env);
  if (fetchedCommit.toLowerCase() !== candidate.commit.toLowerCase()) {
    throw new Error(
      `Fetched ${candidate.tag} resolves to ${fetchedCommit}, but its verified immutable commit is ${candidate.commit}.`
    );
  }
}

/**
 * The candidate `desktop-staging` currently serves. An uninitialized channel is
 * not an error: the first publish creates it, and the lookup reports no
 * candidate and no error. A channel we merely failed to read, or one whose
 * candidate's metadata cannot be resolved, reports an error — moving the
 * pointer would then be unverifiable, and every caller refuses on it.
 */
async function resolveActiveStagingCandidate(
  context: ReleaseCommandContext,
  repoSlug: string
): Promise<CandidateLookup> {
  const channel = await readStagingChannel(context, repoSlug);
  if (channel.state === "absent") return { candidate: null, error: null };
  if (channel.state === "unreadable") return { candidate: null, error: channel.error };
  return readStagingCandidate(context, repoSlug, channel.version);
}

async function commitRelationship(
  context: ReleaseCommandContext,
  base: string | null,
  candidate: string | null
): Promise<StagingLineageRelationship> {
  if (!base || !candidate) return "unknown";
  if (base === candidate) return "same-commit";
  const forward = await context.runner.run("git", ["merge-base", "--is-ancestor", base, candidate], {
    cwd: context.repoRoot,
    env: context.env
  });
  if (forward.exitCode === 0) return "descendant";
  // git exits 1 for "not an ancestor" and something else (128) when a commit is
  // missing locally; only the former is a real answer.
  if (forward.exitCode !== 1) return "unknown";
  const backward = await context.runner.run("git", ["merge-base", "--is-ancestor", candidate, base], {
    cwd: context.repoRoot,
    env: context.env
  });
  if (backward.exitCode === 0) return "behind";
  if (backward.exitCode !== 1) return "unknown";
  return "diverged";
}

async function fetchStagingHistory(context: ReleaseCommandContext): Promise<void> {
  // Best effort: lineage comparison needs the RC commits locally, and every RC
  // is tagged. A failure here degrades a relationship to "unknown", which the
  // gates already treat as a refusal rather than a pass.
  await context.runner.run("git", ["fetch", "--tags", "origin"], { cwd: context.repoRoot, env: context.env });
}

async function productionTagExists(context: ReleaseCommandContext, productionVersion: string): Promise<boolean> {
  const result = await context.runner.run("git", ["ls-remote", "--tags", "origin", `v${productionVersion}`], {
    cwd: context.repoRoot,
    env: context.env
  });
  if (result.exitCode !== 0) return false;
  return result.stdout.trim().length > 0;
}

/**
 * Whether the production release a staging candidate is a candidate *for*
 * already exists. A malformed channel version has no production line to check,
 * and is reported as unpromoted so the freeze rule stays conservative.
 */
async function activeProductionTagExists(context: ReleaseCommandContext, stagingVersion: string): Promise<boolean> {
  const productionVersion = productionVersionForStaging(stagingVersion);
  if (!productionVersion) return false;
  return productionTagExists(context, productionVersion);
}

function productionVersionForStaging(stagingVersion: string): string | null {
  return /^(\d+\.\d+\.\d+)-staging\.\d+$/.exec(stagingVersion.trim().replace(/^v/, ""))?.[1] ?? null;
}

/**
 * Resolve the narrow post-promotion hand-back to main. Every fact is checked
 * here before the pure lineage gate receives an authorization record:
 * production release metadata and both tag resolutions prove the tag is the RC
 * promotion (directly, or at kd's exact version-bump child), the recorded
 * release branch still resolves, and the proposed trunk commit is forward of
 * that branch's merge-base with origin/main.
 */
async function resolvePostPromotionTrunkRecord(
  context: ReleaseCommandContext & { now?: number },
  repoSlug: string,
  active: StagingCandidate,
  proposed: { sourceBranch: string; commit: string }
): Promise<PostPromotionTrunkRecord | null> {
  const activeSourceBranch = active.sourceBranch;
  if (proposed.sourceBranch !== "main" || !active.commit || !activeSourceBranch || !isReleaseBranchName(activeSourceBranch)) {
    return null;
  }
  const productionVersion = productionVersionForStaging(active.version);
  if (!productionVersion) return null;
  const productionTag = `v${productionVersion}`;

  try {
    const releaseView = await context.runner.run(
      "gh",
      ["release", "view", productionTag, "--repo", repoSlug, "--json", "tagName,targetCommitish,isPrerelease"],
      { cwd: context.repoRoot, env: context.env }
    );
    if (releaseView.exitCode !== 0) return null;
    const parsed = JSON.parse(releaseView.stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const metadata = parsed as { tagName?: unknown; targetCommitish?: unknown; isPrerelease?: unknown };
    if (
      metadata.tagName !== productionTag ||
      metadata.isPrerelease !== false ||
      typeof metadata.targetCommitish !== "string" ||
      metadata.targetCommitish.trim().length === 0
    ) {
      return null;
    }

    const tagRefs = await mustRun(
      context.runner,
      "git",
      ["ls-remote", "--tags", "origin", `refs/tags/${productionTag}`, `refs/tags/${productionTag}^{}`],
      context.repoRoot,
      context.env
    );
    const productionTagCommit = parseRemoteTagCommit(tagRefs, productionTag)?.toLowerCase() ?? null;
    if (!productionTagCommit) return null;
    await mustRun(
      context.runner,
      "git",
      ["fetch", "--no-tags", "origin", `refs/tags/${productionTag}`],
      context.repoRoot,
      context.env
    );
    const fetchedCommit = await mustRun(
      context.runner,
      "git",
      ["rev-parse", "FETCH_HEAD^{commit}"],
      context.repoRoot,
      context.env
    );
    if (fetchedCommit.toLowerCase() !== productionTagCommit) return null;
    if (productionTagCommit !== active.commit.toLowerCase()) {
      const parentLine = await mustRun(
        context.runner,
        "git",
        ["show", "-s", "--format=%P", "FETCH_HEAD"],
        context.repoRoot,
        context.env
      );
      const parents = parentLine.split(/\s+/).filter(Boolean);
      const subject = await mustRun(
        context.runner,
        "git",
        ["show", "-s", "--format=%s", "FETCH_HEAD"],
        context.repoRoot,
        context.env
      );
      if (parents.length !== 1 || parents[0]?.toLowerCase() !== active.commit.toLowerCase() || subject !== `release: ${productionTag}`) {
        return null;
      }
    }

    await mustRun(
      context.runner,
      "git",
      ["fetch", "origin", "main", activeSourceBranch],
      context.repoRoot,
      context.env
    );
    const originMain = await mustRun(context.runner, "git", ["rev-parse", "origin/main"], context.repoRoot, context.env);
    const originRelease = await mustRun(
      context.runner,
      "git",
      ["rev-parse", `origin/${activeSourceBranch}`],
      context.repoRoot,
      context.env
    );
    const mergeBase = await mustRun(
      context.runner,
      "git",
      ["merge-base", originMain, originRelease],
      context.repoRoot,
      context.env
    );
    if (!/^[0-9a-f]{40}$/i.test(mergeBase)) return null;
    const releaseContainsCandidate = await context.runner.run(
      "git",
      ["merge-base", "--is-ancestor", active.commit, originRelease],
      { cwd: context.repoRoot, env: context.env }
    );
    if (releaseContainsCandidate.exitCode !== 0) return null;
    const mainContainsBase = await context.runner.run(
      "git",
      ["merge-base", "--is-ancestor", mergeBase, originMain],
      { cwd: context.repoRoot, env: context.env }
    );
    if (mainContainsBase.exitCode !== 0) return null;
    const proposedDescendsFromBase = await context.runner.run(
      "git",
      ["merge-base", "--is-ancestor", mergeBase, proposed.commit],
      { cwd: context.repoRoot, env: context.env }
    );
    if (proposedDescendsFromBase.exitCode !== 0) return null;

    return {
      resumedAt: new Date(context.now ?? Date.now()).toISOString(),
      promotedVersion: productionVersion,
      promotedTag: productionTag,
      promotedCommit: active.commit.toLowerCase(),
      productionTagCommit,
      newCommit: proposed.commit.toLowerCase(),
      newBranch: proposed.sourceBranch
    };
  } catch (error) {
    throw new Error(
      `Could not verify whether ${productionTag} authorizes post-promotion trunk resumption: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

async function listStagingCandidateTags(context: ReleaseCommandContext, repoSlug: string): Promise<string[]> {
  const list = await context.runner.run(
    "gh",
    ["release", "list", "--repo", repoSlug, "--limit", "100", "--json", "tagName,createdAt"],
    { cwd: context.repoRoot, env: context.env }
  );
  if (list.exitCode !== 0) return [];
  return parseStagingReleaseList(list.stdout).sort(compareStagingReleasesDesc).map((release) => release.tag);
}

/**
 * The candidate published immediately before `tag` on the same channel. This is
 * what makes a divergence visible: the incident's v0.1.0-staging.8 was
 * mechanically aligned to its branch while sharing only an ancient merge base
 * with v0.1.0-staging.7.
 */
async function resolvePreviousCandidate(
  context: ReleaseCommandContext,
  repoSlug: string,
  tag: string
): Promise<{ previous: StagingCandidate | null; found: boolean }> {
  const tags = await listStagingCandidateTags(context, repoSlug);
  const index = tags.indexOf(tag);
  if (index < 0) return { previous: null, found: false };
  const previousTag = tags[index + 1];
  if (!previousTag) return { previous: null, found: true };
  const lookup = await readStagingCandidate(context, repoSlug, previousTag.replace(/^v/, ""));
  return { previous: lookup.candidate, found: true };
}

async function resolveCandidateLineage(
  context: ReleaseCommandContext,
  repoSlug: string,
  candidate: StagingCandidate,
  reset: LineageResetRecord | null,
  postPromotion: PostPromotionTrunkRecord | null = null
): Promise<CandidateLineage> {
  const { previous, found } = await resolvePreviousCandidate(context, repoSlug, candidate.tag);
  if (!found) {
    return {
      relationship: "unknown",
      previous: null,
      valid: false,
      authorizedByReset: false,
      authorizedByPromotion: false,
      reset,
      postPromotion,
      detail: `${candidate.tag} is not listed among this repository's staging prereleases, so its lineage cannot be established.`
    };
  }
  if (!previous) {
    return evaluateCandidateLineage({ candidate, previous: null, relationship: "initial", reset, postPromotion });
  }
  const relationship = await commitRelationship(context, previous.commit, candidate.commit);
  return evaluateCandidateLineage({
    candidate,
    previous: { version: previous.version, tag: previous.tag, commit: previous.commit },
    relationship,
    reset,
    postPromotion
  });
}

/**
 * Refuses a staging publish that would move the channel non-linearly, freeze an
 * active release soak, or ship against unverifiable channel metadata. Runs
 * before any build so a refusal costs seconds, not a signed build.
 */
async function assertStagingPublishAllowed(
  input: ReleaseShipInput,
  proposed: { sourceBranch: string; commit: string }
): Promise<PostPromotionTrunkRecord | null> {
  const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
  const repoSlug = releaseRepoSlug(remoteUrl);
  const active = await resolveActiveStagingCandidate(input, repoSlug);
  // A candidate we could not read still has to reach the gate: only a channel
  // positively known to be empty skips the comparison.
  if (!active.candidate && !active.error) return null;

  if (active.candidate) await fetchStagingHistory(input);
  const relationship = active.candidate
    ? await commitRelationship(input, active.candidate.commit, proposed.commit)
    : "unknown";
  const productionTagPresent = active.candidate
    ? await activeProductionTagExists(input, active.candidate.version)
    : false;
  const postPromotion = active.candidate && relationship === "diverged" && productionTagPresent
    ? await resolvePostPromotionTrunkRecord(input, repoSlug, active.candidate, proposed)
    : null;
  const audit = active.candidate ? await readLineageAudit(input, repoSlug) : { reset: null, postPromotion: null };
  const decision = evaluateStagingPublishGate({
    proposedSourceBranch: proposed.sourceBranch,
    proposedCommit: proposed.commit,
    active: active.candidate,
    relationship,
    activeProductionTagExists: productionTagPresent,
    activeMetadataError: active.error,
    reset: audit.reset,
    postPromotion
  });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? `Refusing to repoint ${STAGING_CHANNEL_TAG}.`);
  }
  return decision.authorizedByPromotion ? postPromotion : null;
}

interface ResolvedPromotion {
  version: string;
  pushBranch: string;
}

// Shared promotion-base semantics for promote and status. An RC promotes to its
// series branch only when the branch tip is exactly the RC commit (active
// stabilization, or the cut-at-RC-commit escape). An RC recorded as built from
// the series branch never falls back to main. Everything else — including a
// dormant series branch left behind by an earlier release — is a main RC and
// must match origin/main exactly.
interface PromotionBaseDecision {
  pushBranch: string | null;
  reason: string | null;
}

export function decidePromotionBase(args: {
  rcLabel: string;
  seriesBranch: string;
  branchSha: string | null;
  sourceBranch: string | null;
  commit: string;
  originMain: string | null;
}): PromotionBaseDecision {
  if (args.branchSha && args.branchSha === args.commit) {
    return { pushBranch: args.seriesBranch, reason: null };
  }
  if (args.sourceBranch && args.sourceBranch !== "main") {
    if (!args.branchSha) {
      return {
        pushBranch: null,
        reason:
          `${args.rcLabel} was built from ${args.sourceBranch}, but the branch no longer exists on origin. ` +
          `Push it back at the RC commit (git push origin ${args.commit}:refs/heads/${args.sourceBranch}) and rerun.`
      };
    }
    return {
      pushBranch: null,
      reason:
        `${args.sourceBranch} (${args.branchSha}) has advanced past ${args.rcLabel} (${args.commit}). ` +
        `Ship a fresh staging RC from ${args.sourceBranch}, soak it, then promote that build.`
    };
  }
  if (args.originMain !== args.commit) {
    return {
      pushBranch: null,
      reason:
        `origin/main (${args.originMain ?? "unknown"}) has advanced past ${args.rcLabel} (${args.commit}). ` +
        `Cut a release branch at the RC commit (git push origin ${args.commit}:refs/heads/${args.seriesBranch}) to keep promoting it, ` +
        "or ship a fresh staging RC from main, soak it, and promote that build."
    };
  }
  return { pushBranch: "main", reason: null };
}

async function resolvePromotion(input: ReleaseShipInput, promoteFrom: string): Promise<ResolvedPromotion> {
  const { stagingVersion, stagingTag, productionVersion } = parsePromotionVersions(promoteFrom);
  const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
  const repoSlug = releaseRepoSlug(remoteUrl);
  const lookup = await readVerifiedStagingCandidate(input, repoSlug, stagingVersion);
  if (!lookup.candidate || lookup.error) {
    throw new Error(lookup.error ?? `Staging prerelease not found: ${stagingTag}`);
  }
  await verifyImmutableStagingCandidate(input, repoSlug, lookup.candidate);
  const { commit, sourceBranch, publishedAt } = lookup.candidate;
  if (!commit || !sourceBranch) {
    throw new Error(`${stagingTag} has incomplete immutable release metadata.`);
  }

  const existingTags = await mustRun(input.runner, "git", ["ls-remote", "--tags", "origin", `v${productionVersion}`], input.repoRoot, input.env);
  if (existingTags.trim().length > 0) {
    throw new Error(`Production tag v${productionVersion} already exists. ${stagingTag} was already promoted, or the next version needs a fresh staging RC.`);
  }

  const head = await mustRun(input.runner, "git", ["rev-parse", "HEAD"], input.repoRoot, input.env);
  if (head !== commit) {
    throw new Error(
      `HEAD (${head}) is not the commit ${stagingTag} was built from (${commit}). Check out that commit and rerun.`
    );
  }

  const seriesBranch = releaseSeriesBranch(releaseSeriesFromVersion(productionVersion));
  const branchRefs = await mustRun(input.runner, "git", ["ls-remote", "origin", `refs/heads/${seriesBranch}`], input.repoRoot, input.env);
  const branchSha = branchRefs.trim().split(/\s+/)[0] || null;

  let originMain: string | null = null;
  if (!(branchSha && branchSha === commit) && !(sourceBranch && sourceBranch !== "main")) {
    await mustRun(input.runner, "git", ["fetch", "origin", "main"], input.repoRoot, input.env);
    originMain = await mustRun(input.runner, "git", ["rev-parse", "origin/main"], input.repoRoot, input.env);
  }

  const decision = decidePromotionBase({ rcLabel: stagingTag, seriesBranch, branchSha, sourceBranch, commit, originMain });

  // Mechanical alignment is only one of the gates. Lineage validity and the
  // soak window are evaluated here — the same code `kd release status` reports
  // from — so a dry-run rehearsal, a status check, and the real promotion can
  // never disagree about whether a candidate may ship.
  await fetchStagingHistory(input);
  const reset = await readLineageReset(input, repoSlug);
  const lineage = await resolveCandidateLineage(
    input,
    repoSlug,
    { version: stagingVersion, tag: stagingTag, commit, sourceBranch, publishedAt },
    reset
  );
  const soak = evaluateSoak({
    requiredHours: readReleasePolicy(input.repoRoot).productionSoakHours,
    publishedAt,
    nowMs: input.now ?? Date.now(),
    overrideReason: input.soakOverrideReason ?? null
  });
  const abandonedRecord = await readAbandonedSeries(input, seriesBranch);
  const gate = evaluatePromotionGate({
    rcTag: stagingTag,
    rcVersion: stagingVersion,
    mechanical: { pushBranch: decision.pushBranch, reason: decision.reason },
    lineage,
    soak,
    abandonedSeries: abandonedRecord ? { branch: seriesBranch, ...abandonedRecord } : null
  });
  if (!gate.allowed) {
    throw new Error(`Cannot promote ${stagingTag}:\n- ${gate.blockers.join("\n- ")}`);
  }
  // A passing gate already implies a resolved base; this narrows the type and
  // keeps the promotion from proceeding if the two ever disagree.
  if (!decision.pushBranch) {
    throw new Error(decision.reason ?? `Cannot promote ${stagingTag}.`);
  }
  return { version: productionVersion, pushBranch: decision.pushBranch };
}

interface GithubAsset {
  name?: string;
}

interface GithubReleaseView {
  assets?: GithubAsset[];
}

function parseGithubReleaseView(raw: string): GithubReleaseView {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const assets = "assets" in parsed ? (parsed as { assets?: unknown }).assets : undefined;
    if (!Array.isArray(assets)) return {};
    return {
      assets: assets
        .filter((asset): asset is { name?: unknown } => typeof asset === "object" && asset !== null)
        .map((asset) => ({ name: typeof asset.name === "string" ? asset.name : undefined }))
    };
  } catch {
    return {};
  }
}

async function pruneStagingChannelAssets(input: ReleaseShipInput, repoSlug: string): Promise<void> {
  const raw = await mustRun(input.runner, "gh", ["release", "view", STAGING_CHANNEL_TAG, "--repo", repoSlug, "--json", "assets"], input.repoRoot, input.env);
  const view = parseGithubReleaseView(raw);
  for (const asset of view.assets ?? []) {
    if (!asset.name || asset.name === STAGING_MANIFEST_NAME) continue;
    await mustRun(input.runner, "gh", ["release", "delete-asset", STAGING_CHANNEL_TAG, asset.name, "--repo", repoSlug, "--yes"], input.repoRoot, input.env);
  }
}

interface StagingRelease {
  tag: string;
  createdAt: string;
}

function parseStagingReleaseList(raw: string): StagingRelease[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const record = item as { tagName?: unknown; tag_name?: unknown; createdAt?: unknown; created_at?: unknown };
        const tag = typeof record.tagName === "string"
          ? record.tagName
          : typeof record.tag_name === "string"
            ? record.tag_name
            : "";
        const createdAt = typeof record.createdAt === "string"
          ? record.createdAt
          : typeof record.created_at === "string"
            ? record.created_at
            : "";
        return /^v\d+\.\d+\.\d+-staging\.\d+$/.test(tag) ? [{ tag, createdAt }] : [];
      });
    }
  } catch {
    // Fall through to parsing gh's tabular output, which is easier to mock in tests.
  }

  return raw.split(/\r?\n/).flatMap((line) => {
    const columns = line.trim().split("\t");
    const tag = columns.find((column) => /^v\d+\.\d+\.\d+-staging\.\d+$/.test(column.trim()))?.trim() ?? "";
    if (!tag) return [];
    return [{ tag, createdAt: columns.at(-1)?.trim() ?? "" }];
  });
}

function compareStagingReleasesDesc(left: StagingRelease, right: StagingRelease): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (!Number.isNaN(leftTime) || !Number.isNaN(rightTime)) {
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  }
  return right.tag.localeCompare(left.tag, undefined, { numeric: true });
}

async function pruneOldStagingPrereleases(input: ReleaseShipInput, repoSlug: string, protectedTag: string): Promise<void> {
  const raw = await mustRun(input.runner, "gh", ["release", "list", "--repo", repoSlug, "--limit", "100", "--json", "tagName,createdAt"], input.repoRoot, input.env);
  const byTag = new Map(parseStagingReleaseList(raw).map((release) => [release.tag, release]));
  if (!byTag.has(protectedTag)) {
    byTag.set(protectedTag, { tag: protectedTag, createdAt: new Date().toISOString() });
  }
  const releases = [...byTag.values()].sort(compareStagingReleasesDesc);
  const keep = new Set(releases.slice(0, STAGING_RETENTION_COUNT).map((release) => release.tag));
  keep.add(protectedTag);
  for (const release of releases) {
    if (keep.has(release.tag)) continue;
    await mustRun(input.runner, "gh", ["release", "delete", release.tag, "--repo", repoSlug, "--cleanup-tag", "--yes"], input.repoRoot, input.env);
  }
}

async function rollbackStagingRelease(input: ReleaseShipInput, version: string): Promise<ReleaseShipResult> {
  if (releaseEnvironment(input.environment) !== "staging") {
    throw new Error("--rollback-to is only supported with --staging.");
  }
  await assertCleanGitWorktree(input.repoRoot, input.runner, input.env);
  const normalizedVersion = version.replace(/^v/, "");
  const releaseTag = stagingTag(normalizedVersion);
  const releaseDir = releaseOutputDir(input.repoRoot, "staging");
  mkdirSync(releaseDir, { recursive: true });
  const latestJson = join(releaseDir, STAGING_MANIFEST_NAME);
  rmSync(latestJson, { force: true });

  const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
  const repoSlug = releaseRepoSlug(remoteUrl);
  const releaseView = await input.runner.run("gh", ["release", "view", releaseTag, "--repo", repoSlug], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (releaseView.exitCode !== 0) {
    throw new Error(`Staging prerelease not found: ${releaseTag}`);
  }
  if (!input.dryRun) {
    const download = await input.runner.run("gh", ["release", "download", releaseTag, "--repo", repoSlug, "--pattern", STAGING_MANIFEST_NAME, "--dir", releaseDir, "--clobber"], {
      cwd: input.repoRoot,
      env: input.env
    });
    if (download.exitCode !== 0) {
      throw new Error(`Staging manifest asset not found on ${releaseTag}: ${STAGING_MANIFEST_NAME}`);
    }
    if (!existsSync(latestJson)) throw new Error(`Staging manifest asset not found on ${releaseTag}: ${STAGING_MANIFEST_NAME}`);
    await ensureStagingGithubRelease(input, repoSlug);
    await mustRun(input.runner, "gh", ["release", "upload", STAGING_CHANNEL_TAG, latestJson, "--repo", repoSlug, "--clobber"], input.repoRoot, input.env);
  }
  return { version: normalizedVersion, dmgPaths: [], updaterPaths: [], latestJson };
}

async function resolveBazelOutput(input: ReleaseShipInput, target: string): Promise<string> {
  const output = await mustRun(input.runner, "bazel", ["cquery", "-c", "opt", target, "--output=files"], input.repoRoot, input.env);
  const path = output.split("\n").filter(Boolean).at(-1);
  if (!path) throw new Error(`Bazel did not report an output file for ${target}`);
  return join(input.repoRoot, path);
}

async function validateDmgImageResources(input: ReleaseShipInput, dmgPath: string): Promise<void> {
  const script = `
set -eu
mount_dir="$(mktemp -d "\${TMPDIR:-/tmp}/kanna-dmg-validate.XXXXXX")"
assets_file="$(mktemp "\${TMPDIR:-/tmp}/kanna-dmg-assets.XXXXXX")"
cleanup() {
  hdiutil detach -quiet "$mount_dir" >/dev/null 2>&1 || true
  rm -f "$assets_file"
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount_dir" "$1"
find "$mount_dir" -maxdepth 6 -type f \\( -name '*.icns' -o -name '*.png' \\) > "$assets_file"
if [ ! -s "$assets_file" ]; then
  echo "No PNG or ICNS image resources found in $1" >&2
  exit 1
fi
while IFS= read -r asset; do
  sips -g pixelWidth -g pixelHeight "$asset" >/dev/null
done < "$assets_file"
`.trim();

  await mustRun(input.runner, "sh", ["-c", script, "validate-dmg-images", dmgPath], input.repoRoot, input.env);
}

function writeLatestJson(path: string, version: string, notes: string, pubDate: string, platforms: Record<string, { signature: string; url: string }>): void {
  writeFileSync(path, JSON.stringify({ version, notes, pub_date: pubDate, platforms }, null, 2) + "\n");
}

export async function createUpdaterBundle(
  input: ReleaseShipInput,
  bundleSource: string,
  bundlePath: string,
  signaturePath: string
): Promise<void> {
  const signingKey = await resolveUpdaterSigningKey({
    env: input.env
  });
  await createUpdaterBundleWithSigningKey(
    input,
    bundleSource,
    bundlePath,
    signaturePath,
    signingKey
  );
}

async function createUpdaterBundleWithSigningKey(
  input: ReleaseShipInput,
  bundleSource: string,
  bundlePath: string,
  signaturePath: string,
  signingKey: string
): Promise<void> {
  rmSync(bundlePath, { force: true });
  cpSync(bundleSource, bundlePath);
  // The validated file content goes through the signer environment, never argv.
  // An explicit empty password prevents `tauri signer` from prompting during a
  // non-interactive ship; updater signing keys used by kd must be unencrypted.
  const signerEnv = updaterSignerEnvironment(input.env, signingKey);
  const signerArgs = ["--dir", join(input.repoRoot, "apps", "desktop"), "exec", "tauri", "signer", "sign", bundlePath];
  const signer = await input.runner.run("pnpm", signerArgs, {
    cwd: input.repoRoot,
    env: signerEnv
  });
  if (signer.exitCode !== 0) {
    // Never surface signer output: a broken signer could echo its secret env.
    throw new Error(`Tauri updater signing failed for ${bundlePath}.`);
  }
  const generatedSig = `${bundlePath}.sig`;
  if (!existsSync(generatedSig)) throw new Error(`Expected updater signature not found: ${generatedSig}`);
  if (generatedSig !== signaturePath) {
    rmSync(signaturePath, { force: true });
    renameSync(generatedSig, signaturePath);
  }
}

export async function shipRelease(input: ReleaseShipInput): Promise<ReleaseShipResult> {
  const environment = releaseEnvironment(input.environment);
  if (input.rollbackTo) {
    return rollbackStagingRelease(input, input.rollbackTo);
  }
  if (input.promoteFrom && environment !== "production") {
    throw new Error("Promotion ships a production release; it cannot target staging.");
  }
  if (input.release && input.archLabels.length !== 2) {
    throw new Error("updater releases must include both arm64 and x86_64 artifacts");
  }
  // Open, validate, read, and prove the exact selected file before version files
  // or build outputs can change. Retain that material for both architectures so
  // a later pathname change cannot turn into a late or inconsistent failure.
  const updaterSigningKey = await preflightUpdaterSigningKey({
    cwd: input.repoRoot,
    env: input.env,
    runner: input.runner
  });
  await assertCleanGitWorktree(input.repoRoot, input.runner, input.env);

  let version: string;
  let pushBranch = "main";
  let stagingSourceBranch = "main";
  let postPromotionTrunk: PostPromotionTrunkRecord | null = null;
  let versionFloor: MainStagingVersionFloor | null = null;
  if (input.promoteFrom) {
    const promotion = await resolvePromotion(input, input.promoteFrom);
    version = promotion.version;
    pushBranch = promotion.pushBranch;
  } else if (environment === "staging") {
    const stagingContext = await resolveStagingContext(input);
    stagingSourceBranch = stagingContext.sourceBranch;
    versionFloor = stagingContext.versionFloor;
    postPromotionTrunk = await assertStagingPublishAllowed(input, {
      sourceBranch: stagingContext.sourceBranch,
      commit: stagingContext.commit
    });
    version = await resolveNextStagingVersion(input, stagingContext.baseVersion);
  } else {
    const sourceVersion = readCurrentVersion(input.repoRoot);
    version = bumpVersion(sourceVersion, input.bump);
  }

  const bazelArgs = [input.dryRun ? "-c" : "--config=notarize", input.dryRun ? "opt" : "-c", ...(input.dryRun ? [] : ["opt"])];
  const targets = input.archLabels.flatMap((label) => [bazelTargetForLabel(label, input.dryRun, environment), updaterBundleTargetForLabel(label, environment)]);
  const versionFileSnapshot = snapshotVersionFiles(input.repoRoot);
  try {
    syncVersionFiles(input.repoRoot, version);
    await mustRun(input.runner, "bazel", ["build", ...bazelArgs, ...targets], input.repoRoot, input.env);
  } catch (error) {
    restoreVersionFiles(versionFileSnapshot);
    throw error;
  }
  if (environment === "staging") {
    restoreVersionFiles(versionFileSnapshot);
  }

  const releaseDir = releaseOutputDir(input.repoRoot, environment);
  mkdirSync(releaseDir, { recursive: true });
  const dmgPaths: string[] = [];
  const updaterPaths: string[] = [];
  const platforms: Record<string, { signature: string; url: string }> = {};
  const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
  const repoSlug = releaseRepoSlug(remoteUrl);
  const downloadBase = environment === "staging"
    ? `https://github.com/${repoSlug}/releases/download/v${version}`
    : `https://github.com/${repoSlug}/releases/download/v${version}`;

  for (const label of input.archLabels) {
    const dmgSource = await resolveBazelOutput(input, bazelTargetForLabel(label, input.dryRun, environment));
    const dmgDest = join(releaseDir, releaseAssetName(version, label, environment));
    cpSync(dmgSource, dmgDest);
    await validateDmgImageResources(input, dmgDest);
    dmgPaths.push(dmgDest);

    const bundleSource = await resolveBazelOutput(input, updaterBundleTargetForLabel(label, environment));
    const bundlePath = join(releaseDir, updaterAssetName(version, label, environment));
    const sigPath = join(releaseDir, updaterSignatureName(version, label, environment));
    await createUpdaterBundleWithSigningKey(
      input,
      bundleSource,
      bundlePath,
      sigPath,
      updaterSigningKey
    );
    updaterPaths.push(bundlePath, sigPath);
    platforms[updaterPlatformKey(label)] = {
      url: `${downloadBase}/${updaterAssetName(version, label, environment)}`,
      signature: readFileSync(sigPath, "utf8").trim()
    };
  }

  const latestJson = join(releaseDir, environment === "staging" ? STAGING_MANIFEST_NAME : "latest.json");
  const notes = input.release && environment === "production"
    ? await mustRun(input.runner, "gh", ["api", `repos/${releaseRepoSlug(remoteUrl)}/releases/generate-notes`, "-X", "POST", "-f", `tag_name=v${version}`, "-f", `target_commitish=${pushBranch}`, "--jq", ".body"], input.repoRoot, input.env)
    : environment === "staging"
      ? `Staging updater manifest for v${version}\n\n${SOURCE_BRANCH_TRAILER} ${stagingSourceBranch}`
      : `Dry-run updater manifest for v${version}`;
  const pubDate = new Date().toISOString();
  writeLatestJson(latestJson, version, notes, pubDate, platforms);

  if (input.release && environment === "staging") {
    const targetCommit = await mustRun(input.runner, "git", ["rev-parse", "HEAD"], input.repoRoot, input.env);
    await mustRun(input.runner, "gh", [
      "release",
      "create",
      `v${version}`,
      "--repo",
      repoSlug,
      "--title",
      `Kanna Staging v${version}`,
      "--notes",
      notes,
      "--target",
      targetCommit,
      "--prerelease",
      ...dmgPaths,
      ...updaterPaths,
      latestJson
    ], input.repoRoot, input.env);
    await ensureStagingGithubRelease(input, repoSlug);
    if (postPromotionTrunk) {
      const channelBody = composePostPromotionTrunkBody(
        await readStagingChannelBody(input, repoSlug),
        postPromotionTrunk
      );
      await mustRun(
        input.runner,
        "gh",
        ["release", "edit", STAGING_CHANNEL_TAG, "--repo", repoSlug, "--notes", channelBody],
        input.repoRoot,
        input.env
      );
    }
    await mustRun(input.runner, "gh", ["release", "upload", STAGING_CHANNEL_TAG, latestJson, "--repo", repoSlug, "--clobber"], input.repoRoot, input.env);
    await pruneStagingChannelAssets(input, repoSlug);
    await pruneOldStagingPrereleases(input, repoSlug, `v${version}`);
  } else if (input.release) {
    await mustRun(input.runner, "git", ["add", "-f", "VERSION", "apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock"], input.repoRoot, input.env);
    await mustRun(input.runner, "git", ["commit", "-m", `release: v${version}`], input.repoRoot, input.env);
    await mustRun(input.runner, "git", ["tag", `v${version}`], input.repoRoot, input.env);
    await mustRun(input.runner, "git", ["push", "origin", `HEAD:${pushBranch}`, `v${version}`], input.repoRoot, input.env);
    await mustRun(input.runner, "gh", ["release", "create", `v${version}`, ...dmgPaths, ...updaterPaths, "--title", `Kanna v${version}`, "--notes", notes], input.repoRoot, input.env);
    await mustRun(input.runner, "gh", ["release", "upload", `v${version}`, latestJson, "--clobber"], input.repoRoot, input.env);
  }

  return {
    version,
    dmgPaths,
    updaterPaths,
    latestJson,
    ...(versionFloor ? { versionFloor } : {})
  };
}

export interface ReleaseCutInput {
  repoRoot: string;
  bump: ReleaseBump;
  /**
   * Explicit target series version `X.Y.0`. Overrides bump inference, which
   * cannot express "skip the series we are abandoning" — the only way to reach
   * 0.2 from a trunk still recording 0.0.68 without first releasing 0.1.
   */
  version?: string;
  /** Series (`X.Y`) this cut deliberately skips over. Never inferred. */
  abandonSeries?: string[];
  /** Why those series are being abandoned. Required whenever any is named. */
  reason?: string;
  now?: number;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface AbandonedSeries {
  series: string;
  branch: string;
  commit: string;
  tag: string;
  reason: string;
  abandonedAt: string;
  /** True when the series already carried an abandonment tag before this cut. */
  alreadyAbandoned: boolean;
}

export interface ReleaseCutResult {
  branch: string;
  version: string;
  commit: string;
  /** The `VERSION` recorded at `origin/main` when the branch was cut. */
  trunkVersion: string;
  abandoned: AbandonedSeries[];
}

export function abandonedSeriesTag(branch: string): string {
  return `abandoned/${branch}`;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a[index] ?? 0;
    const rightPart = b[index] ?? 0;
    if (Number.isNaN(leftPart) || Number.isNaN(rightPart)) {
      throw new Error(`Cannot compare versions ${left} and ${right}.`);
    }
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function seriesOrdinal(series: ReleaseSeries): number {
  return series.major * 1_000_000 + series.minor;
}

export interface RemoteReleaseBranch {
  branch: string;
  series: ReleaseSeries;
  commit: string;
}

export function parseRemoteReleaseBranches(lsRemoteOutput: string): RemoteReleaseBranch[] {
  const branches: RemoteReleaseBranch[] = [];
  for (const line of lsRemoteOutput.split(/\r?\n/)) {
    const [commit, ref] = line.trim().split(/\s+/);
    if (!commit || !ref) continue;
    const branch = ref.replace(/^refs\/heads\//, "");
    const series = parseReleaseBranchSeries(branch);
    if (!series) continue;
    branches.push({ branch, series, commit });
  }
  return branches;
}

export interface AbandonedSeriesRecord {
  abandonedAt: string | null;
  reason: string | null;
}

export function formatAbandonedSeriesMessage(args: { branch: string; abandonedAt: string; reason: string }): string {
  return `Abandoned ${args.branch} at ${args.abandonedAt}\n\nReason: ${args.reason}\n`;
}

export function parseAbandonedSeriesMessage(message: string): AbandonedSeriesRecord {
  const at = /^Abandoned\s+\S+\s+at\s+(\S+)\s*$/m.exec(message);
  const reason = /^Reason:[ \t]*(.+?)[ \t]*$/m.exec(message);
  return { abandonedAt: at?.[1] ?? null, reason: reason?.[1] ?? null };
}

async function remoteTagExists(context: ReleaseCommandContext, tag: string): Promise<boolean> {
  const result = await context.runner.run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], {
    cwd: context.repoRoot,
    env: context.env
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

/**
 * Whether a release series has been deliberately abandoned. Recorded as an
 * annotated `abandoned/release/X.Y` tag rather than by deleting the branch: the
 * branch and its history stay readable, the record carries who/when/why, and
 * both `ship` and `promote` can refuse the series without special-casing.
 */
export async function readAbandonedSeries(
  context: ReleaseCommandContext,
  branch: string
): Promise<AbandonedSeriesRecord | null> {
  const tag = abandonedSeriesTag(branch);
  if (!(await remoteTagExists(context, tag))) return null;
  await context.runner.run("git", ["fetch", "origin", `+refs/tags/${tag}:refs/tags/${tag}`], {
    cwd: context.repoRoot,
    env: context.env
  });
  const contents = await context.runner.run("git", ["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`], {
    cwd: context.repoRoot,
    env: context.env
  });
  if (contents.exitCode !== 0) return { abandonedAt: null, reason: null };
  return parseAbandonedSeriesMessage(contents.stdout);
}

/**
 * Cuts the next stabilization branch.
 *
 * Bump inference reads `origin/main:VERSION`, which only advances when a
 * production release commits it. That is correct while releases land in order,
 * but it cannot express a series transition that skips an abandoned series: with
 * trunk at 0.0.68 and `release/0.1` already cut, `--minor` can only aim back at
 * the series being abandoned. `--version X.Y.0` names the intended series
 * directly, and every series it steps over must be named and reasoned for — so
 * skipping a version is always a decision someone wrote down, never a side
 * effect of a flag.
 */
export async function cutReleaseBranch(input: ReleaseCutInput): Promise<ReleaseCutResult> {
  await mustRun(input.runner, "git", ["fetch", "origin", "main"], input.repoRoot, input.env);
  const commit = await mustRun(input.runner, "git", ["rev-parse", "origin/main"], input.repoRoot, input.env);
  // The caller's worktree can be stale (Kanna task worktrees fork from older
  // commits), so the series must come from the same commit the branch will
  // point at — origin/main — not from the local VERSION file.
  const trunkVersion = (await mustRun(input.runner, "git", ["show", "origin/main:VERSION"], input.repoRoot, input.env)).trim();

  const requested = input.version?.trim();
  let targetVersion: string;
  if (requested) {
    const normalized = requested.replace(/^v/, "");
    if (!/^\d+\.\d+\.0$/.test(normalized)) {
      throw new Error(
        `Invalid --version ${requested}. A series cut starts at patch 0, e.g. --version 0.2.0.`
      );
    }
    if (compareVersions(normalized, trunkVersion) <= 0) {
      throw new Error(
        `--version ${normalized} is not ahead of origin/main's VERSION (${trunkVersion}). ` +
          "A release series must be cut ahead of trunk's recorded version."
      );
    }
    targetVersion = normalized;
  } else {
    targetVersion = bumpVersion(trunkVersion, input.bump);
  }

  const targetSeries = releaseSeriesFromVersion(targetVersion);
  const branch = releaseSeriesBranch(targetSeries);
  const remoteBranches = parseRemoteReleaseBranches(
    await mustRun(input.runner, "git", ["ls-remote", "--heads", "origin", "refs/heads/release/*"], input.repoRoot, input.env)
  );
  if (remoteBranches.some((candidate) => candidate.branch === branch)) {
    throw new Error(
      `${branch} already exists on origin. Ship RCs from it, or name the intended next series explicitly ` +
        `(kd release cut --version X.Y.0), abandoning any series it steps over.`
    );
  }

  const trunkOrdinal = seriesOrdinal(releaseSeriesFromVersion(trunkVersion));
  const targetOrdinal = seriesOrdinal(targetSeries);
  const steppedOver = remoteBranches.filter((candidate) => {
    const ordinal = seriesOrdinal(candidate.series);
    return ordinal > trunkOrdinal && ordinal < targetOrdinal;
  });

  const named = new Set((input.abandonSeries ?? []).map((series) => series.trim()).filter(Boolean));
  const reason = input.reason?.trim() ?? "";
  const abandonedAt = new Date(input.now ?? Date.now()).toISOString();

  const pending: Array<{ candidate: RemoteReleaseBranch; existing: AbandonedSeriesRecord | null }> = [];
  const unnamed: string[] = [];
  for (const candidate of steppedOver) {
    const seriesLabel = `${candidate.series.major}.${candidate.series.minor}`;
    const seriesTags = await mustRun(
      input.runner,
      "git",
      ["ls-remote", "--tags", "origin", `v${seriesLabel}.*`],
      input.repoRoot,
      input.env
    );
    // A series that already shipped is history, not something to abandon — but
    // only production tags count. `ls-remote` expands the pattern to `*/v0.1.*`
    // and its `*` crosses `/`, so this glob also returns every
    // `v0.1.0-staging.N` prerelease. Since any series worth abandoning has
    // published RCs by definition, matching the raw output here would classify
    // every abandonment candidate as "already released" and silently skip it.
    if (hasProductionTagForSeries(seriesTags, candidate.series)) continue;
    const existing = await readAbandonedSeries(input, candidate.branch);
    if (existing) {
      pending.push({ candidate, existing });
      continue;
    }
    if (!named.has(seriesLabel)) {
      unnamed.push(seriesLabel);
      continue;
    }
    pending.push({ candidate, existing: null });
  }

  if (unnamed.length > 0) {
    throw new Error(
      `Cutting ${branch} steps over unreleased release ${unnamed.length === 1 ? "series" : "series'"} ` +
        `${unnamed.join(", ")}, which ${unnamed.length === 1 ? "is" : "are"} neither released nor abandoned. ` +
        `Name ${unnamed.length === 1 ? "it" : "them"} explicitly to record the decision: ` +
        `kd release cut --version ${targetVersion} --abandon-series ${unnamed.join(",")} --reason "<why>". ` +
        "The branch is kept and never deleted; abandoning only records that no production release will come from it."
    );
  }

  const abandoning = pending.filter((entry) => !entry.existing);
  const unknownNamed = [...named].filter(
    (series) => !steppedOver.some((candidate) => `${candidate.series.major}.${candidate.series.minor}` === series)
  );
  if (unknownNamed.length > 0) {
    throw new Error(
      `--abandon-series ${unknownNamed.join(", ")} does not name a release branch this cut steps over. ` +
        `Cutting ${branch} from a trunk at ${trunkVersion} steps over ` +
        `${steppedOver.length > 0 ? steppedOver.map((candidate) => candidate.branch).join(", ") : "no release branches"}.`
    );
  }
  if (abandoning.length > 0 && !reason) {
    throw new Error("Abandoning a release series requires --reason \"<why no production release will come from it>\".");
  }

  // The staging channel is still serving the abandoned series' candidate until
  // someone says otherwise. Abandoning the series without releasing the channel
  // would leave the next publish refused by the lineage gate with no
  // explanation, so require the reset first rather than doing it implicitly.
  if (abandoning.length > 0) {
    const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
    const repoSlug = releaseRepoSlug(remoteUrl);
    const active = await resolveActiveStagingCandidate(input, repoSlug);
    if (active.error) {
      throw new Error(
        `Cannot tell whether ${STAGING_CHANNEL_TAG} still serves the series being abandoned (${active.error}). ` +
          "Refusing to abandon a series against an unreadable channel; retry once GitHub is reachable."
      );
    }
    const activeBranch = active.candidate?.sourceBranch ?? null;
    if (active.candidate && abandoning.some((entry) => entry.candidate.branch === activeBranch)) {
      const reset = await readLineageReset(input, repoSlug);
      if (!reset || normalizeStagingVersion(reset.fromVersion) !== normalizeStagingVersion(active.candidate.version)) {
        throw new Error(
          `${STAGING_CHANNEL_TAG} still serves ${active.candidate.tag} from ${activeBranch}, the series being abandoned. ` +
            "Release the channel first so the next publish is not silently refused: " +
            `kd release reset-staging --to ${branch} --reason "<why>" --confirm-abandon ${active.candidate.version}.`
        );
      }
    }
  }

  // Abandonments are recorded before the skip becomes real: a cut that fails
  // after this point leaves an audited, idempotent record and no missing one.
  for (const entry of abandoning) {
    const tag = abandonedSeriesTag(entry.candidate.branch);
    await mustRun(input.runner, "git", ["fetch", "origin", entry.candidate.branch], input.repoRoot, input.env);
    await mustRun(
      input.runner,
      "git",
      [
        "tag",
        "-f",
        "-a",
        tag,
        entry.candidate.commit,
        "-m",
        formatAbandonedSeriesMessage({ branch: entry.candidate.branch, abandonedAt, reason })
      ],
      input.repoRoot,
      input.env
    );
    await mustRun(input.runner, "git", ["push", "origin", `refs/tags/${tag}`], input.repoRoot, input.env);
  }

  await mustRun(input.runner, "git", ["push", "origin", `${commit}:refs/heads/${branch}`], input.repoRoot, input.env);
  return {
    branch,
    version: targetVersion,
    commit,
    trunkVersion,
    abandoned: pending.map((entry) => ({
      series: `${entry.candidate.series.major}.${entry.candidate.series.minor}`,
      branch: entry.candidate.branch,
      commit: entry.candidate.commit,
      tag: abandonedSeriesTag(entry.candidate.branch),
      reason: entry.existing?.reason ?? reason,
      abandonedAt: entry.existing?.abandonedAt ?? abandonedAt,
      alreadyAbandoned: entry.existing !== null
    }))
  };
}

export interface ReleaseResetStagingInput {
  repoRoot: string;
  /** Branch the channel is being handed to: `main` or `release/X.Y`. */
  toBranch: string;
  reason: string;
  /** Must name the exact staging version being abandoned. */
  confirmAbandon: string;
  dryRun: boolean;
  now?: number;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface ReleaseResetStagingResult {
  from: { version: string; tag: string; commit: string | null; sourceBranch: string | null };
  to: { branch: string };
  reason: string;
  resetAt: string;
  applied: boolean;
}

/**
 * The one deliberate, non-linear staging transition.
 *
 * Ordinary ships only ever move the channel forward. Some transitions are
 * legitimately non-linear — abandoning a stale release soak, handing the
 * channel to an older series for a hotfix — and the answer to those is not a
 * weaker ship guard but a separate, loudly named operation that records what
 * was abandoned and why. It builds nothing, publishes nothing, and does not
 * repoint the manifest: staging users keep running the candidate they have
 * until the next publish. It authorizes exactly the next publish that leaves
 * this candidate for the named branch, so it cannot silently license a second
 * divergence later.
 */
export async function resetStagingLineage(input: ReleaseResetStagingInput): Promise<ReleaseResetStagingResult> {
  const toBranch = input.toBranch.trim();
  if (toBranch !== "main" && !parseReleaseBranchSeries(toBranch)) {
    throw new Error(`Invalid --to ${input.toBranch || "(empty)"}. Expected main or release/X.Y.`);
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("release reset-staging requires --reason \"<why this lineage is being abandoned>\".");
  }
  const confirm = input.confirmAbandon.trim().replace(/^v/, "");
  if (!confirm) {
    throw new Error(
      "release reset-staging requires --confirm-abandon <active-staging-version>. Run kd release status to read it."
    );
  }

  const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
  const repoSlug = releaseRepoSlug(remoteUrl);
  const active = await resolveActiveStagingCandidate(input, repoSlug);
  if (!active.candidate) {
    throw new Error(
      `${STAGING_CHANNEL_TAG} has no active staging candidate, so there is no lineage to abandon. Ship a staging RC instead.`
    );
  }
  if (confirm !== active.candidate.version) {
    throw new Error(
      `--confirm-abandon ${confirm} does not match the active staging candidate ${active.candidate.version}. ` +
        "Run kd release status and pass the exact active version to confirm what is being abandoned."
    );
  }

  const record: LineageResetRecord = {
    resetAt: new Date(input.now ?? Date.now()).toISOString(),
    fromVersion: active.candidate.version,
    fromCommit: active.candidate.commit,
    fromSourceBranch: active.candidate.sourceBranch,
    toBranch,
    reason
  };

  if (!input.dryRun) {
    await ensureStagingGithubRelease(input, repoSlug);
    const body = composeStagingChannelBody(await readStagingChannelBody(input, repoSlug), record);
    await mustRun(
      input.runner,
      "gh",
      ["release", "edit", STAGING_CHANNEL_TAG, "--repo", repoSlug, "--notes", body],
      input.repoRoot,
      input.env
    );
  }

  return {
    from: {
      version: active.candidate.version,
      tag: active.candidate.tag,
      commit: active.candidate.commit,
      sourceBranch: active.candidate.sourceBranch
    },
    to: { branch: toBranch },
    reason,
    resetAt: record.resetAt,
    applied: !input.dryRun
  };
}

export interface ReleaseStatusInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  /** Fixed clock for soak arithmetic; defaults to `Date.now()`. */
  now?: number;
}

export interface ReleaseBranchCommit {
  sha: string;
  subject: string;
}

export interface ReleaseStatusStaging {
  version: string;
  tag: string;
  commit: string | null;
  sourceBranch: string | null;
  commitsBehindMain: number | null;
  publishedAt: string | null;
  ageHours: number | null;
}

export interface ReleaseStatusReleaseBranch {
  name: string;
  commit: string;
  /** Set when the series was deliberately abandoned instead of released. */
  abandoned: AbandonedSeriesRecord | null;
  /**
   * Commits on the release branch with no patch-equivalent on main. This is
   * provable ancestry/patch-id provenance — un-backported release-only work —
   * not a semantic claim that the branch carries only bugfixes.
   */
  unmergedCommits: ReleaseBranchCommit[] | null;
  unmergedCommitCount: number | null;
}

export interface ReleaseStatusLineage {
  relationship: StagingLineageRelationship;
  previous: { version: string; tag: string; commit: string | null } | null;
  valid: boolean;
  authorizedByReset: boolean;
  authorizedByPromotion: boolean;
  reset: LineageResetRecord | null;
  postPromotion: PostPromotionTrunkRecord | null;
  detail: string;
}

export interface ReleaseStatusPromotion {
  /** True when the RC commit still matches its promotion branch tip. Alignment only. */
  mechanicallyPromotable: boolean;
  base: string | null;
  mechanicalReason: string | null;
  soak: SoakEvaluation;
  /** True only when mechanical alignment, lineage validity, and the soak gate all hold. */
  allowed: boolean;
  blockers: string[];
}

export interface ReleaseStatusResult {
  production: { version: string; tag: string; publishedAt: string } | null;
  staging: ReleaseStatusStaging | null;
  releaseBranch: ReleaseStatusReleaseBranch | null;
  commitsOnMainSinceProduction: number | null;
  policy: ReleasePolicy;
  lineage: ReleaseStatusLineage | null;
  freeze: { active: boolean; branch: string | null; reason: string | null };
  promotion: ReleaseStatusPromotion;
  promoteCommand: string | null;
}

function parseProductionReleaseView(raw: string): { tag: string; publishedAt: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { tagName?: unknown; publishedAt?: unknown };
    if (typeof record.tagName !== "string" || record.tagName.length === 0) return null;
    return { tag: record.tagName, publishedAt: typeof record.publishedAt === "string" ? record.publishedAt : "" };
  } catch {
    return null;
  }
}

function parseManifestVersion(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * What the `desktop-staging` pointer says, as three genuinely different
 * outcomes rather than "version or not".
 *
 * `absent` and `unreadable` look identical from a single failed command, and
 * conflating them is what makes a release tool fail open: a rate limit, an
 * expired token, or a GitHub 5xx would otherwise read as "no channel yet" and
 * skip every gate on the way to repointing a live channel. Only positive
 * evidence that the channel has no candidate — the release does not exist, or
 * it exists and carries no manifest asset — counts as `absent`. Everything else
 * that stops us reading the pointer is `unreadable`, and refuses.
 */
export type StagingChannelRead =
  | { state: "absent"; detail: string }
  | { state: "unreadable"; error: string }
  | { state: "active"; version: string };

// gh's 404 wording. Anything else that fails is treated as a real error, so an
// unrecognized failure fails closed rather than reading as an empty channel.
const CHANNEL_NOT_FOUND_PATTERN = /release not found|404|could not find release/i;

function parseChannelAssetNames(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const assets = (parsed as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) return null;
    return assets.flatMap((asset) =>
      typeof asset === "object" && asset !== null && typeof (asset as { name?: unknown }).name === "string"
        ? [(asset as { name: string }).name]
        : []
    );
  } catch {
    return null;
  }
}

async function readStagingChannel(input: ReleaseCommandContext, repoSlug: string): Promise<StagingChannelRead> {
  // Asset presence is data, not an error string: ask for the asset list first
  // so "the channel has no manifest" is a positive answer rather than a guess
  // about why a download failed.
  const view = await input.runner.run(
    "gh",
    ["release", "view", STAGING_CHANNEL_TAG, "--repo", repoSlug, "--json", "assets"],
    { cwd: input.repoRoot, env: input.env }
  );
  if (view.exitCode !== 0) {
    const message = view.stderr.trim() || view.stdout.trim() || "gh release view failed.";
    if (CHANNEL_NOT_FOUND_PATTERN.test(message)) {
      return { state: "absent", detail: `${STAGING_CHANNEL_TAG} does not exist yet.` };
    }
    return { state: "unreadable", error: `could not read ${STAGING_CHANNEL_TAG}: ${message}` };
  }
  const assetNames = parseChannelAssetNames(view.stdout);
  if (!assetNames) {
    return { state: "unreadable", error: `could not parse the ${STAGING_CHANNEL_TAG} asset list from gh.` };
  }
  if (!assetNames.includes(STAGING_MANIFEST_NAME)) {
    return { state: "absent", detail: `${STAGING_CHANNEL_TAG} carries no ${STAGING_MANIFEST_NAME} yet.` };
  }

  const manifestDir = mkdtempSync(join(tmpdir(), "kanna-release-status-"));
  try {
    const download = await input.runner.run(
      "gh",
      [
        "release",
        "download",
        STAGING_CHANNEL_TAG,
        "--repo",
        repoSlug,
        "--pattern",
        STAGING_MANIFEST_NAME,
        "--dir",
        manifestDir,
        "--clobber"
      ],
      { cwd: input.repoRoot, env: input.env }
    );
    if (download.exitCode !== 0) {
      return {
        state: "unreadable",
        error: `could not download ${STAGING_MANIFEST_NAME}: ${download.stderr.trim() || download.stdout.trim() || "GitHub release download failed."}`
      };
    }
    const manifestPath = join(manifestDir, STAGING_MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      return { state: "unreadable", error: `${STAGING_MANIFEST_NAME} was not downloaded.` };
    }
    const version = parseManifestVersion(readFileSync(manifestPath, "utf8"));
    return version
      ? { state: "active", version }
      : { state: "unreadable", error: `${STAGING_MANIFEST_NAME} has no valid version.` };
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
  }
}

async function countCommits(input: ReleaseCommandContext, range: string): Promise<number | null> {
  const result = await input.runner.run("git", ["rev-list", "--count", range], { cwd: input.repoRoot, env: input.env });
  if (result.exitCode !== 0) return null;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(count) ? null : count;
}

const UNMERGED_COMMIT_REPORT_LIMIT = 20;

function roundHours(hours: number): number {
  return Math.round(Math.max(0, hours) * 100) / 100;
}

export function parseUnmergedReleaseCommits(logOutput: string): ReleaseBranchCommit[] {
  const commits: ReleaseBranchCommit[] = [];
  for (const line of logOutput.split(/\r?\n/)) {
    const match = /^([0-9a-f]{7,40})(?:\s+(.*))?$/.exec(line.trim());
    if (!match?.[1]) continue;
    commits.push({ sha: match[1], subject: (match[2] ?? "").trim() });
  }
  return commits;
}

/**
 * Release-branch hygiene kd can actually prove: commits on the branch with no
 * patch-equivalent on main. `--cherry-pick` compares by patch id, so a fix
 * cherry-picked onto the branch from main does not show up, while a fix that
 * only ever landed on the branch does — that is the regression the "fix on main
 * first, then backport" rule exists to prevent. Merges are excluded: a merge
 * carries no patch of its own, so it can be neither backported nor missing.
 * This says nothing about whether the remaining commits are bugfixes; only a
 * human review can claim that.
 */
async function resolveUnmergedReleaseCommits(
  input: ReleaseCommandContext,
  branchName: string
): Promise<{ commits: ReleaseBranchCommit[] | null; count: number | null }> {
  const fetched = await input.runner.run(
    "git",
    ["fetch", "origin", `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
    { cwd: input.repoRoot, env: input.env }
  );
  if (fetched.exitCode !== 0) return { commits: null, count: null };
  const log = await input.runner.run(
    "git",
    ["log", "--no-merges", "--cherry-pick", "--right-only", "--format=%H %s", `origin/main...origin/${branchName}`],
    { cwd: input.repoRoot, env: input.env }
  );
  if (log.exitCode !== 0) return { commits: null, count: null };
  const commits = parseUnmergedReleaseCommits(log.stdout);
  return { commits: commits.slice(0, UNMERGED_COMMIT_REPORT_LIMIT), count: commits.length };
}

export async function releaseStatus(input: ReleaseStatusInput): Promise<ReleaseStatusResult> {
  const nowMs = input.now ?? Date.now();
  const policy = readReleasePolicy(input.repoRoot);
  const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
  const repoSlug = releaseRepoSlug(remoteUrl);
  await mustRun(input.runner, "git", ["fetch", "--tags", "origin", "main"], input.repoRoot, input.env);
  const originMain = await mustRun(input.runner, "git", ["rev-parse", "origin/main"], input.repoRoot, input.env);

  let production: ReleaseStatusResult["production"] = null;
  const productionView = await input.runner.run("gh", ["release", "view", "--repo", repoSlug, "--json", "tagName,publishedAt"], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (productionView.exitCode === 0) {
    const parsed = parseProductionReleaseView(productionView.stdout);
    if (parsed) {
      production = { version: parsed.tag.replace(/^v/, ""), tag: parsed.tag, publishedAt: parsed.publishedAt };
    }
  }

  let staging: ReleaseStatusStaging | null = null;
  let activeCandidate: StagingCandidate | null = null;
  const channel = await readStagingChannel(input, repoSlug);
  // An unreadable channel must never be reported as an empty one: "no candidate
  // is active" reads as a calm all-clear, and the operator would act on it.
  const channelError = channel.state === "unreadable" ? channel.error : null;
  let candidateIntegrityError: string | null = channelError;
  const version = channel.state === "active" ? channel.version : null;
  if (version) {
    const lookup = await readVerifiedStagingCandidate(input, repoSlug, version);
    activeCandidate = lookup.candidate;
    candidateIntegrityError = lookup.error;
    if (activeCandidate && !candidateIntegrityError) {
      try {
        await verifyImmutableStagingCandidate(input, repoSlug, activeCandidate);
      } catch (error) {
        candidateIntegrityError = error instanceof Error ? error.message : String(error);
      }
    }
    const publishedAt = activeCandidate?.publishedAt ?? null;
    const publishedMs = publishedAt ? Date.parse(publishedAt) : Number.NaN;
    staging = {
      version,
      tag: stagingTag(version),
      commit: activeCandidate?.commit ?? null,
      sourceBranch: activeCandidate?.sourceBranch ?? null,
      commitsBehindMain: activeCandidate?.commit
        ? await countCommits(input, `${activeCandidate.commit}..origin/main`)
        : null,
      publishedAt,
      ageHours: Number.isNaN(publishedMs) ? null : roundHours((nowMs - publishedMs) / 3_600_000)
    };
  }

  let releaseBranch: ReleaseStatusReleaseBranch | null = null;
  if (staging) {
    const branchName = releaseSeriesBranch(releaseSeriesFromVersion(staging.version));
    const branchRefs = await input.runner.run("git", ["ls-remote", "origin", `refs/heads/${branchName}`], {
      cwd: input.repoRoot,
      env: input.env
    });
    const branchSha = branchRefs.exitCode === 0 ? branchRefs.stdout.trim().split(/\s+/)[0] ?? "" : "";
    if (branchSha) {
      const unmerged = await resolveUnmergedReleaseCommits(input, branchName);
      releaseBranch = {
        name: branchName,
        commit: branchSha,
        abandoned: await readAbandonedSeries(input, branchName),
        unmergedCommits: unmerged.commits,
        unmergedCommitCount: unmerged.count
      };
    }
  }

  const commitsOnMainSinceProduction = production ? await countCommits(input, `${production.tag}..origin/main`) : null;

  let lineage: ReleaseStatusLineage | null = null;
  let freeze: ReleaseStatusResult["freeze"] = { active: false, branch: null, reason: null };
  const promotion: ReleaseStatusPromotion = {
    mechanicallyPromotable: false,
    base: null,
    mechanicalReason: null,
    soak: evaluateSoak({ requiredHours: policy.productionSoakHours, publishedAt: null, nowMs }),
    allowed: false,
    blockers: [
      channelError
        ? `The ${STAGING_CHANNEL_TAG} channel could not be read (${channelError}), so no promotion decision can be made.`
        : candidateIntegrityError
        ? `The active staging candidate failed immutable identity verification: ${candidateIntegrityError}`
        : "No staging release candidate is active on the channel."
    ]
  };

  if (staging && activeCandidate) {
    await fetchStagingHistory(input);
    const audit = await readLineageAudit(input, repoSlug);
    lineage = await resolveCandidateLineage(input, repoSlug, activeCandidate, audit.reset, audit.postPromotion);

    if (isReleaseBranchName(staging.sourceBranch)) {
      const promoted = await activeProductionTagExists(input, staging.version);
      if (!promoted) {
        freeze = {
          active: true,
          branch: staging.sourceBranch,
          reason:
            `${staging.tag} is an unpromoted ${staging.sourceBranch} release candidate; ` +
            "main staging publishes are frozen until it is promoted or the soak is explicitly abandoned."
        };
      }
    }

    const decision = decidePromotionBase({
      rcLabel: staging.tag,
      seriesBranch: releaseSeriesBranch(releaseSeriesFromVersion(staging.version)),
      branchSha: releaseBranch?.commit ?? null,
      sourceBranch: staging.sourceBranch,
      commit: staging.commit ?? "",
      originMain
    });
    const soak = evaluateSoak({
      requiredHours: policy.productionSoakHours,
      publishedAt: staging.publishedAt,
      nowMs
    });
    const seriesBranchName = releaseSeriesBranch(releaseSeriesFromVersion(staging.version));
    const gate = evaluatePromotionGate({
      rcTag: staging.tag,
      rcVersion: staging.version,
      mechanical: { pushBranch: staging.commit ? decision.pushBranch : null, reason: staging.commit ? decision.reason : `${staging.tag} records no target commit, so its promotion base cannot be resolved.` },
      lineage,
      soak,
      abandonedSeries: releaseBranch?.abandoned ? { branch: seriesBranchName, ...releaseBranch.abandoned } : null
    });
    promotion.mechanicallyPromotable = Boolean(staging.commit) && decision.pushBranch !== null;
    promotion.base = promotion.mechanicallyPromotable ? decision.pushBranch : null;
    promotion.mechanicalReason = promotion.mechanicallyPromotable ? null : decision.reason;
    promotion.soak = soak;
    promotion.allowed = gate.allowed;
    promotion.blockers = gate.blockers;
    if (candidateIntegrityError) {
      promotion.allowed = false;
      promotion.blockers = [
        `The active staging candidate failed immutable identity verification: ${candidateIntegrityError}`,
        ...promotion.blockers
      ];
    }
  }

  return {
    production,
    staging,
    releaseBranch,
    commitsOnMainSinceProduction,
    policy,
    lineage,
    freeze,
    promotion,
    promoteCommand: promotion.allowed && staging ? `kd release promote ${staging.version}` : null
  };
}
