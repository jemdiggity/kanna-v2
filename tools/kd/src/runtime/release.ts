import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./process";

export type ReleaseBump = "major" | "minor" | "patch";
export type ReleaseArchLabel = "arm64" | "x86_64";
export type ReleaseEnvironment = "production" | "staging";

export interface ReleaseShipInput {
  repoRoot: string;
  bump: ReleaseBump;
  archLabels: ReleaseArchLabel[];
  environment?: ReleaseEnvironment;
  release: boolean;
  dryRun: boolean;
  rollbackTo?: string;
  promoteFrom?: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface ReleaseShipResult {
  version: string;
  dmgPaths: string[];
  updaterPaths: string[];
  latestJson: string;
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

async function ensureStagingGithubRelease(input: ReleaseShipInput, repoSlug: string): Promise<void> {
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

async function resolveStagingBaseVersion(input: ReleaseShipInput): Promise<string> {
  const branch = await mustRun(input.runner, "git", ["rev-parse", "--abbrev-ref", "HEAD"], input.repoRoot, input.env);
  const series = parseReleaseBranchSeries(branch);
  if (!series) {
    const sourceVersion = readCurrentVersion(input.repoRoot);
    return bumpVersion(sourceVersion, input.bump);
  }
  const tags = await mustRun(input.runner, "git", ["ls-remote", "--tags", "origin", `v${series.major}.${series.minor}.*`], input.repoRoot, input.env);
  return nextSeriesPatchVersion(tags, series);
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

interface ResolvedPromotion {
  version: string;
  pushBranch: string;
}

async function resolvePromotion(input: ReleaseShipInput, promoteFrom: string): Promise<ResolvedPromotion> {
  const { stagingTag, productionVersion } = parsePromotionVersions(promoteFrom);
  const remoteUrl = await mustRun(input.runner, "git", ["remote", "get-url", "origin"], input.repoRoot, input.env);
  const repoSlug = releaseRepoSlug(remoteUrl);
  const view = await input.runner.run("gh", ["release", "view", stagingTag, "--repo", repoSlug, "--json", "targetCommitish"], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (view.exitCode !== 0) {
    throw new Error(`Staging prerelease not found: ${stagingTag}`);
  }
  const commit = parseTargetCommitish(view.stdout);

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
  const branchSha = branchRefs.trim().split(/\s+/)[0] ?? "";
  if (branchSha) {
    if (branchSha !== commit) {
      throw new Error(
        `${seriesBranch} (${branchSha}) has advanced past ${stagingTag} (${commit}). ` +
          `Ship a fresh staging RC from ${seriesBranch}, soak it, then promote that build.`
      );
    }
    return { version: productionVersion, pushBranch: seriesBranch };
  }

  await mustRun(input.runner, "git", ["fetch", "origin", "main"], input.repoRoot, input.env);
  const originMain = await mustRun(input.runner, "git", ["rev-parse", "origin/main"], input.repoRoot, input.env);
  if (originMain !== commit) {
    throw new Error(
      `origin/main (${originMain}) has advanced past ${stagingTag} (${commit}). ` +
        `Cut a release branch at the RC commit (git push origin ${commit}:refs/heads/${seriesBranch}) to keep promoting it, ` +
        "or ship a fresh staging RC from main, soak it, and promote that build."
    );
  }
  return { version: productionVersion, pushBranch: "main" };
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

export async function createUpdaterBundle(input: ReleaseShipInput, bundleSource: string, bundlePath: string, signaturePath: string): Promise<void> {
  rmSync(bundlePath, { force: true });
  cpSync(bundleSource, bundlePath);
  const signerArgs = ["--dir", join(input.repoRoot, "apps", "desktop"), "exec", "tauri", "signer", "sign", "--private-key-path", input.env.TAURI_PRIVATE_KEY_PATH ?? ""];
  if ("TAURI_PRIVATE_KEY_PASSWORD" in input.env) {
    signerArgs.push("--password", input.env.TAURI_PRIVATE_KEY_PASSWORD ?? "");
  }
  signerArgs.push(bundlePath);
  await mustRun(input.runner, "pnpm", signerArgs, input.repoRoot, input.env);
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
  if (!input.env.KANNA_UPDATER_PUBKEY) throw new Error("Missing KANNA_UPDATER_PUBKEY.");
  if (!input.env.TAURI_PRIVATE_KEY_PATH) throw new Error("Missing TAURI_PRIVATE_KEY_PATH.");
  if (!existsSync(input.env.TAURI_PRIVATE_KEY_PATH)) throw new Error(`Tauri updater private key not found: ${input.env.TAURI_PRIVATE_KEY_PATH}`);
  await assertCleanGitWorktree(input.repoRoot, input.runner, input.env);

  let version: string;
  let pushBranch = "main";
  if (input.promoteFrom) {
    const promotion = await resolvePromotion(input, input.promoteFrom);
    version = promotion.version;
    pushBranch = promotion.pushBranch;
  } else if (environment === "staging") {
    version = await resolveNextStagingVersion(input, await resolveStagingBaseVersion(input));
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
    await createUpdaterBundle(input, bundleSource, bundlePath, sigPath);
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
      ? `Staging updater manifest for v${version}`
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

  return { version, dmgPaths, updaterPaths, latestJson };
}

export interface ReleaseCutInput {
  repoRoot: string;
  bump: ReleaseBump;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface ReleaseCutResult {
  branch: string;
  version: string;
  commit: string;
}

export async function cutReleaseBranch(input: ReleaseCutInput): Promise<ReleaseCutResult> {
  const sourceVersion = readCurrentVersion(input.repoRoot);
  const targetVersion = bumpVersion(sourceVersion, input.bump);
  const branch = releaseSeriesBranch(releaseSeriesFromVersion(targetVersion));
  const existing = await mustRun(input.runner, "git", ["ls-remote", "origin", `refs/heads/${branch}`], input.repoRoot, input.env);
  if (existing.trim().length > 0) {
    throw new Error(`${branch} already exists on origin. Ship RCs from it, or cut the next series with a different bump.`);
  }
  await mustRun(input.runner, "git", ["fetch", "origin", "main"], input.repoRoot, input.env);
  const commit = await mustRun(input.runner, "git", ["rev-parse", "origin/main"], input.repoRoot, input.env);
  await mustRun(input.runner, "git", ["push", "origin", `${commit}:refs/heads/${branch}`], input.repoRoot, input.env);
  return { branch, version: targetVersion, commit };
}

export interface ReleaseStatusInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface ReleaseStatusResult {
  production: { version: string; tag: string; publishedAt: string } | null;
  staging: { version: string; tag: string; commit: string | null; commitsBehindMain: number | null } | null;
  releaseBranch: { name: string; commit: string } | null;
  commitsOnMainSinceProduction: number | null;
  promotable: boolean;
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

async function countCommits(input: ReleaseStatusInput, range: string): Promise<number | null> {
  const result = await input.runner.run("git", ["rev-list", "--count", range], { cwd: input.repoRoot, env: input.env });
  if (result.exitCode !== 0) return null;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(count) ? null : count;
}

export async function releaseStatus(input: ReleaseStatusInput): Promise<ReleaseStatusResult> {
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

  let staging: ReleaseStatusResult["staging"] = null;
  const manifestDir = mkdtempSync(join(tmpdir(), "kanna-release-status-"));
  try {
    const download = await input.runner.run(
      "gh",
      ["release", "download", STAGING_CHANNEL_TAG, "--repo", repoSlug, "--pattern", STAGING_MANIFEST_NAME, "--dir", manifestDir, "--clobber"],
      { cwd: input.repoRoot, env: input.env }
    );
    const manifestPath = join(manifestDir, STAGING_MANIFEST_NAME);
    if (download.exitCode === 0 && existsSync(manifestPath)) {
      const version = parseManifestVersion(readFileSync(manifestPath, "utf8"));
      if (version) {
        const tag = stagingTag(version);
        let commit: string | null = null;
        const stagingView = await input.runner.run("gh", ["release", "view", tag, "--repo", repoSlug, "--json", "targetCommitish"], {
          cwd: input.repoRoot,
          env: input.env
        });
        if (stagingView.exitCode === 0) {
          try {
            commit = parseTargetCommitish(stagingView.stdout);
          } catch {
            commit = null;
          }
        }
        staging = {
          version,
          tag,
          commit,
          commitsBehindMain: commit ? await countCommits(input, `${commit}..origin/main`) : null
        };
      }
    }
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
  }

  let releaseBranch: ReleaseStatusResult["releaseBranch"] = null;
  if (staging) {
    const branchName = releaseSeriesBranch(releaseSeriesFromVersion(staging.version));
    const branchRefs = await input.runner.run("git", ["ls-remote", "origin", `refs/heads/${branchName}`], {
      cwd: input.repoRoot,
      env: input.env
    });
    const branchSha = branchRefs.exitCode === 0 ? branchRefs.stdout.trim().split(/\s+/)[0] ?? "" : "";
    if (branchSha) releaseBranch = { name: branchName, commit: branchSha };
  }

  const commitsOnMainSinceProduction = production ? await countCommits(input, `${production.tag}..origin/main`) : null;
  const promotionBase = releaseBranch ? releaseBranch.commit : originMain;
  const promotable = staging !== null && staging.commit !== null && staging.commit === promotionBase;
  return {
    production,
    staging,
    releaseBranch,
    commitsOnMainSinceProduction,
    promotable,
    promoteCommand: promotable && staging ? `kd release promote ${staging.version}` : null
  };
}
