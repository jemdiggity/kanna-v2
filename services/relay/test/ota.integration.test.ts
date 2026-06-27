import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let relayProcess: ChildProcessWithoutNullStreams | null = null;
let storageDir: string | null = null;
let port = 0;

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForRelay(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("relay did not become ready");
}

describe("OTA relay integration", () => {
  beforeAll(async () => {
    port = await findFreePort();
    storageDir = await mkdtemp(join(tmpdir(), "kanna-ota-storage-"));
    const updateRoot = join(
      storageDir,
      "ota/ios/1.0.0/updates/12b4a6d5-7dd6-5bf2-973e-c141ef211ca8"
    );
    await mkdir(join(updateRoot, "bundles"), { recursive: true });
    await mkdir(join(updateRoot, "assets"), { recursive: true });
    await mkdir(join(storageDir, "ota/ios/1.0.0/channels"), { recursive: true });
    const bundleBytes = Buffer.from("bundle bytes");
    const assetBytes = Buffer.from("png bytes");
    const bundleKey = createHash("sha256").update(bundleBytes).digest("base64url");
    const assetKey = createHash("sha256").update(assetBytes).digest("base64url");
    await writeFile(
      join(updateRoot, "metadata.json"),
      JSON.stringify({
        fileMetadata: {
          ios: {
            bundle: `bundles/${bundleKey}.hbc`,
            assets: [{ path: `assets/${assetKey}`, ext: "png" }],
          },
        },
      })
    );
    await writeFile(join(updateRoot, "expoConfig.json"), JSON.stringify({ name: "Kanna" }));
    await writeFile(join(updateRoot, `bundles/${bundleKey}.hbc`), bundleBytes);
    await writeFile(join(updateRoot, `assets/${assetKey}`), assetBytes);
    await writeFile(
      join(storageDir, "ota/ios/1.0.0/channels/staging.json"),
      JSON.stringify({
        currentUpdateId: "12b4a6d5-7dd6-5bf2-973e-c141ef211ca8",
        createdAt: "2026-06-24T12:00:00.000Z",
      })
    );
    const privateKeyPath = join(storageDir, "private-key.pem");
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;
    await writeFile(privateKeyPath, privateKey);

    relayProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PORT: String(port),
        KANNA_OTA_STORAGE_DIR: storageDir,
        KANNA_OTA_PRIVATE_KEY_PATH: privateKeyPath,
      },
      stdio: "pipe",
    });
    relayProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[relay] ${chunk.toString()}`);
    });
    await waitForRelay();
  }, 45_000);

  afterAll(async () => {
    relayProcess?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it("serves a signed multipart manifest and streams assets by hash", async () => {
    const manifestResponse = await fetch(`http://127.0.0.1:${port}/ota/manifest`, {
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": "ios",
        "expo-runtime-version": "1.0.0",
        "expo-channel-name": "staging",
        "expo-expect-signature": 'sig, keyid="kanna-mobile-ota-v1", alg="rsa-v1_5-sha256"',
      },
    });

    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get("content-type")).toContain("multipart/mixed");
    const body = await manifestResponse.text();
    expect(body).toContain('name="manifest"');
    expect(body).toContain("expo-signature:");
    expect(body).toContain('"runtimeVersion":"1.0.0"');

    const key = /"launchAsset":\{"hash":"([^"]+)"/.exec(body)?.[1];
    expect(key).toBeTruthy();
    const assetResponse = await fetch(
      `http://127.0.0.1:${port}/ota/assets?key=${key ?? ""}&runtimeVersion=1.0.0&platform=ios`
    );
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toBe("application/javascript");
    expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await assetResponse.text()).toBe("bundle bytes");

    const assetKey = /"assets":\[\{"hash":"([^"]+)"/.exec(body)?.[1];
    expect(assetKey).toBeTruthy();
    const pngResponse = await fetch(
      `http://127.0.0.1:${port}/ota/assets?key=${assetKey ?? ""}&runtimeVersion=1.0.0&platform=ios`
    );
    expect(pngResponse.status).toBe(200);
    expect(pngResponse.headers.get("content-type")).toBe("image/png");
    expect(await pngResponse.text()).toBe("png bytes");
  });

  it("returns 404 JSON when the channel pointer is missing", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/ota/manifest`, {
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": "ios",
        "expo-runtime-version": "1.0.0",
        "expo-channel-name": "production",
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "No OTA update available for channel production and runtimeVersion 1.0.0",
    });
  });
});
