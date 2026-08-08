import type { ServerFrame } from "@kanna/agent-protocol";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./desktopStreamFrameDecoder.worker?worker", async () => {
  const { Worker: NodeWorker } = await import("node:worker_threads");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  class RealDecoderWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly worker = new NodeWorker(
      pathToFileURL(resolve(
        process.cwd(),
        "src/services/desktopStreamFrameDecoder.nodeTestWorker.ts",
      )),
    );

    constructor() {
      this.worker.on("message", (data) => {
        this.onmessage?.({ data } as MessageEvent<unknown>);
      });
      this.worker.on("error", () => {
        this.onerror?.();
      });
    }

    postMessage(message: unknown, transfer: Transferable[] = []): void {
      this.worker.postMessage(message, transfer as ArrayBuffer[]);
    }

    terminate(): void {
      void this.worker.terminate();
    }
  }

  return { default: RealDecoderWorker };
});

import { createDesktopStreamFrameDecoder } from "./desktopStreamFrameDecoder";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps the main thread schedulable for a real-worker maximum bundle", async () => {
  vi.stubGlobal("Worker", class {});
  const decoder = createDesktopStreamFrameDecoder();
  expect(decoder?.decodeChunks).toBeTypeOf("function");

  const assetDataB64 = Buffer.alloc(16 * 1024 * 1024 / 32).toString("base64");
  const serialized = JSON.stringify({
    type: "companion_snapshot",
    task_id: "task-max-worker",
    session_id: "session-max-worker",
    revision: "revision-max-worker",
    document_kind: "full_document",
    html: "x".repeat(1024 * 1024),
    assets: Array.from({ length: 32 }, (_, index) => ({
      name: `${index}.bin`,
      content_type: "application/octet-stream",
      digest: "d".repeat(64),
      data_b64: assetDataB64,
    })),
  } satisfies ServerFrame);
  const chunks = Array.from(
    { length: Math.ceil(serialized.length / (96 * 1024)) },
    (_, index) => serialized.slice(index * 96 * 1024, (index + 1) * 96 * 1024),
  );

  let ticks = 0;
  let maximumGapMs = 0;
  let previousTick = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maximumGapMs = Math.max(maximumGapMs, now - previousTick);
    previousTick = now;
    ticks += 1;
  }, 1);
  const callStarted = performance.now();
  const decoded = decoder!.decodeChunks!(chunks, "companion");
  const callLatencyMs = performance.now() - callStarted;

  try {
    const frame = await Promise.race([
      decoded,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("real decoder worker timed out")),
          30_000,
        );
      }),
    ]);
    expect(frame).toMatchObject({
      type: "companion_snapshot",
      task_id: "task-max-worker",
      revision: "revision-max-worker",
      html: expect.stringMatching(/^x+$/),
    });
    expect(callLatencyMs).toBeLessThan(100);
    expect(ticks).toBeGreaterThan(10);
    expect(maximumGapMs).toBeLessThan(250);
  } finally {
    clearInterval(heartbeat);
    decoder!.cancel();
  }
}, 40_000);
