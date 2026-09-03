import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./process";

/**
 * The pre-upload IPA checks.
 *
 * Every one of these was hand-run three times across the 1.0.0 submissions, and
 * two of them caught real defects. They run inside `kd mobile publish` and
 * hard-fail before the upload stage, because an IPA in Apple's hands cannot be
 * withdrawn cheaply — the first 1.0.0 submission had to be, and it cost a
 * build number and a day.
 */

export interface MobileVerifyCheck {
  status: "PASS" | "FAIL";
  name: string;
  detail: string;
}

export interface MobileVerifyExpectation {
  bundleId: string;
  version: string;
  /** Omitted by standalone `kd mobile verify` when the operator did not name one. */
  buildNumber?: string;
  /**
   * The commit the publish resolved. When named, the source baked into the IPA
   * must match it: version and build number alone do not identify a commit, so
   * without this an archive left behind by an earlier attempt at a different
   * commit passes every other check and ships under the new commit's name.
   */
  sourceCommit?: string;
}

export interface MobileVerifyResult {
  ok: boolean;
  ipaPath: string;
  sha256: string;
  appPath: string;
  checks: MobileVerifyCheck[];
}

const MARKETING_ICON_CANDIDATES = [
  "AppIcon~ios-marketing.png",
  "AppIcon.png",
  "AppIcon60x60@3x.png"
];

function pass(name: string, detail: string): MobileVerifyCheck {
  return { status: "PASS", name, detail };
}

function fail(name: string, detail: string): MobileVerifyCheck {
  return { status: "FAIL", name, detail };
}

/** SHA-256 of the exact bytes that go to Apple, so a later stage can prove identity. */
export async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Unzip the IPA and return the `Payload/*.app` directory inside it.
 *
 * Verification reads the shipped bundle rather than the .xcarchive: the archive
 * is what Xcode built, the IPA is what Apple receives, and export can differ
 * from archive (re-signing, thinning, entitlement rewrites).
 */
