import type { ServerFrame } from "@kanna/agent-protocol";

const MAX_PENDING_ASSEMBLIES = 16;
const MAX_ASSEMBLY_BYTES = 64 * 1024 * 1024;
const MAX_TRANSFER_PART_BYTES = 256 * 1024;

interface ChunkAssembly {
  bytes: number;
  chunks: Uint8Array[];
}

export type FrameDecoderWorkerRequest =
  | { type: "decode"; id: number; data: string }
  | { type: "chunks_start"; id: number }
  | { type: "chunk"; id: number; bytes: ArrayBuffer }
  | { type: "chunks_end"; id: number };

interface TransferredFrameField {
  kind: "html" | "asset_data_b64";
  assetIndex?: number;
  parts: ArrayBuffer[];
}

type PostWorkerMessage = (
  message: unknown,
  transfer?: Transferable[],
) => void;

export function createFrameDecoderWorkerHandler(
  postMessage: PostWorkerMessage,
): (message: FrameDecoderWorkerRequest) => void {
  const assemblies = new Map<number, ChunkAssembly>();
  let retainedAssemblyBytes = 0;

  const removeAssembly = (id: number): ChunkAssembly | undefined => {
    const assembly = assemblies.get(id);
    if (!assembly) return undefined;
    assemblies.delete(id);
    retainedAssemblyBytes = Math.max(
      0,
      retainedAssemblyBytes - assembly.bytes,
    );
    return assembly;
  };

  const postParsedFrame = (id: number, frame: ServerFrame): void => {
    if (frame.type !== "companion_snapshot") {
      postMessage({ type: "result", id, frame });
      return;
    }
    const fields: TransferredFrameField[] = [{
      kind: "html",
      parts: encodeTransferParts(frame.html),
    }];
    const assets = Array.isArray(frame.assets)
      ? frame.assets.map((asset, assetIndex) => {
          fields.push({
            kind: "asset_data_b64",
            assetIndex,
            parts: encodeTransferParts(asset.data_b64),
          });
          return { ...asset, data_b64: "" };
        })
      : [];
    const transferable = fields.flatMap((field) => field.parts);
    postMessage({
      type: "result",
      id,
      frame: { ...frame, html: "", assets },
      fields,
    }, transferable);
  };

  return (message) => {
    try {
      switch (message.type) {
        case "decode":
          postParsedFrame(message.id, JSON.parse(message.data) as ServerFrame);
          return;
        case "chunks_start":
          if (
            assemblies.has(message.id)
            || assemblies.size >= MAX_PENDING_ASSEMBLIES
          ) {
            throw new Error("decoder assembly admission overflow");
          }
          assemblies.set(message.id, { bytes: 0, chunks: [] });
          return;
        case "chunk": {
          const assembly = assemblies.get(message.id);
          if (
            !assembly
            || !(message.bytes instanceof ArrayBuffer)
            || message.bytes.byteLength === 0
            || message.bytes.byteLength > MAX_TRANSFER_PART_BYTES
            || assembly.bytes + message.bytes.byteLength > MAX_ASSEMBLY_BYTES
            || retainedAssemblyBytes + message.bytes.byteLength
              > MAX_ASSEMBLY_BYTES
          ) {
            throw new Error("invalid decoder chunk");
          }
          assembly.bytes += message.bytes.byteLength;
          retainedAssemblyBytes += message.bytes.byteLength;
          assembly.chunks.push(new Uint8Array(message.bytes));
          return;
        }
        case "chunks_end": {
          const assembly = removeAssembly(message.id);
          if (!assembly) throw new Error("missing decoder assembly");
          const decoder = new TextDecoder();
          const serialized = assembly.chunks
            .map((chunk, index) =>
              decoder.decode(chunk, {
                stream: index + 1 < assembly.chunks.length,
              })
            )
            .join("");
          postParsedFrame(
            message.id,
            JSON.parse(serialized) as ServerFrame,
          );
          return;
        }
      }
    } catch {
      removeAssembly(message.id);
      postMessage({ type: "result", id: message.id, frame: null });
    }
  };
}

function encodeTransferParts(value: string): ArrayBuffer[] {
  const encoder = new TextEncoder();
  const parts: ArrayBuffer[] = [];
  const maximumCodeUnits = Math.floor(MAX_TRANSFER_PART_BYTES / 4);
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + maximumCodeUnits, value.length);
    if (
      end < value.length
      && end > offset
      && isHighSurrogate(value.charCodeAt(end - 1))
      && isLowSurrogate(value.charCodeAt(end))
    ) {
      end -= 1;
    }
    const encoded = encoder.encode(value.slice(offset, end));
    for (
      let byteOffset = 0;
      byteOffset < encoded.byteLength;
      byteOffset += MAX_TRANSFER_PART_BYTES
    ) {
      const byteEnd = Math.min(
        byteOffset + MAX_TRANSFER_PART_BYTES,
        encoded.byteLength,
      );
      parts.push(encoded.buffer.slice(
        encoded.byteOffset + byteOffset,
        encoded.byteOffset + byteEnd,
      ));
    }
    offset = end;
  }
  return parts;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
