import { StreamClient } from "@kanna/stream-client";
import { invoke } from "../invoke";
import { readEnvVarOptional } from "../utils/invokeHelpers";

type ConnectionListener = (connected: boolean) => void;

let sharedClient: StreamClient | null = null;
let sharedClientPromise: Promise<StreamClient> | null = null;
const connectionListeners = new Set<ConnectionListener>();

function streamUrlFromPort(port: unknown): string {
  const resolvedPort = typeof port === "string" && port.trim().length > 0 ? port.trim() : "48120";
  return `ws://127.0.0.1:${resolvedPort}/v1/stream`;
}

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
    const port = await readEnvVarOptional("KANNA_MOBILE_SERVER_PORT");
    const client = new StreamClient({
      url: streamUrlFromPort(port),
      onConnectionChange: notifyConnectionListeners,
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