export async function extractIpaApp(input: {
  ipaPath: string;
  runner: CommandRunner;
  extractDir?: string;
}): Promise<{ extractDir: string; appPath: string }> {
  if (!existsSync(input.ipaPath)) {
    throw new Error(`No IPA at ${input.ipaPath}.`);
  }
  const extractDir = input.extractDir ?? (await mkdtemp(join(tmpdir(), "kanna-ipa-verify-")));
  const result = await input.runner.run("unzip", ["-q", "-o", input.ipaPath, "-d", extractDir]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Failed to unzip ${input.ipaPath}.`);
  }
  const payload = join(extractDir, "Payload");
  if (!existsSync(payload)) {
    throw new Error(`${input.ipaPath} has no Payload directory; it is not an iOS app archive.`);
  }
  const entries = await readdir(payload);
  const appName = entries.find((entry) => entry.endsWith(".app"));
  if (!appName) {
    throw new Error(`${input.ipaPath} has no .app bundle under Payload/.`);
  }
  return { extractDir, appPath: join(payload, appName) };
}

async function readPlistJson(
  runner: CommandRunner,
  path: string
): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  const result = await runner.run("plutil", ["-convert", "json", "-o", "-", path]);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The signing authority must be `Apple Distribution`. A development or ad-hoc
 * identity produces an IPA App Store Connect rejects only after upload.
 */
export async function checkCodesignAuthority(input: {
  appPath: string;
  runner: CommandRunner;
}): Promise<MobileVerifyCheck> {
  const name = "codesign authority";
  // codesign writes its report to stderr.
  const result = await input.runner.run("codesign", ["-dvvv", input.appPath]);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    return fail(name, output.trim() || `codesign -dvvv ${input.appPath} failed.`);
  }
  const authorities = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice("Authority=".length));
  const leaf = authorities[0];
  if (!leaf) {
    return fail(name, "codesign reported no Authority lines; the bundle is unsigned.");
  }
  if (!leaf.startsWith("Apple Distribution")) {
    return fail(name, `signing authority is ${JSON.stringify(leaf)}, expected an Apple Distribution certificate.`);
  }
  return pass(name, leaf);
}

interface ProvisioningProfile {
  name?: string;
  hasProvisionedDevices: boolean;
  applicationIdentifier?: string;
}

export function parseProvisioningProfile(plist: Record<string, unknown>): ProvisioningProfile {
  const entitlements = plist.Entitlements;
  const applicationIdentifier =
    entitlements && typeof entitlements === "object"
      ? (entitlements as Record<string, unknown>)["application-identifier"]
      : undefined;
  return {
    name: typeof plist.Name === "string" ? plist.Name : undefined,
    hasProvisionedDevices: Array.isArray(plist.ProvisionedDevices),
    applicationIdentifier:
      typeof applicationIdentifier === "string" ? applicationIdentifier : undefined
  };
}

/**
 * An App Store profile has no `ProvisionedDevices`. A development or ad-hoc
 * profile does, and produces a build that installs only on the listed devices.
 */
export async function checkProvisioningProfile(input: {
  appPath: string;
  bundleId: string;
  runner: CommandRunner;
}): Promise<MobileVerifyCheck> {
  const name = "provisioning profile";
  const profilePath = join(input.appPath, "embedded.mobileprovision");
  if (!existsSync(profilePath)) {
    return fail(name, `no embedded.mobileprovision in ${input.appPath}.`);
  }
  // The profile is a CMS envelope around a plist; `security cms -D` unwraps it.
  const decoded = await input.runner.run("security", ["cms", "-D", "-i", profilePath]);
  if (decoded.exitCode !== 0) {
    return fail(name, decoded.stderr.trim() || `security cms -D failed on ${profilePath}.`);
  }
  const nameResult = await input.runner.run("plutil", ["-extract", "Name", "raw", "-o", "-", "-"], {
    stdin: decoded.stdout
  });
  const appIdentifierResult = await input.runner.run(
    "plutil",
    ["-extract", "Entitlements.application-identifier", "raw", "-o", "-", "-"],
    { stdin: decoded.stdout }
  );
  if (appIdentifierResult.exitCode !== 0) {
    return fail(
      name,
      appIdentifierResult.stderr.trim() || "the provisioning profile has no application-identifier entitlement."
    );
  }
  const provisionedDevicesResult = await input.runner.run(
    "plutil",
    ["-extract", "ProvisionedDevices", "json", "-o", "-", "-"],
    { stdin: decoded.stdout }
  );
  const profile: ProvisioningProfile = {
    name: nameResult.exitCode === 0 ? nameResult.stdout.trim() : undefined,
    hasProvisionedDevices: provisionedDevicesResult.exitCode === 0,
    applicationIdentifier: appIdentifierResult.stdout.trim()
  };
  if (profile.hasProvisionedDevices) {
    return fail(
      name,
      `${profile.name ?? "profile"} lists ProvisionedDevices, so it is a development or ad-hoc profile, not App Store.`
    );
  }
  if (!profile.applicationIdentifier) {
    return fail(name, `${profile.name ?? "profile"} has no application-identifier entitlement.`);
  }
  // The entitlement is <TeamID>.<bundle id>, or <TeamID>.* for a wildcard profile.
  const suffix = profile.applicationIdentifier.replace(/^[^.]+\./, "");
  if (suffix !== input.bundleId) {
    return fail(
      name,
      `${profile.name ?? "profile"} is for ${suffix}, but the app is ${input.bundleId}.`
    );
  }
  return pass(name, `${profile.name ?? "profile"} — App Store profile for ${input.bundleId}`);
}

/**
 * The plan and the IPA must agree. This is the check that would have caught the
 * withdrawn first submission before it reached Apple.
 */
export async function checkBundleIdentity(input: {
  appPath: string;
  expected: MobileVerifyExpectation;
  runner: CommandRunner;
}): Promise<MobileVerifyCheck> {
  const name = "plan/IPA agreement";
  const infoPlist = join(input.appPath, "Info.plist");
  const plist = await readPlistJson(input.runner, infoPlist);
  if (!plist) {
    return fail(name, `could not read ${infoPlist}.`);
  }
  const actual = {
    bundleId: typeof plist.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : undefined,
    version:
      typeof plist.CFBundleShortVersionString === "string"
        ? plist.CFBundleShortVersionString
        : undefined,
    buildNumber: typeof plist.CFBundleVersion === "string" ? plist.CFBundleVersion : undefined
  };
  const mismatches: string[] = [];
  if (actual.bundleId !== input.expected.bundleId) {
    mismatches.push(`bundle id ${actual.bundleId ?? "missing"} != ${input.expected.bundleId}`);
  }
  if (actual.version !== input.expected.version) {
    mismatches.push(`version ${actual.version ?? "missing"} != ${input.expected.version}`);
  }
  if (input.expected.buildNumber !== undefined && actual.buildNumber !== input.expected.buildNumber) {
    mismatches.push(`build number ${actual.buildNumber ?? "missing"} != ${input.expected.buildNumber}`);
  }
  if (mismatches.length > 0) {
    return fail(name, mismatches.join("; "));
  }
  const buildDetail =
    input.expected.buildNumber === undefined
      ? `build ${actual.buildNumber ?? "missing"} (not asserted; pass --build-number to check it)`
      : `build ${actual.buildNumber}`;
  return pass(name, `${actual.bundleId} ${actual.version} ${buildDetail}`);
}

export function parseSipsProperties(stdout: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\w+):\s*(.+?)\s*$/);
    if (match) {
      properties[match[1]] = match[2];
    }
  }
  return properties;
}

/**
 * App Store Connect rejects a 1024 marketing icon that carries an alpha
 * channel. The rejection arrives by email after processing, so catching it here
 * saves a build number.
 */
export async function checkMarketingIcon(input: {
  appPath: string;
  runner: CommandRunner;
}): Promise<MobileVerifyCheck> {
  const name = "1024 marketing icon";
  const iconPath = MARKETING_ICON_CANDIDATES.map((candidate) => join(input.appPath, candidate)).find(
    (candidate) => existsSync(candidate)
  );
  if (!iconPath) {
    const assetCatalogPath = join(input.appPath, "Assets.car");
    if (!existsSync(assetCatalogPath)) {
      return fail(
        name,
        `no marketing icon in ${input.appPath}; looked for ${MARKETING_ICON_CANDIDATES.join(", ")} and Assets.car.`
      );
    }
    const catalog = await input.runner.run("xcrun", ["assetutil", "--info", assetCatalogPath]);
    if (catalog.exitCode !== 0) {
      return fail(name, catalog.stderr.trim() || `assetutil failed on ${assetCatalogPath}.`);
    }
    let renditions: unknown;
    try {
      renditions = JSON.parse(catalog.stdout) as unknown;
    } catch {
      return fail(name, `${assetCatalogPath} metadata is not valid JSON.`);
    }
    if (!Array.isArray(renditions)) {
      return fail(name, `${assetCatalogPath} metadata is not an array.`);
    }
    const marketingIcon = renditions.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const rendition = entry as Record<string, unknown>;
      return rendition.PixelWidth === 1024 && rendition.PixelHeight === 1024 && rendition.Name === "AppIcon";
    }) as Record<string, unknown> | undefined;
    if (!marketingIcon) {
      return fail(name, `${assetCatalogPath} has no 1024x1024 AppIcon rendition.`);
    }
    if (marketingIcon.Opaque !== true) {
      return fail(name, `${assetCatalogPath} 1024x1024 AppIcon is not marked opaque.`);
    }
    const renditionName = typeof marketingIcon.RenditionName === "string"
      ? marketingIcon.RenditionName
      : "AppIcon";
    return pass(name, `${assetCatalogPath} (${renditionName}) — 1024x1024, opaque`);
  }
  const result = await input.runner.run("sips", [
    "-g",
    "hasAlpha",
    "-g",
    "pixelWidth",
    "-g",
    "pixelHeight",
    iconPath
  ]);
  if (result.exitCode !== 0) {
    return fail(name, result.stderr.trim() || `sips failed on ${iconPath}.`);
  }
  const properties = parseSipsProperties(result.stdout);
  if (properties.hasAlpha !== "no") {
    return fail(
      name,
      `${iconPath} has an alpha channel (hasAlpha: ${properties.hasAlpha ?? "unknown"}); App Store Connect rejects it.`
    );
  }
  const width = properties.pixelWidth;
  const height = properties.pixelHeight;
  if (width !== "1024" || height !== "1024") {
    return fail(name, `${iconPath} is ${width ?? "?"}x${height ?? "?"}, expected 1024x1024.`);
  }
  return pass(name, `${iconPath} — 1024x1024, opaque`);
}

interface EmbeddedExpoConfig {
  extra?: {
    kanna?: {
      appEnv?: string;
      ota?: { channel?: string | null };
      source?: { ref?: string; commit?: string };
    };
  };
}

/**
 * Locate the Expo config expo-constants bakes into the bundle.
 *
 * `EXConstantsService.appConfig` reads `EXConstants.bundle/app.config` from the
 * resource directory of the bundle its class lives in. This repo pins static
 * pod linkage, so that is the `.app` root — but a dynamic-framework build would
 * put it under `Frameworks/*.framework/`, and the resource bundle name is an
 * expo-constants implementation detail either way. Scan rather than assume: a
 * wrong path here would fail an otherwise correct release build.
 */
async function findEmbeddedAppConfig(appPath: string): Promise<string | null> {
  const preferred = join(appPath, "EXConstants.bundle", "app.config");
  if (existsSync(preferred)) return preferred;
  const roots = [appPath];
  try {
    for (const entry of await readdir(join(appPath, "Frameworks"))) {
      if (entry.endsWith(".framework")) roots.push(join(appPath, "Frameworks", entry));
    }
  } catch {
    // No Frameworks directory: a statically linked build, which is the norm here.
  }
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".bundle")) continue;
      const candidate = join(root, entry, "app.config");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The shipped JS must be the production configuration.
 *
 * A staging shell wrapping production JS (or the reverse) fails at
 * authentication with a message indistinguishable from a wrong password, which
 * is exactly what happened during the 1.0.0 release.
 */
export async function checkEmbeddedEnvironment(input: {
  appPath: string;
  runner: CommandRunner;
  /** When named, the commit the IPA must have been built from. */
  sourceCommit?: string;
}): Promise<MobileVerifyCheck> {
  const name = "embedded environment";
  const configPath = await findEmbeddedAppConfig(input.appPath);
  if (!configPath) {
    return fail(name, `no embedded app.config under ${input.appPath}; cannot prove the shipped JS is production.`);
  }
  let config: EmbeddedExpoConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as EmbeddedExpoConfig;
  } catch {
    return fail(name, `${configPath} is not valid JSON.`);
  }
  const kanna = config.extra?.kanna;
  if (kanna?.appEnv !== "prod") {
    return fail(name, `${configPath} declares appEnv ${JSON.stringify(kanna?.appEnv ?? null)}, expected "prod".`);
  }
  if (kanna.ota?.channel !== "production") {
    return fail(
      name,
      `${configPath} declares OTA channel ${JSON.stringify(kanna.ota?.channel ?? null)}, expected "production".`
    );
  }
  // The native side carries the channel too; when it is present it must agree,
  // because that pairing is exactly what a mismatched shell gets wrong.
  const infoPlist = await readPlistJson(input.runner, join(input.appPath, "Info.plist"));
  const requestHeaders = infoPlist?.EXUpdatesRequestHeaders;
  const nativeChannel =
    requestHeaders && typeof requestHeaders === "object"
      ? (requestHeaders as Record<string, unknown>)["expo-channel-name"]
      : undefined;
  if (typeof nativeChannel === "string" && nativeChannel !== "production") {
    return fail(
      name,
      `Info.plist requests OTA channel ${JSON.stringify(nativeChannel)} but the JS declares production; ` +
        "the native shell and the JS bundle came from different environments."
    );
  }
  // The baked source is evidence, not decoration: it is the only thing in the
  // binary that identifies the commit, and reuse keys on version and build
  // number, which a rerun at a different commit keeps.
  const source = kanna.source;
  if (input.sourceCommit) {
    if (!source?.commit) {
      return fail(
        name,
        `${configPath} bakes in no source commit, so the IPA cannot be proven to come from ` +
          `${input.sourceCommit.slice(0, 12)}. Rebuild with --force-rebuild.`
      );
    }
    if (source.commit !== input.sourceCommit) {
      return fail(
        name,
        `the IPA was built from ${source.ref ?? "unknown ref"} ${source.commit.slice(0, 12)}, but this ` +
          `publish resolved ${input.sourceCommit.slice(0, 12)}. Artifacts from an earlier attempt at ` +
          "another commit are on disk; rebuild with --force-rebuild."
      );
    }
  }
  const provenance = source?.commit
    ? ` (built from ${source.ref ?? "unknown ref"} ${source.commit.slice(0, 12)})`
    : "";
  return pass(name, `appEnv prod, OTA channel production${provenance}`);
}

