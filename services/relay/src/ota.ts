import { createHash, createSign, createVerify } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Storage, type File } from "@google-cloud/storage";

export const OTA_CODE_SIGNING_KEY_ID = "kanna-mobile-ota-v1";
const OTA_PROTOCOL_VERSION = "1";
const OTA_PLATFORM = "ios";
const POINTER_CACHE_TTL_MS = 15_000;

export interface ExpoExportMetadata {
  version?: number;
  bundler?: string;
  fileMetadata: Record<
    string,
    {
      bundle: string;
      assets?: ExpoAssetMetadata[];
    }
  >;
}

export interface ExpoAssetMetadata {
  path: string;
  ext?: string;
  contentType?: string;
}

export interface ExpoManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: ExpoManifestAsset;
  assets: ExpoManifestAsset[];
  metadata: Record<string, never>;
  extra: {
    expoClient: unknown;
  };
}

export interface ExpoManifestAsset {
  hash: string;
  key: string;
  contentType: string;
  url: string;
  fileExtension?: string;
}

export interface ManifestRequestHeaders {
  protocolVersion: "1";
  platform: "ios";
  runtimeVersion: string;
  channel: "staging" | "production" | string;
  currentUpdateId?: string;
  expectSignature?: string;
}

export interface OtaChannelPointer {
  currentUpdateId: string;
  createdAt: string;
}

interface BuildManifestInput {
  origin: string;
  runtimeVersion: string;
  platform: "ios";
  updateId: string;
  createdAt: string;
  metadata: ExpoExportMetadata;
  expoConfig: unknown;
  readFile: (path: string) => Promise<Buffer>;
}

interface SignedMultipartInput {
  partName: "manifest" | "directive";
  body: string;
  privateKeyPem: string;
  keyId: string;
}

interface SignedMultipartResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface OtaAssetResult {
  buffer: Buffer;
  contentType: string;
}

interface OtaStorageBackend {
  readJson<T>(path: string): Promise<T | null>;
  readBuffer(path: string): Promise<Buffer | null>;
  findAsset(runtimeVersion: string, platform: "ios", key: string): Promise<OtaAssetResult | null>;
}

interface CachedPointer {
  pointer: OtaChannelPointer | null;
  expiresAt: number;
}

let pointerCache = new Map<string, CachedPointer>();

export function resetOtaCacheForTest(): void {
  pointerCache = new Map();
}

export function convertSHA256HashToUUID(hash: string): string {
  const normalized = hash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Expected a SHA-256 hex digest.");
  }
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ].join("-");
}

export function sha256Base64Url(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64url");
}

export function parseManifestRequestHeaders(headers: IncomingHttpHeaders): ManifestRequestHeaders {
  const protocolVersion = singleHeader(headers["expo-protocol-version"]);
  if (protocolVersion !== OTA_PROTOCOL_VERSION) {
    throw new Error("Unsupported Expo Updates protocol version.");
  }

  const platform = singleHeader(headers["expo-platform"]);
  if (platform !== OTA_PLATFORM) {
    throw new Error("Unsupported Expo platform.");
  }

  const runtimeVersion = singleHeader(headers["expo-runtime-version"]);
  if (!runtimeVersion) {
    throw new Error("Missing expo-runtime-version header.");
  }

  const channel = singleHeader(headers["expo-channel-name"]);
  if (!channel) {
    throw new Error("Missing expo-channel-name header.");
  }

  const currentUpdateId = singleHeader(headers["expo-current-update-id"]);
  const expectSignature = singleHeader(headers["expo-expect-signature"]);

  return {
    protocolVersion: OTA_PROTOCOL_VERSION,
    platform: OTA_PLATFORM,
    runtimeVersion,
    channel,
    ...(currentUpdateId ? { currentUpdateId } : {}),
    ...(expectSignature ? { expectSignature } : {}),
  };
}

export async function buildExpoManifest(input: BuildManifestInput): Promise<ExpoManifest> {
  const platformMetadata = input.metadata.fileMetadata[input.platform];
  if (!platformMetadata) {
    throw new Error(`Expo export metadata does not include platform ${input.platform}.`);
  }

  const bundle = await input.readFile(platformMetadata.bundle);
  const bundleHash = sha256Base64Url(bundle);
  const launchAsset: ExpoManifestAsset = {
    hash: bundleHash,
    key: bundleHash,
    contentType: "application/javascript",
    fileExtension: ".hbc",
    url: buildAssetUrl(input.origin, bundleHash, input.runtimeVersion, input.platform),
  };

  const assets = await Promise.all(
    (platformMetadata.assets ?? []).map(async (asset) => {
      const content = await input.readFile(asset.path);
      const hash = sha256Base64Url(content);
      const fileExtension = normalizeFileExtension(asset.ext ?? extname(asset.path));
      return {
        hash,
        key: hash,
        contentType: asset.contentType ?? inferContentType(fileExtension || asset.path),
        url: buildAssetUrl(input.origin, hash, input.runtimeVersion, input.platform),
        ...(fileExtension ? { fileExtension } : {}),
      };
    })
  );

  return {
    id: input.updateId,
    createdAt: input.createdAt,
    runtimeVersion: input.runtimeVersion,
    launchAsset,
    assets,
    metadata: {},
    extra: {
      expoClient: input.expoConfig,
    },
  };
}

