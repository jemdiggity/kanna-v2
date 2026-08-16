import { StreamClient } from "@kanna/stream-client";
import { invoke } from "../invoke";
import { resolveCurrentKannaServerBaseUrl, streamUrlFromServerBaseUrl } from "../services/kannaServerBaseUrl";
import { createDesktopStreamFrameDecoder } from "../services/desktopStreamFrameDecoder";

type ConnectionListener = (connected: boolean) => void;

export interface SharedStreamConnectionState {
  connected: boolean;
  revision: number;
}

let sharedClient: StreamClient | null = null;
let sharedClientPromise: Promise<StreamClient> | null = null;
const connectionListeners = new Set<ConnectionListener>();
let sharedConnectionState: SharedStreamConnectionState = {
  connected: false,
  revision: 0,
};

function notifyConnectionListeners(connected: boolean): void {
  if (connected !== sharedConnectionState.connected) {
    sharedConnectionState = {
      connected,
      revision: sharedConnectionState.revision + (connected ? 1 : 0),
    };
  }
  for (const listener of [...connectionListeners]) {
    listener(connected);
  }
}

export async function getSharedStreamClient(): Promise<StreamClient> {
  if (sharedClient) return sharedClient;
  if (sharedClientPromise) return sharedClientPromise;

  sharedClientPromise = (async () => {
    await invoke("ensure_mobile_server");
    const serverBaseUrl = await resolveCurrentKannaServerBaseUrl("creating shared stream client");
    const client = new StreamClient({
      url: streamUrlFromServerBaseUrl(serverBaseUrl),
      onConnectionChange: notifyConnectionListeners,
      frameDecoder: createDesktopStreamFrameDecoder(),
    });
    sharedClient = client;
    return client;
  })().finally(() => {
    sharedClientPromise = null;
  });

  return sharedClientPromise;
}

export function onSharedStreamConnectionChange(listener: ConnectionListener): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

export function getSharedStreamConnectionState(): SharedStreamConnectionState {
  return { ...sharedConnectionState };
}

export function resetSharedStreamClientForTests(): void {
  sharedClient?.close();
  sharedClient = null;
  sharedClientPromise = null;
  connectionListeners.clear();
  sharedConnectionState = {
    connected: false,
    revision: 0,
  };
}