/**
 * Read the provenance `kd mobile archive` bakes into a built `.app`.
 *
 * Exported so the archive layer can decide whether artifacts on disk came from
 * the commit being published, which version and build number cannot tell it.
 */
export async function readEmbeddedSource(
  appPath: string
): Promise<{ ref?: string; commit?: string } | null> {
  const configPath = await findEmbeddedAppConfig(appPath);
  if (!configPath) return null;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as EmbeddedExpoConfig;
    return config.extra?.kanna?.source ?? null;
  } catch {
    return null;
  }
}

/** Run every check against an already-extracted `.app`. */
export async function verifyExtractedApp(input: {
  appPath: string;
  expected: MobileVerifyExpectation;
  runner: CommandRunner;
}): Promise<MobileVerifyCheck[]> {
  return [
    await checkCodesignAuthority({ appPath: input.appPath, runner: input.runner }),
    await checkProvisioningProfile({
      appPath: input.appPath,
      bundleId: input.expected.bundleId,
      runner: input.runner
    }),
    await checkBundleIdentity({
      appPath: input.appPath,
      expected: input.expected,
      runner: input.runner
    }),
    await checkMarketingIcon({ appPath: input.appPath, runner: input.runner }),
    await checkEmbeddedEnvironment({
      appPath: input.appPath,
      runner: input.runner,
      sourceCommit: input.expected.sourceCommit
    })
  ];
}

export async function verifyMobileIpa(input: {
  ipaPath: string;
  expected: MobileVerifyExpectation;
  runner: CommandRunner;
  extractDir?: string;
}): Promise<MobileVerifyResult> {
  const { appPath } = await extractIpaApp({
    ipaPath: input.ipaPath,
    runner: input.runner,
    extractDir: input.extractDir
  });
  const checks = await verifyExtractedApp({
    appPath,
    expected: input.expected,
    runner: input.runner
  });
  return {
    ok: checks.every((check) => check.status === "PASS"),
    ipaPath: input.ipaPath,
    sha256: await hashFile(input.ipaPath),
    appPath,
    checks
  };
}

export function formatMobileVerifyResult(result: MobileVerifyResult): string {
  return [
    `IPA: ${result.ipaPath}`,
    `SHA-256: ${result.sha256}`,
    ...result.checks.map((check) => `${check.status} ${check.name} — ${check.detail}`),
    result.ok ? "All pre-upload checks passed." : "Pre-upload checks FAILED; the IPA must not be uploaded."
  ].join("\n");
}
