import type {
  StreamFrameDecodeLane,
  StreamFrameDecoder,
} from "@kanna/stream-client";
import type { ServerFrame } from "@kanna/agent-protocol";
import FrameDecoderWorker from "./desktopStreamFrameDecoder.worker?worker";

const MAX_PENDING_DECODE_COUNT = 16;
const MAX_PENDING_DECODE_BYTES = 128 * 1024 * 1024;
const MAX_TRANSFER_PART_BYTES = 256 * 1024;
const MAIN_THREAD_YIELD_BYTES = 1024 * 1024;

interface PendingDecode {
  retainedBytes: number;
  resolve(frame: ServerFrame | null): void;
  reject(error: Error): void;
}

interface TransferredFrameField {
  kind: "html" | "asset_data_b64";
  assetIndex?: number;
  parts: ArrayBuffer[];
}

interface WorkerDecodeResult {
  type?: "result";
  id: number;
  frame: ServerFrame | null;
  fields?: TransferredFrameField[];
}

export function createDesktopStreamFrameDecoder(): StreamFrameDecoder | undefined {
  if (typeof Worker === "undefined") return undefined;

  const workers = new Map<StreamFrameDecodeLane, Worker>();
  let nextId = 1;
  let pendingBytes = 0;
  const pending = new Map<number, PendingDecode>();

  const finishPending = (
    id: number,
    complete: (entry: PendingDecode) => void,
  ) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    pendingBytes = Math.max(0, pendingBytes - entry.retainedBytes);
    complete(entry);
  };

  const resetWorker = (error: Error) => {
    for (const current of workers.values()) current.terminate();
    workers.clear();
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    pendingBytes = 0;
  };

  const createWorker = () => {
    const next = new FrameDecoderWorker();
    next.onmessage = (event: MessageEvent<WorkerDecodeResult>) => {
      const result = event.data;
      if (!pending.has(result.id)) return;
      if (!result.fields || result.fields.length === 0 || !result.frame) {
        finishPending(result.id, (entry) => entry.resolve(result.frame));
        return;
      }
      void hydrateTransferredFrame(result.frame, result.fields).then(
        (frame) => {
          finishPending(result.id, (entry) => entry.resolve(frame));
        },
        () => {
          finishPending(result.id, (entry) => {
            entry.reject(new Error("desktop stream decoder returned an invalid frame"));
          });
        },
      );
    };
    next.onerror = () => {
      resetWorker(new Error("desktop stream decoder worker failed"));
    };
    return next;
  };

  return {
    decode(data, lane = "control") {
      const retainedBytes = data.length * 2;
      if (
        pending.size >= MAX_PENDING_DECODE_COUNT ||
        pendingBytes + retainedBytes > MAX_PENDING_DECODE_BYTES
      ) {
        return Promise.reject(new Error("desktop stream decoder ingress overflow"));
      }
      let worker = workers.get(lane);
      if (!worker) {
        worker = createWorker();
        workers.set(lane, worker);
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { retainedBytes, resolve, reject });
        pendingBytes += retainedBytes;
        try {
          worker.postMessage({ type: "decode", id, data });
        } catch {
          finishPending(id, (entry) => {
            entry.reject(new Error("desktop stream decoder is unavailable"));
          });
        }
      });
    },
    decodeChunks(chunks, lane = "control") {
      const retainedBytes = chunks.reduce(
        (total, chunk) => total + chunk.length * 2,
        0,
      );
      if (
        pending.size >= MAX_PENDING_DECODE_COUNT ||
        pendingBytes + retainedBytes > MAX_PENDING_DECODE_BYTES
      ) {
        return Promise.reject(new Error("desktop stream decoder ingress overflow"));
      }
      let worker = workers.get(lane);
      if (!worker) {
        worker = createWorker();
        workers.set(lane, worker);
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { retainedBytes, resolve, reject });
        pendingBytes += retainedBytes;
        try {
          worker.postMessage({ type: "chunks_start", id });
          void streamChunksToWorker(worker, id, chunks, pending).catch(() => {
            finishPending(id, (entry) => {
              entry.reject(new Error("desktop stream decoder is unavailable"));
            });
          });
        } catch {
          finishPending(id, (entry) => {
            entry.reject(new Error("desktop stream decoder is unavailable"));
          });
        }
      });
    },
    cancel() {
      resetWorker(new Error("desktop stream decoder cancelled"));
    },
  };
}

async function streamChunksToWorker(
  worker: Worker,
  id: number,
  chunks: readonly string[],
  pending: ReadonlyMap<number, PendingDecode>,
): Promise<void> {
  const encoder = new TextEncoder();
  let postedSinceYield = 0;
  for (const chunk of chunks) {
    if (!pending.has(id)) return;
    const encoded = encoder.encode(chunk);
    for (let offset = 0; offset < encoded.byteLength; offset += MAX_TRANSFER_PART_BYTES) {
      if (!pending.has(id)) return;
      const end = Math.min(offset + MAX_TRANSFER_PART_BYTES, encoded.byteLength);
      const bytes = encoded.buffer.slice(
        encoded.byteOffset + offset,
        encoded.byteOffset + end,
      );
      worker.postMessage({ type: "chunk", id, bytes }, [bytes]);
      postedSinceYield += bytes.byteLength;
      if (postedSinceYield >= MAIN_THREAD_YIELD_BYTES) {
        postedSinceYield = 0;
        await yieldMainThread();
      }
    }
  }
  if (pending.has(id)) worker.postMessage({ type: "chunks_end", id });
}

async function hydrateTransferredFrame(
  frame: ServerFrame,
  fields: TransferredFrameField[],
): Promise<ServerFrame> {
  if (frame.type !== "companion_snapshot") {
    throw new Error("large fields require a companion snapshot");
  }
  const assets = Array.isArray(frame.assets)
    ? frame.assets.map((asset) => ({ ...asset }))
    : [];
  let html = frame.html;
  for (const field of fields) {
    const value = await decodeTransferredParts(field.parts);
    if (field.kind === "html") {
      html = value;
      continue;
    }
    if (
      field.kind !== "asset_data_b64"
      || !Number.isSafeInteger(field.assetIndex)
      || field.assetIndex! < 0
      || field.assetIndex! >= assets.length
    ) {
      throw new Error("invalid transferred companion field");
    }
    assets[field.assetIndex!].data_b64 = value;
  }
  return { ...frame, html, assets };
}

async function decodeTransferredParts(parts: ArrayBuffer[]): Promise<string> {
  const decoder = new TextDecoder();
  const decoded: string[] = [];
  let decodedSinceYield = 0;
  for (const part of parts) {
    if (part.byteLength > MAX_TRANSFER_PART_BYTES) {
      throw new Error("oversized transferred frame field");
    }
    decoded.push(decoder.decode(new Uint8Array(part)));
    decodedSinceYield += part.byteLength;
    if (decodedSinceYield >= MAIN_THREAD_YIELD_BYTES) {
      decodedSinceYield = 0;
      await yieldMainThread();
    }
  }
  return decoded.join("");
}

function yieldMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
