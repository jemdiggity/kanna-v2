import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUILD_COMMIT = "1f2e3d4c5b6a";

let relayProcess: ChildProcessWithoutNullStreams | null = null;
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

describe("relay health", () => {
  beforeAll(async () => {
    port = await findFreePort();
    relayProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, PORT: String(port), KANNA_RELAY_COMMIT: BUILD_COMMIT },
      stdio: "pipe"
    });
    relayProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[relay] ${chunk.toString()}`);
    });
    await waitForRelay();
  }, 45_000);

  afterAll(async () => {
    relayProcess?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("reports the source commit the image was built from", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      commit: BUILD_COMMIT,
      connections: 0,
      tunnelFlow: {
        pauseCount: 0,
        resumeCount: 0,
        capRejectCount: 0,
        maxBufferedBytes: 0
      }
    });
  });
});
