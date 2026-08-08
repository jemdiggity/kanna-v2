import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  attachDesktopTunnel,
  forwardTunnelData,
  routeMessage,
  setPhoneConnection,
  setServerConnection,
} from "../src/router.js";

const MIB = 1024 * 1024;
const MAX_TUNNEL_BUFFERED_BYTES = 64 * MIB;
const TUNNEL_BACKPRESSURE_HIGH_WATER_BYTES = 32 * MIB;
const TUNNEL_BACKPRESSURE_LOW_WATER_BYTES = 16 * MIB;
const MAX_TUNNEL_COMPANION_FRAME_BYTES = 256 * 1024;

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<{
    data: unknown;
    options: unknown;
    callback?: (error?: Error) => void;
  }> = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  pauseCalls = 0;
  resumeCalls = 0;

  send(
    data: unknown,
    options?: unknown,
    callback?: (error?: Error) => void,
  ): void {
    if (typeof options === "function") {
      callback = options as (error?: Error) => void;
      options = undefined;
    }
    this.sent.push({ data, options, callback });
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close");
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  resume(): void {
    this.resumeCalls += 1;
  }
}

let nextUser = 1;

function connectedTunnel(): {
  source: FakeSocket;
  peer: FakeSocket;
} {
  const userId = `router-flow-${nextUser++}`;
  const source = new FakeSocket();
  const control = new FakeSocket();
  setPhoneConnection(userId, source as unknown as WebSocket);
  setServerConnection(userId, "desktop-1", control as unknown as WebSocket);
  routeMessage(
    userId,
    "phone",
    JSON.stringify({
      type: "tunnel_request",
      id: "open",
      desktopId: "desktop-1",
    }),
    source as unknown as WebSocket,
  );
  const establish = JSON.parse(
    String(control.sent.at(-1)?.data),
  ) as { tunnelId: string };
  const peer = new FakeSocket();
  expect(
    attachDesktopTunnel(
      userId,
      "desktop-1",
      establish.tunnelId,
      peer as unknown as WebSocket,
    ),
  ).toBe(true);
  source.sent.length = 0;
  peer.sent.length = 0;
  return { source, peer };
}

describe("relay tunnel flow control", () => {
  it("forwards a text RawData buffer without making a complete-frame string copy", () => {
    const { source, peer } = connectedTunnel();
    const payload = Buffer.from('{"type":"companion_snapshot"}');

    forwardTunnelData(
      source as unknown as WebSocket,
      payload,
      false,
    );

    expect(peer.sent).toHaveLength(1);
    expect(peer.sent[0]?.data).toBe(payload);
    expect(peer.sent[0]?.options).toEqual({ binary: false });
  });

  it("fails both tunnel peers before an enqueue can exceed the absolute cap", () => {
    const { source, peer } = connectedTunnel();
    peer.bufferedAmount = MAX_TUNNEL_BUFFERED_BYTES - 2;

    forwardTunnelData(
      source as unknown as WebSocket,
      Buffer.from("abc"),
      false,
    );

    expect(peer.sent).toHaveLength(0);
    expect(source.closeCalls.at(-1)).toMatchObject({ code: 1013 });
    expect(peer.closeCalls.at(-1)).toMatchObject({ code: 1013 });
  });

  it("forwards a legal maximum legacy companion snapshot during mixed-version rollout", () => {
    const { source, peer } = connectedTunnel();
    const prefix = Buffer.from('{"type":"companion_snapshot","task_id":"task-max","html":"');
    const payload = Buffer.concat([
      prefix,
      Buffer.alloc(23 * MIB - prefix.length - 2, "x"),
      Buffer.from('"}'),
    ]);

    forwardTunnelData(
      source as unknown as WebSocket,
      payload,
      false,
    );

    expect(peer.sent).toHaveLength(1);
    expect(peer.sent[0]?.data).toBe(payload);
    expect(source.closeCalls).toEqual([]);
    expect(peer.closeCalls).toEqual([]);
  });

  it("forwards a maximum chunked bundle around terminal traffic without waiting for the slow sink", () => {
    const { source, peer } = connectedTunnel();
    const chunkData = "x".repeat(96 * 1024);
    const chunkCount = Math.ceil((23 * MIB) / chunkData.length);
    const chunk = (index: number) => Buffer.from(JSON.stringify({
      type: "companion_snapshot_chunk",
      task_id: "task-max",
      transfer_id: "session-max:revision-max",
      index,
      count: chunkCount,
      data: chunkData,
    }));

    forwardTunnelData(source as unknown as WebSocket, chunk(0), false);
    const terminal = Buffer.from(
      '{"type":"term_output","task_id":"task-max","data_b64":"b2s="}',
    );
    forwardTunnelData(source as unknown as WebSocket, terminal, false);
    for (let index = 1; index < chunkCount; index += 1) {
      forwardTunnelData(source as unknown as WebSocket, chunk(index), false);
    }

    expect(peer.sent[1]?.data).toBe(terminal);
    expect(peer.sent).toHaveLength(chunkCount + 1);
    expect(peer.sent.every(({ data }) =>
      Buffer.byteLength(data as Uint8Array) <= MAX_TUNNEL_COMPANION_FRAME_BYTES
    )).toBe(true);
    expect(
      peer.sent.every(({ callback }) => typeof callback === "function"),
    ).toBe(true);
  });

  it("pauses the source above the high-water mark and resumes below low water", () => {
    const { source, peer } = connectedTunnel();
    peer.bufferedAmount = TUNNEL_BACKPRESSURE_HIGH_WATER_BYTES;

    forwardTunnelData(
      source as unknown as WebSocket,
      Buffer.from("flow-controlled"),
      false,
    );

    expect(source.pauseCalls).toBe(1);
    expect(source.resumeCalls).toBe(0);
    peer.bufferedAmount = TUNNEL_BACKPRESSURE_LOW_WATER_BYTES;
    peer.sent[0]?.callback?.();
    expect(source.resumeCalls).toBe(1);
  });

  it("fails both tunnel peers when the queued send reports an error", () => {
    const { source, peer } = connectedTunnel();

    forwardTunnelData(
      source as unknown as WebSocket,
      Buffer.from("send-error"),
      false,
    );
    peer.sent[0]?.callback?.(new Error("socket write failed"));

    expect(source.closeCalls.at(-1)).toMatchObject({ code: 1011 });
    expect(peer.closeCalls.at(-1)).toMatchObject({ code: 1011 });
  });
});
