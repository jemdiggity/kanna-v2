import type { ServerFrame } from "@kanna/agent-protocol";
import { beforeEach, expect, it, vi } from "vitest";

const workerHarness = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];

    onmessage: ((event: MessageEvent<{ id: number; frame: ServerFrame | null }>) => void) | null =
      null;
    onerror: (() => void) | null = null;
    readonly posted: Array<{
      type?: string;
      id: number;
      data?: string;
      chunks?: readonly string[];
      bytes?: ArrayBuffer;
    }> = [];
    readonly transfers: Transferable[][] = [];
    terminated = false;

    constructor() {
      FakeWorker.instances.push(this);
    }

    postMessage(message: {
      type?: string;
      id: number;
      data?: string;
      chunks?: readonly string[];
      bytes?: ArrayBuffer;
    }, transfer: Transferable[] = []) {
      this.posted.push(message);
      this.transfers.push(transfer);
    }

    terminate() {
      this.terminated = true;
    }

    respond(frame: ServerFrame | null) {
      const posted = this.posted.shift();
      if (!posted) throw new Error("worker has no pending decode");
      this.onmessage?.({
        data: { id: posted.id, frame },
      } as MessageEvent<{ id: number; frame: ServerFrame | null }>);
    }
  }

  return { FakeWorker };
});

vi.mock("./desktopStreamFrameDecoder.worker?worker", () => ({
  default: workerHarness.FakeWorker,
}));

import { createDesktopStreamFrameDecoder } from "./desktopStreamFrameDecoder";

beforeEach(() => {
  workerHarness.FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", class {});
});

it("streams completed companion chunks as bounded transferable buffers", async () => {
  const decoder = createDesktopStreamFrameDecoder();
  expect(decoder?.decodeChunks).toBeTypeOf("function");

  const chunks = Array.from(
    { length: 32 },
    () => "x".repeat(256 * 1024),
  );
  const decoded = decoder!.decodeChunks!(
    chunks,
    "companion",
  );
  const worker = workerHarness.FakeWorker.instances[0];
  expect(worker.posted[0]).toMatchObject({ type: "chunks_start" });
  expect(worker.posted.some((message) => message.chunks !== undefined)).toBe(false);
  expect(worker.posted.every((message) =>
    message.bytes === undefined || message.bytes.byteLength <= 256 * 1024
  )).toBe(true);
  expect(worker.transfers.flat()).not.toHaveLength(0);
  expect(worker.transfers.flat().every((value) => value instanceof ArrayBuffer)).toBe(true);

  worker.respond({
    type: "companion_unavailable",
    task_id: "task-1",
  });
  await expect(decoded).resolves.toEqual({
    type: "companion_unavailable",
    task_id: "task-1",
  });
  decoder!.cancel();
});

it("cancels only one decoder owner's in-flight work", async () => {
  const firstDecoder = createDesktopStreamFrameDecoder();
  const secondDecoder = createDesktopStreamFrameDecoder();
  expect(firstDecoder).toBeDefined();
  expect(secondDecoder).toBeDefined();
  const first = firstDecoder!.decode('{"type":"companion_unavailable","task_id":"first"}')
    .then(
      (frame) => ({ status: "resolved" as const, frame }),
      (error: Error) => ({ status: "rejected" as const, message: error.message }),
    );
  const second = secondDecoder!.decode('{"type":"companion_unavailable","task_id":"second"}')
    .then(
      (frame) => ({ status: "resolved" as const, frame }),
      (error: Error) => ({ status: "rejected" as const, message: error.message }),
    );

  try {
    expect(workerHarness.FakeWorker.instances).toHaveLength(2);
    firstDecoder!.cancel();
    workerHarness.FakeWorker.instances[1].respond({
      type: "companion_unavailable",
      task_id: "second",
    });

    await expect(first).resolves.toEqual({
      status: "rejected",
      message: "desktop stream decoder cancelled",
    });
    await expect(second).resolves.toEqual({
      status: "resolved",
      frame: {
        type: "companion_unavailable",
        task_id: "second",
      },
    });
    expect(workerHarness.FakeWorker.instances[0].terminated).toBe(true);
    expect(workerHarness.FakeWorker.instances[1].terminated).toBe(false);
  } finally {
    firstDecoder!.cancel();
    secondDecoder!.cancel();
    await Promise.all([first, second]);
  }
});
