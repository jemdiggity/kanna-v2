import { generateKeyPairSync, verify, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildExpoManifest,
  buildNoUpdateDirectiveResponse,
  convertSHA256HashToUUID,
  createExpoSignatureHeader,
  parseManifestRequestHeaders,
  verifyManifestSignatureForTest,
  type ExpoExportMetadata,
} from "./ota.js";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

const metadata: ExpoExportMetadata = {
  version: 0,
  bundler: "metro",
  fileMetadata: {
    ios: {
      bundle: "_expo/static/js/ios/main.hbc",
      assets: [{ path: "assets/icon.png", ext: "png" }],
    },
  },
};

const files = new Map<string, Buffer>([
  ["_expo/static/js/ios/main.hbc", Buffer.from("bundle bytes")],
  ["assets/icon.png", Buffer.from("png bytes")],
]);

async function readFile(path: string): Promise<Buffer> {
  const value = files.get(path);
  if (!value) {
    throw new Error(`missing fixture file ${path}`);
  }
  return value;
}

describe("OTA manifest helpers", () => {
  it("converts a SHA-256 hex digest into the Expo update UUID shape", () => {
    expect(
      convertSHA256HashToUUID(
        "12b4a6d57dd65bf2973ec141ef211ca85ba957de46dbbfe84f47bf46e2e4a969"
      )
    ).toBe("12b4a6d5-7dd6-5bf2-973e-c141ef211ca8");
  });

  it("builds protocol-correct iOS manifest JSON from Expo export metadata", async () => {
    const manifest = await buildExpoManifest({
      origin: "https://relay-staging.kanna.build",
      runtimeVersion: "1.0.0",
      platform: "ios",
      updateId: "12b4a6d5-7dd6-5bf2-973e-c141ef211ca8",
      createdAt: "2026-06-24T12:00:00.000Z",
      metadata,
      expoConfig: { name: "Kanna Staging" },
      readFile,
    });

    const bundleHash = createHash("sha256")
      .update(files.get("_expo/static/js/ios/main.hbc") ?? Buffer.alloc(0))
      .digest("base64url");
    const assetHash = createHash("sha256")
      .update(files.get("assets/icon.png") ?? Buffer.alloc(0))
      .digest("base64url");

    expect(manifest).toMatchObject({
      id: "12b4a6d5-7dd6-5bf2-973e-c141ef211ca8",
      createdAt: "2026-06-24T12:00:00.000Z",
      runtimeVersion: "1.0.0",
      metadata: {},
      extra: { expoClient: { name: "Kanna Staging" } },
      launchAsset: {
        key: bundleHash,
        hash: bundleHash,
        contentType: "application/javascript",
        url:
          "https://relay-staging.kanna.build/ota/assets?key=" +
          `${bundleHash}&runtimeVersion=1.0.0&platform=ios`,
      },
      assets: [
        {
          key: assetHash,
          hash: assetHash,
          contentType: "image/png",
          fileExtension: ".png",
          url:
            "https://relay-staging.kanna.build/ota/assets?key=" +
            `${assetHash}&runtimeVersion=1.0.0&platform=ios`,
        },
      ],
    });
  });

  it("creates signatures that verify against the matching public certificate and reject tampering", () => {
    const manifest = JSON.stringify({ id: "12b4a6d5-7dd6-5bf2-973e-c141ef211ca8" });
    const header = createExpoSignatureHeader({
      body: manifest,
      privateKeyPem: privateKey,
      keyId: "kanna-mobile-ota-v1",
    });

    expect(header).toMatch(/^sig="[^"]+", keyid="kanna-mobile-ota-v1", alg="rsa-v1_5-sha256"$/);
    expect(verifyManifestSignatureForTest(manifest, header, privateKey)).toBe(true);
    expect(verifyManifestSignatureForTest(`${manifest} `, header, privateKey)).toBe(false);
  });

  it("builds a signed noUpdateAvailable directive when the client already has the current update", () => {
    const response = buildNoUpdateDirectiveResponse({
      privateKeyPem: privateKey,
      keyId: "kanna-mobile-ota-v1",
    });

    expect(response.body).toContain('name="directive"');
    expect(response.body).toContain('"type":"noUpdateAvailable"');
    expect(response.body).toContain("expo-signature:");
    expect(response.headers["expo-protocol-version"]).toBe("1");
    expect(response.headers["expo-sfv-version"]).toBe("0");
    expect(response.headers["cache-control"]).toBe("private, max-age=0");
  });

  it("validates the shared request contract and rejects unsupported platforms", () => {
    expect(
      parseManifestRequestHeaders({
        "expo-protocol-version": "1",
        "expo-platform": "ios",
        "expo-runtime-version": "1.0.0",
        "expo-channel-name": "staging",
      })
    ).toMatchObject({
      protocolVersion: "1",
      platform: "ios",
      runtimeVersion: "1.0.0",
      channel: "staging",
    });

    expect(() =>
      parseManifestRequestHeaders({
        "expo-protocol-version": "1",
        "expo-platform": "android",
        "expo-runtime-version": "1.0.0",
        "expo-channel-name": "staging",
      })
    ).toThrow("Unsupported Expo platform");
  });
});