export function createExpoSignatureHeader(input: {
  body: string;
  privateKeyPem: string;
  keyId: string;
}): string {
  const signature = createSign("RSA-SHA256")
    .update(input.body)
    .end()
    .sign(input.privateKeyPem, "base64");
  return [
    `sig="${escapeStructuredFieldString(signature)}"`,
    `keyid="${escapeStructuredFieldString(input.keyId)}"`,
    'alg="rsa-v1_5-sha256"',
  ].join(", ");
}

export function verifyManifestSignatureForTest(
  body: string,
  signatureHeader: string,
  publicKeyPem: string
): boolean {
  const fields = parseStructuredDictionary(signatureHeader);
  const signature = fields.get("sig");
  if (!signature) return false;
  return createVerify("RSA-SHA256").update(body).end().verify(publicKeyPem, signature, "base64");
}

export function buildNoUpdateDirectiveResponse(input: {
  privateKeyPem: string;
  keyId: string;
}): SignedMultipartResponse {
  return buildSignedMultipartResponse({
    partName: "directive",
    body: JSON.stringify({ type: "noUpdateAvailable" }),
    privateKeyPem: input.privateKeyPem,
    keyId: input.keyId,
  });
}

export async function handleOtaRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", resolveOrigin(req));
  if (req.method === "GET" && url.pathname === "/ota/manifest") {
    await handleManifestRequest(req, res);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/ota/assets") {
    await handleAssetRequest(url, res);
    return true;
  }
  return false;
}

async function handleManifestRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let headers: ManifestRequestHeaders;
  try {
    headers = parseManifestRequestHeaders(req.headers);
  } catch (error) {
    jsonResponse(res, 400, { error: errorMessage(error) });
    return;
  }

  const storage = createOtaStorageBackend();
  const pointer = await readCachedPointer(storage, headers.runtimeVersion, headers.platform, headers.channel);
  if (!pointer) {
    jsonResponse(res, 404, {
      error: `No OTA update available for channel ${headers.channel} and runtimeVersion ${headers.runtimeVersion}`,
    });
    return;
  }

  const privateKeyPem = await readOtaPrivateKey();
  if (!privateKeyPem) {
    jsonResponse(res, 503, { error: "OTA code-signing key is not configured." });
    return;
  }

  if (headers.currentUpdateId === pointer.currentUpdateId) {
    const response = buildNoUpdateDirectiveResponse({
      privateKeyPem,
      keyId: otaKeyId(),
    });
    writeMultipartResponse(res, response);
    return;
  }

  const updatePrefix = updateObjectPrefix(headers.runtimeVersion, headers.platform, pointer.currentUpdateId);
  const [metadata, expoConfig] = await Promise.all([
    storage.readJson<ExpoExportMetadata>(`${updatePrefix}/metadata.json`),
    storage.readJson<unknown>(`${updatePrefix}/expoConfig.json`),
  ]);
  if (!metadata || !expoConfig) {
    jsonResponse(res, 404, { error: `OTA update ${pointer.currentUpdateId} is incomplete.` });
    return;
  }

  const manifest = await buildExpoManifest({
    origin: resolveOrigin(req),
    runtimeVersion: headers.runtimeVersion,
    platform: headers.platform,
    updateId: pointer.currentUpdateId,
    createdAt: pointer.createdAt,
    metadata,
    expoConfig,
    readFile: async (path) => {
      const buffer = await storage.readBuffer(`${updatePrefix}/${path}`);
      if (!buffer) {
        throw new Error(`OTA artifact not found: ${path}`);
      }
      return buffer;
    },
  });
  const response = buildSignedMultipartResponse({
    partName: "manifest",
    body: JSON.stringify(manifest),
    privateKeyPem,
    keyId: otaKeyId(),
  });
  writeMultipartResponse(res, response);
}

