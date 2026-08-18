import { createPrivateKey, sign as signSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A thin App Store Connect REST client.
 *
 * The durable Apple interface for a release is this API, not fastlane: the
 * upload lanes fastlane offers wrap the same altool/Transporter churn `kd
 * mobile publish` already drives directly, and a Ruby toolchain would duplicate
 * the identity config kd owns while breaking the repo's vendored-dependency
 * rule. Everything below is `node:crypto` plus `fetch`.
 *
 * Auth is an ES256 JWT signed with the `.p8` key App Store Connect issues.
 * Apple wants the JOSE (r||s, fixed-width) signature encoding rather than the
 * DER encoding Node emits by default, which `dsaEncoding: "ieee-p1363"`
 * produces directly.
 */

export interface AppStoreConnectHttpRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface AppStoreConnectHttpResponse {
  status: number;
  body: string;
}

export interface AppStoreConnectHttpRunner {
  request: (input: AppStoreConnectHttpRequest) => Promise<AppStoreConnectHttpResponse>;
}

export interface AppStoreConnectCredentials {
  keyId: string;
  issuerId: string;
  /** PEM contents of AuthKey_<keyId>.p8. */
  privateKey: string;
}

export interface AppStoreConnectClientOptions {
  credentials: AppStoreConnectCredentials;
  http?: AppStoreConnectHttpRunner;
  baseUrl?: string;
  /** Injected so tests get a deterministic JWT; defaults to the wall clock. */
  now?: () => number;
}

export interface AscBuild {
  id: string;
  version: string;
  processingState: string;
  uploadedDate?: string;
}

export interface AscAppStoreVersion {
  id: string;
  versionString: string;
  appStoreState?: string;
  releaseType?: string;
}

/** The `releaseType` values App Store Connect accepts on an appStoreVersion. */
export const ASC_RELEASE_TYPES = ["MANUAL", "AFTER_APPROVAL", "SCHEDULED"] as const;
export type AscReleaseType = (typeof ASC_RELEASE_TYPES)[number];

export const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";
const JWT_AUDIENCE = "appstoreconnect-v1";
/** Apple rejects App Store Connect tokens with a lifetime over 20 minutes. */
const JWT_LIFETIME_SECONDS = 15 * 60;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build the ES256 bearer token App Store Connect expects.
 *
 * Exported so tests can assert the header/payload without a live request.
 */
export function createAppStoreConnectJwt(
  credentials: AppStoreConnectCredentials,
  nowMs: number
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64Url(
    JSON.stringify({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })
  );
  const payload = base64Url(
    JSON.stringify({
      iss: credentials.issuerId,
      iat: issuedAt,
      exp: issuedAt + JWT_LIFETIME_SECONDS,
      aud: JWT_AUDIENCE
    })
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(credentials.privateKey);
  // ieee-p1363 is the JOSE encoding; Node's default DER encoding is rejected
  // by Apple with an opaque 401.
  const signature = signSync("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363"
  });
  return `${signingInput}.${base64Url(signature)}`;
}

/** Default private key location, matching what Transporter and altool read. */
export function appStoreConnectPrivateKeyPath(keyId: string, home: string = homedir()): string {
  return join(home, ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`);
}

/**
 * Read the credentials from the same environment variables `kd mobile archive`
 * already uses for altool, plus the `.p8` on disk.
 */
export async function resolveAppStoreConnectCredentials(
  env: NodeJS.ProcessEnv,
  options: { home?: string; command?: string } = {}
): Promise<AppStoreConnectCredentials> {
  const command = options.command ?? "mobile publish";
  const keyId = env.APP_STORE_CONNECT_API_KEY_ID?.trim();
  const issuerId = env.APP_STORE_CONNECT_API_ISSUER_ID?.trim();
  if (!keyId || !issuerId) {
    throw new Error(
      `${command} requires APP_STORE_CONNECT_API_KEY_ID and APP_STORE_CONNECT_API_ISSUER_ID.`
    );
  }
  const keyPath = appStoreConnectPrivateKeyPath(keyId, options.home);
  let privateKey: string;
  try {
    privateKey = await readFile(keyPath, "utf8");
  } catch {
    throw new Error(
      `${command} could not read the App Store Connect private key at ${keyPath}. ` +
        "Download AuthKey_<key id>.p8 from App Store Connect and place it there."
    );
  }
  return { keyId, issuerId, privateKey };
}

export const fetchAppStoreConnectHttpRunner: AppStoreConnectHttpRunner = {
  async request(input) {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body
    });
    return { status: response.status, body: await response.text() };
  }
};

interface AscResource {
  id?: string;
  attributes?: Record<string, unknown>;
}

interface AscCollection {
  data?: AscResource[];
  errors?: Array<{ title?: string; detail?: string; status?: string }>;
}

function formatAscErrors(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as AscCollection;
    const errors = parsed.errors ?? [];
    if (errors.length > 0) {
      return errors
        .map((error) => [error.title, error.detail].filter(Boolean).join(": "))
        .join("; ");
    }
  } catch {
    // Fall through to the raw body below.
  }
  return `HTTP ${status}: ${body.slice(0, 500)}`;
}

function readStringAttribute(resource: AscResource, name: string): string | undefined {
  const value = resource.attributes?.[name];
  return typeof value === "string" ? value : undefined;
}

export class AppStoreConnectClient {
  private readonly credentials: AppStoreConnectCredentials;
  private readonly http: AppStoreConnectHttpRunner;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(options: AppStoreConnectClientOptions) {
    this.credentials = options.credentials;
    this.http = options.http ?? fetchAppStoreConnectHttpRunner;
    this.baseUrl = options.baseUrl ?? ASC_BASE_URL;
    this.now = options.now ?? (() => Date.now());
  }

  private async request(
    method: AppStoreConnectHttpRequest["method"],
    path: string,
    query: Record<string, string> = {},
    body?: unknown
  ): Promise<AscCollection> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${createAppStoreConnectJwt(this.credentials, this.now())}`
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const response = await this.http.request({
      method,
      url: url.toString(),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `App Store Connect ${method} ${url.pathname} failed — ${formatAscErrors(response.status, response.body)}`
      );
    }
    if (!response.body.trim()) return {};
    try {
      return JSON.parse(response.body) as AscCollection;
    } catch {
      throw new Error(
        `App Store Connect ${method} ${url.pathname} returned a non-JSON body: ${response.body.slice(0, 200)}`
      );
    }
  }

  /** Resolve the numeric app id for a bundle id. */
  async findAppId(bundleId: string): Promise<string> {
    const result = await this.request("GET", "/v1/apps", {
      "filter[bundleId]": bundleId,
      "fields[apps]": "bundleId,name",
      limit: "10"
    });
    // The bundleId filter is a prefix match on Apple's side, so pin it exactly.
    const match = (result.data ?? []).find(
      (app) => readStringAttribute(app, "bundleId") === bundleId
    );
    if (!match?.id) {
      throw new Error(
        `App Store Connect has no app with bundle id ${bundleId} visible to this API key.`
      );
    }
    return match.id;
  }

  /** Every build already uploaded for a marketing version. */
  async listBuilds(input: { appId: string; version: string }): Promise<AscBuild[]> {
    const result = await this.request("GET", "/v1/builds", {
      "filter[app]": input.appId,
      "filter[preReleaseVersion.version]": input.version,
      "fields[builds]": "version,processingState,uploadedDate",
      limit: "200"
    });
    return (result.data ?? [])
      .filter((build): build is AscResource & { id: string } => typeof build.id === "string")
      .map((build) => ({
        id: build.id,
        version: readStringAttribute(build, "version") ?? "",
        processingState: readStringAttribute(build, "processingState") ?? "UNKNOWN",
        uploadedDate: readStringAttribute(build, "uploadedDate")
      }));
  }

  async findBuild(input: {
    appId: string;
    version: string;
    buildNumber: string;
  }): Promise<AscBuild | null> {
    const builds = await this.listBuilds({ appId: input.appId, version: input.version });
    return builds.find((build) => build.version === input.buildNumber) ?? null;
  }

  async findAppStoreVersion(input: {
    appId: string;
    version: string;
  }): Promise<AscAppStoreVersion | null> {
    const result = await this.request("GET", `/v1/apps/${input.appId}/appStoreVersions`, {
      "filter[versionString]": input.version,
      "fields[appStoreVersions]": "versionString,appStoreState,releaseType",
      limit: "10"
    });
    const match = (result.data ?? []).find(
      (version) => readStringAttribute(version, "versionString") === input.version
    );
    if (!match?.id) return null;
    return {
      id: match.id,
      versionString: input.version,
      appStoreState: readStringAttribute(match, "appStoreState"),
      releaseType: readStringAttribute(match, "releaseType")
    };
  }

  /** Attach a processed build to the App Store version that will ship it. */
  async attachBuildToAppStoreVersion(input: {
    appStoreVersionId: string;
    buildId: string;
  }): Promise<void> {
    await this.request(
      "PATCH",
      `/v1/appStoreVersions/${input.appStoreVersionId}/relationships/build`,
      {},
      { data: { type: "builds", id: input.buildId } }
    );
  }

  async setReleaseType(input: {
    appStoreVersionId: string;
    releaseType: AscReleaseType;
  }): Promise<void> {
    await this.request("PATCH", `/v1/appStoreVersions/${input.appStoreVersionId}`, {}, {
      data: {
        type: "appStoreVersions",
        id: input.appStoreVersionId,
        attributes: { releaseType: input.releaseType }
      }
    });
  }
}

/**
 * Highest build number already consumed for a marketing version.
 *
 * Build numbers are compared numerically: Apple sorts them as strings in some
 * views, so "10" would otherwise look smaller than "9".
 */
export function highestBuildNumber(builds: AscBuild[]): number {
  let highest = 0;
  for (const build of builds) {
    const parsed = Number.parseInt(build.version, 10);
    if (Number.isFinite(parsed) && parsed > highest) {
      highest = parsed;
    }
  }
  return highest;
}

export function parseReleaseType(raw: string): AscReleaseType {
  const normalized = raw.trim().toUpperCase().replace(/-/g, "_");
  const match = ASC_RELEASE_TYPES.find((type) => type === normalized);
  if (!match) {
    throw new Error(
      `--release-type must be one of ${ASC_RELEASE_TYPES.join(", ")}; got ${JSON.stringify(raw)}`
    );
  }
  return match;
}
