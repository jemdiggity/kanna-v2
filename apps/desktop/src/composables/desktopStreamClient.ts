import { StreamClient } from "@kanna/stream-client";
import { invoke } from "../invoke";
import { resolveCurrentKannaServerBaseUrl, streamUrlFromServerBaseUrl } from "../services/kannaServerBaseUrl";
import { createDesktopStreamFrameDecoder } from "../services/desktopStreamFrameDecoder";

type ConnectionListener = (connected: boolean) => void;

let sharedClient: StreamClient | null = null;
let sharedClientPromise: Promise<StreamClient> | null = null;
const connectionListeners = new Set<ConnectionListener>();

function notifyConnectionListeners(connected: boolean): void {
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

export function resetSharedStreamClientForTests(): void {
  sharedClient?.close();
  sharedClient = null;
  sharedClientPromise = null;
  connectionListeners.clear();
}
