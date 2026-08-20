import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The status surface as an operator actually reaches it: a real relay process,
 * a real HTTP request, and the operator token the deploy puts on the VM.
 *
 * Spawned rather than unit-tested because the thing under test is the wiring —
 * that `/stats` and `/dashboard` are routed, gated, and served by the same
 * process that owns the counters.
 */

const BUILD_COMMIT = "abcdef012345";
const STATS_TOKEN = "relay-stats-token-for-tests";

let relayProcess: ChildProcessWithoutNullStreams | null = null;
let port = 0;

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      probe.close((error) => {
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

describe("relay status dashboard", () => {
  beforeAll(async () => {
    port = await findFreePort();
    relayProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PORT: String(port),
        KANNA_RELAY_COMMIT: BUILD_COMMIT,
        KANNA_RELAY_STATS_TOKEN: STATS_TOKEN,
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
  });

  it("refuses /stats without a credential", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/stats`);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("serves the stats payload to the operator token", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/stats`, {
      headers: { Authorization: `Bearer ${STATS_TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const body = await response.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.commit).toBe(BUILD_COMMIT);
    expect(body.connections).toBe(0);
    expect(body.bytes).toMatchObject({
      connections: { open: 0, opened: 0, closed: 0 },
      received: { tunnel: 0, taskTransfer: 0, terminalEvent: 0, control: 0, total: 0 },
      sent: { tunnel: 0, taskTransfer: 0, terminalEvent: 0, control: 0, total: 0 },
      totalBytes: 0,
    });
    expect(typeof (body.bytes as { startedAt?: unknown }).startedAt).toBe("string");
    expect(body.compression).toEqual({ negotiated: 0, plain: 0 });
    expect(body.tunnelFlow).toEqual({
      pauseCount: 0,
      resumeCount: 0,
      capRejectCount: 0,
      maxBufferedBytes: 0,
    });
    expect(body.upgrades).toEqual({
      admitted: 0,
      refused: { total: 0, byStatus: {} },
      trackedAddresses: 0,
    });
    // Per-connection rows are the operator's to see, and this caller is one.
    expect(body.liveConnections).toEqual([]);
    expect(body.recentConnections).toEqual([]);
  });

  it("accepts the operator token from the query string, for the dashboard's own URL", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/stats?token=${encodeURIComponent(STATS_TOKEN)}`,
    );

    expect(response.status).toBe(200);
    expect((await response.json() as { status?: unknown }).status).toBe("ok");
  });

  it("serves the dashboard page to the operator token and refuses it otherwise", async () => {
    const refused = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(refused.status).toBe(401);

    const response = await fetch(
      `http://127.0.0.1:${port}/dashboard?token=${encodeURIComponent(STATS_TOKEN)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const html = await response.text();
    expect(html).toContain("Kanna relay status");
    // Dependency-free: nothing on this page may be fetched from another host.
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\//);
    // It reads its own data from the authenticated stats route.
    expect(html).toContain("fetch('/stats'");
  });

  it("leaves /health unauthenticated and unchanged", async () => {
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
        maxBufferedBytes: 0,
      },
    });
  });
});
