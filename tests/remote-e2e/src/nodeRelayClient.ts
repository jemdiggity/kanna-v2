import WebSocket, { type RawData } from "ws";
import {
  createRelayDesktopClient,
  type RelayDesktopClient,
  type RelaySocketLike
} from "../../../apps/mobile/src/lib/transports/relayClient";

class NodeRelaySocket implements RelaySocketLike {
  private readonly socket: WebSocket;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("open", () => this.onopen?.());
    this.socket.on("message", (data: RawData) => {
      this.onmessage?.({ data: data.toString() });
    });
    this.socket.on("error", (error) => this.onerror?.(error));
    this.socket.on("close", (code, reason) => {
      this.onclose?.({ code, reason: reason.toString() });
    });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  close(): void {
    this.socket.close();
  }

  send(data: string): void {
    this.socket.send(data);
  }
}

export function createNodeRelayDesktopClient(input: {
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  relayUrl: string;
}): RelayDesktopClient {
  return createRelayDesktopClient({
    createSocket: (url) => new NodeRelaySocket(url),
    getIdToken: input.getIdToken,
    relayUrl: input.relayUrl
  });
}