async function handleAssetRequest(url: URL, res: ServerResponse): Promise<void> {
  const key = url.searchParams.get("key")?.trim();
  const runtimeVersion = url.searchParams.get("runtimeVersion")?.trim();
  const platform = url.searchParams.get("platform")?.trim();
  if (!key || !runtimeVersion || platform !== OTA_PLATFORM) {
    jsonResponse(res, 400, { error: "Expected key, runtimeVersion, and platform=ios." });
    return;
  }

  const asset = await createOtaStorageBackend().findAsset(runtimeVersion, OTA_PLATFORM, key);
  if (!asset) {
    jsonResponse(res, 404, { error: "OTA asset not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": String(asset.buffer.byteLength),
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(asset.buffer);
}

function buildSignedMultipartResponse(input: SignedMultipartInput): SignedMultipartResponse {
  const boundary = `kanna-ota-${createHash("sha256").update(input.body).digest("hex").slice(0, 16)}`;
  const signatureHeader = createExpoSignatureHeader({
    body: input.body,
    privateKeyPem: input.privateKeyPem,
    keyId: input.keyId,
  });
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${input.partName}"`,
    "Content-Type: application/json",
    `expo-signature: ${signatureHeader}`,
    "",
    input.body,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return {
    status: 200,
    headers: {
      "content-type": `multipart/mixed; boundary=${boundary}`,
      "expo-protocol-version": OTA_PROTOCOL_VERSION,
      "expo-sfv-version": "0",
      "cache-control": "private, max-age=0",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  };
}

function writeMultipartResponse(res: ServerResponse, response: SignedMultipartResponse): void {
  res.writeHead(response.status, response.headers);
  res.end(response.body);
}

async function readCachedPointer(
  storage: OtaStorageBackend,
  runtimeVersion: string,
  platform: "ios",
  channel: string
): Promise<OtaChannelPointer | null> {
  const cacheKey = `${platform}:${runtimeVersion}:${channel}`;
  const cached = pointerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.pointer;
  }

  const pointer = await storage.readJson<OtaChannelPointer>(
    `ota/${platform}/${runtimeVersion}/channels/${channel}.json`
  );
  pointerCache.set(cacheKey, { pointer, expiresAt: Date.now() + POINTER_CACHE_TTL_MS });
  return pointer;
}

function createOtaStorageBackend(): OtaStorageBackend {
  const localRoot = process.env.KANNA_OTA_STORAGE_DIR?.trim();
  if (localRoot) {
    return new LocalOtaStorageBackend(localRoot);
  }
  const bucket = process.env.KANNA_OTA_BUCKET?.trim() || defaultBucketName();
  return new GcsOtaStorageBackend(bucket);
}

function defaultBucketName(): string {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("KANNA_OTA_BUCKET or FIREBASE_PROJECT_ID is required for OTA storage.");
  }
  return `${projectId}.firebasestorage.app`;
}

class LocalOtaStorageBackend implements OtaStorageBackend {
  constructor(private readonly root: string) {}

  async readJson<T>(path: string): Promise<T | null> {
    const buffer = await this.readBuffer(path);
    if (!buffer) return null;
    return JSON.parse(buffer.toString("utf8")) as T;
  }

  async readBuffer(path: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.root, path));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async findAsset(runtimeVersion: string, platform: "ios", key: string): Promise<OtaAssetResult | null> {
    const base = join(this.root, "ota", platform, runtimeVersion, "updates");
    const files = await listFiles(base).catch((error: unknown) => {
      if (isNotFound(error)) return [];
      throw error;
    });
    for (const path of files) {
      const normalized = relative(base, path).split("/").join("/");
      if (!normalized.endsWith(`/assets/${key}`) && !normalized.endsWith(`/bundles/${key}.hbc`)) {
        continue;
      }
      const buffer = await readFile(path);
      return {
        buffer,
        contentType: await this.contentTypeForObject(runtimeVersion, platform, normalized, key),
      };
    }
    return null;
  }

  private async contentTypeForObject(
    runtimeVersion: string,
    platform: "ios",
    normalizedObjectPath: string,
    key: string
  ): Promise<string> {
    const [updateId, artifactKind] = normalizedObjectPath.split("/");
    if (artifactKind === "bundles") {
      return "application/javascript";
    }
    if (!updateId) {
      return inferContentType(normalizedObjectPath);
    }
    const metadataPath = join(
      this.root,
      "ota",
      platform,
      runtimeVersion,
      "updates",
      updateId,
      "metadata.json"
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ExpoExportMetadata;
    return contentTypeFromMetadata(metadata, platform, key) ?? inferContentType(normalizedObjectPath);
  }
}

class GcsOtaStorageBackend implements OtaStorageBackend {
  private readonly storage = new Storage();

  constructor(private readonly bucketName: string) {}

  async readJson<T>(path: string): Promise<T | null> {
    const buffer = await this.readBuffer(path);
    if (!buffer) return null;
    return JSON.parse(buffer.toString("utf8")) as T;
  }

  async readBuffer(path: string): Promise<Buffer | null> {
    const file = this.storage.bucket(this.bucketName).file(path);
    try {
      const [buffer] = await file.download();
      return buffer;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async findAsset(runtimeVersion: string, platform: "ios", key: string): Promise<OtaAssetResult | null> {
    const prefix = `ota/${platform}/${runtimeVersion}/updates/`;
    const [files] = await this.storage.bucket(this.bucketName).getFiles({ prefix });
    const file = files.find((candidate) => assetObjectMatchesKey(candidate.name, key));
    if (!file) return null;
    const [buffer] = await file.download();
    return {
      buffer,
      contentType: await this.contentTypeForObject(file, prefix, platform, key),
    };
  }

  private async contentTypeForObject(
    file: File,
    updatesPrefix: string,
    platform: "ios",
    key: string
  ): Promise<string> {
    if (file.name.endsWith(`/bundles/${key}.hbc`)) {
      return "application/javascript";
    }
    const updateId = updateIdFromObjectName(file.name, updatesPrefix);
    if (!updateId) {
      return await readGcsContentType(file);
    }
    const metadata = await this.readJson<ExpoExportMetadata>(`${updatesPrefix}${updateId}/metadata.json`);
    return contentTypeFromMetadata(metadata, platform, key) ?? await readGcsContentType(file);
  }
}

function updateIdFromObjectName(name: string, updatesPrefix: string): string | null {
  if (!name.startsWith(updatesPrefix)) return null;
  const [updateId] = name.slice(updatesPrefix.length).split("/");
  return updateId || null;
}

function contentTypeFromMetadata(
  metadata: ExpoExportMetadata | null,
  platform: "ios",
  key: string
): string | null {
  const assets = metadata?.fileMetadata[platform]?.assets ?? [];
  const asset = assets.find((candidate) => candidate.path === `assets/${key}`);
  if (!asset) return null;
  return asset.contentType ?? inferContentType(asset.ext ?? asset.path);
}

async function readGcsContentType(file: File): Promise<string> {
  const [metadata] = await file.getMetadata();
  const contentType = metadata.contentType;
  return typeof contentType === "string" && contentType.length > 0
    ? contentType
    : inferContentType(file.name);
}

function assetObjectMatchesKey(name: string, key: string): boolean {
  return name.endsWith(`/assets/${key}`) || name.endsWith(`/bundles/${key}.hbc`);
}

function updateObjectPrefix(runtimeVersion: string, platform: "ios", updateId: string): string {
  return `ota/${platform}/${runtimeVersion}/updates/${updateId}`;
}

function buildAssetUrl(origin: string, key: string, runtimeVersion: string, platform: "ios"): string {
  const url = new URL("/ota/assets", origin);
  url.searchParams.set("key", key);
  url.searchParams.set("runtimeVersion", runtimeVersion);
  url.searchParams.set("platform", platform);
  return url.toString();
}

function normalizeFileExtension(extension: string | undefined): string | undefined {
  if (!extension) return undefined;
  return extension.startsWith(".") ? extension : `.${extension}`;
}

function inferContentType(pathOrExtension: string): string {
  const extension = normalizeFileExtension(extname(pathOrExtension) || pathOrExtension);
  switch (extension) {
    case ".hbc":
    case ".js":
      return "application/javascript";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function readOtaPrivateKey(): Promise<string | null> {
  const inline = process.env.KANNA_OTA_PRIVATE_KEY_PEM?.trim();
  if (inline) return inline.replace(/\\n/g, "\n");
  const path = process.env.KANNA_OTA_PRIVATE_KEY_PATH?.trim();
  if (!path) return null;
  return await readFile(path, "utf8");
}

function otaKeyId(): string {
  return process.env.KANNA_OTA_KEY_ID?.trim() || OTA_CODE_SIGNING_KEY_ID;
}

function resolveOrigin(req: IncomingMessage): string {
  const forwardedProto = singleHeader(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto || (process.env.KANNA_RELAY_DOMAIN ? "https" : "http");
  const host = singleHeader(req.headers["x-forwarded-host"]) || singleHeader(req.headers.host);
  if (host) {
    return `${proto}://${host}`;
  }
  const domain = process.env.KANNA_RELAY_DOMAIN?.trim();
  return domain ? `https://${domain}` : "http://127.0.0.1:8080";
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function escapeStructuredFieldString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseStructuredDictionary(header: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of header.split(",")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    const rawValue = rawValueParts.join("=");
    if (!rawKey || !rawValue) continue;
    result.set(rawKey, rawValue.replace(/^"|"$/g, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return result;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...await listFiles(path));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown };
  return record.code === "ENOENT" || record.code === 404;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
