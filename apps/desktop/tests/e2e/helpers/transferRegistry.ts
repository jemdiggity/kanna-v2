import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface TransferRegistryEntry {
  peer_id: string;
  display_name: string;
  endpoint: string;
  pid: number;
  public_key: string;
  protocol_version: number;
  accepting_transfers: boolean;
}

function requiredRegistryDir(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for transfer registry E2E fixtures`);
  return value;
}

function registryEntryPath(registryDir: string, peerId: string): string {
  return join(registryDir, `${Buffer.from(peerId).toString("base64url")}.json`);
}

async function waitForRegistryEntry(
  registryDir: string,
  peerId: string,
  timeoutMs = 10_000,
): Promise<TransferRegistryEntry> {
  const path = registryEntryPath(registryDir, peerId);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const entry = JSON.parse(await readFile(path, "utf8")) as TransferRegistryEntry;
      if (entry.peer_id === peerId) return entry;
      lastError = new Error(`registry entry at ${path} belongs to ${entry.peer_id}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for registry peer ${peerId}: ${String(lastError)}`);
}

async function installRegistryEntry(
  registryDir: string,
  entry: TransferRegistryEntry,
): Promise<() => Promise<void>> {
  await mkdir(registryDir, { recursive: true });
  const path = registryEntryPath(registryDir, entry.peer_id);
  await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return async () => {
    await rm(path, { force: true });
  };
}

function cloudTransferRegistryDirs(): { primary: string; secondary: string } {
  const primary = requiredRegistryDir("KANNA_TRANSFER_REGISTRY_DIR");
  const secondary = requiredRegistryDir("KANNA_E2E_TARGET_TRANSFER_REGISTRY_DIR");
  if (primary === secondary) {
    throw new Error("cloud transfer E2E requires isolated primary and secondary registries");
  }
  return { primary, secondary };
}

export async function exposeRealLanRoutesBetweenInstances(): Promise<() => Promise<void>> {
  const registries = cloudTransferRegistryDirs();
  const [primaryEntry, secondaryEntry] = await Promise.all([
    waitForRegistryEntry(registries.primary, "peer-primary"),
    waitForRegistryEntry(registries.secondary, "peer-secondary"),
  ]);
  const cleanup = await Promise.all([
    installRegistryEntry(registries.primary, secondaryEntry),
    installRegistryEntry(registries.secondary, primaryEntry),
  ]);
  return async () => {
    await Promise.all(cleanup.map((remove) => remove()));
  };
}

export async function exposeUnusablePrimaryLanRouteToSecondary(): Promise<() => Promise<void>> {
  const registries = cloudTransferRegistryDirs();
  const secondaryEntry = await waitForRegistryEntry(registries.secondary, "peer-secondary");
  return installRegistryEntry(registries.primary, {
    ...secondaryEntry,
    // Port zero parses as a socket address but cannot host a listening peer.
    endpoint: "127.0.0.1:0",
  });
}
