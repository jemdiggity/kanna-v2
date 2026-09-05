import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandRunner } from "./process";

export interface InventoryProcess {
  kind: "process";
  pid: number;
  label: string;
  /** Kernel process start identity. A PID alone is unsafe after PID reuse. */
  identity?: string;
}

export interface InventoryTmuxServer {
  kind: "tmux-server";
  socket: string;
  socketPath?: string;
}

export type InventoryResource = InventoryProcess | InventoryTmuxServer;

interface ProcessInventory {
  version: 1;
  resources: InventoryResource[];
}

export interface InventoryCleanupResult {
  cleaned: InventoryResource[];
  failed: InventoryResource[];
}

export interface ProcessCleanupOperations {
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  identity?: (pid: number) => string | undefined;
  graceMs?: number;
  pollMs?: number;
}

export function processInventoryPath(repoRoot: string): string {
  return join(repoRoot, ".kanna", "kd-state", "process-inventory.json");
}

export function readProcessInventory(path: string): InventoryResource[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.resources)) return [];
    return parsed.resources.filter(isInventoryResource);
  } catch {
    return [];
  }
}

export function processIdentity(pid: number): string | undefined {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function recordInventoryResource(path: string, resource: InventoryResource): InventoryResource {
  const stamped = resource.kind === "process"
    ? { ...resource, identity: resource.identity ?? processIdentity(resource.pid) }
    : resource;
  mutateInventory(path, (resources) => [
    ...resources.filter((candidate) => resourceKey(candidate) !== resourceKey(stamped)),
    stamped
  ]);
  return stamped;
}

export function removeInventoryResource(path: string, resource: InventoryResource): void {
  if (!existsSync(path) && !existsSync(`${path}.lock`)) return;
  mutateInventory(path, (resources) =>
    resources.filter((candidate) => !sameResource(candidate, resource))
  );
}

export async function terminateInventoryProcess(
  resource: InventoryProcess,
  operations: ProcessCleanupOperations = {}
): Promise<"cleaned" | "identity-mismatch" | "failed"> {
  const identity = operations.identity ?? processIdentity;
  const signal = operations.signal ?? ((pid, kind) => process.kill(pid, kind));
  if (!resource.identity || identity(resource.pid) !== resource.identity) {
    // Missing/mismatched identity is stale ownership, not authority to signal.
    return "identity-mismatch";
  }
  try {
    signal(resource.pid, "SIGTERM");
  } catch (error) {
    return isNoSuchProcess(error) ? "cleaned" : "failed";
  }
  if (await waitForIdentityToDisappear(resource, identity, operations.graceMs ?? 2_000, operations.pollMs ?? 50)) {
    return "cleaned";
  }
  // Revalidate immediately before escalation so PID reuse can never receive SIGKILL.
  if (identity(resource.pid) !== resource.identity) return "cleaned";
  try {
    signal(resource.pid, "SIGKILL");
  } catch (error) {
    return isNoSuchProcess(error) ? "cleaned" : "failed";
  }
  return await waitForIdentityToDisappear(resource, identity, operations.graceMs ?? 2_000, operations.pollMs ?? 50)
    ? "cleaned"
    : "failed";
}

export async function cleanupProcessInventory(
  path: string,
  runner: CommandRunner,
  operations: ProcessCleanupOperations | ((pid: number) => void) = {}
): Promise<InventoryCleanupResult> {
  const normalized: ProcessCleanupOperations = typeof operations === "function"
    ? { signal: (pid) => operations(pid), identity: (pid) => readProcessInventory(path).find(
        (resource): resource is InventoryProcess => resource.kind === "process" && resource.pid === pid
      )?.identity }
    : operations;
  const resources = readProcessInventory(path);
  const cleaned: InventoryResource[] = [];
  const failed: InventoryResource[] = [];
  if (resources.length === 0) return { cleaned, failed };
  const cleanupOrder = [...resources].reverse().sort((left, right) =>
    Number(isRecoverySidecar(left)) - Number(isRecoverySidecar(right))
  );
  for (const resource of cleanupOrder) {
    if (resource.kind === "process") {
      const outcome = await terminateInventoryProcess(resource, normalized);
      (outcome === "failed" ? failed : cleaned).push(resource);
      continue;
    }
    try {
      const result = await runner.run("tmux", ["-L", resource.socket, "kill-server"]);
      if (result.exitCode !== 0 && !/no server running|failed to connect/i.test(result.stderr)) {
        throw new Error(result.stderr);
      }
      if (resource.socketPath) rmSync(resource.socketPath, { force: true });
      cleaned.push(resource);
    } catch {
      failed.push(resource);
    }
  }
  mutateInventory(path, (current) => {
    return current.filter((resource) =>
      !resources.some((attempted) => sameResource(resource, attempted)) ||
      failed.some((failure) => sameResource(resource, failure))
    );
  });
  return { cleaned, failed };
}

function isRecoverySidecar(resource: InventoryResource): boolean {
  return resource.kind === "process" && resource.label === "kanna-terminal-recovery";
}

async function waitForIdentityToDisappear(
  resource: InventoryProcess,
  identity: (pid: number) => string | undefined,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (identity(resource.pid) !== resource.identity) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

function mutateInventory(path: string, mutation: (resources: InventoryResource[]) => InventoryResource[]): void {
  const lock = `${path}.lock`;
  const ownerName = `owner-${process.pid}-${Math.random().toString(16).slice(2)}.json`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    const candidate = `${lock}.pending-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      mkdirSync(candidate);
      const owner = JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) });
      writeFileSync(join(candidate, ownerName), owner);
      // Keep metadata readable by an older desktop/daemon during an upgrade.
      writeFileSync(join(candidate, "owner.json"), owner);
      const publishDelay = Number(process.env.KANNA_TEST_INVENTORY_LOCK_PUBLISH_DELAY_MS ?? 0);
      if (publishDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, publishDelay);
      renameSync(candidate, lock);
      break;
    } catch (error) {
      rmSync(candidate, { recursive: true, force: true });
      if (!isAlreadyExists(error) || Date.now() >= deadline) throw error;
      const abandonedOwner = abandonedLockOwner(lock);
      if (abandonedOwner) removeLockOwner(lock, abandonedOwner);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    writeInventory(path, mutation(readProcessInventory(path)));
  } finally {
    removeLockOwner(lock, join(lock, ownerName));
  }
}

function removeLockOwner(lock: string, ownerPath: string): void {
  // Never rename/remove the lock directory based on a stale ownership read.
  // Only this generation's unique marker may be unlinked. rmdir is atomic
  // and refuses a replacement generation, whose marker makes it nonempty.
  try {
    unlinkSync(ownerPath);
    if (ownerPath !== join(lock, "owner.json")) rmSync(join(lock, "owner.json"), { force: true });
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  try {
    rmdirSync(lock);
  } catch (error) {
    if (!isRecord(error) || !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))) throw error;
  }
}

function abandonedLockOwner(lock: string): string | undefined {
  let ownerPath: string;
  try {
    const entries = readdirSync(lock);
    const marker = entries.find((entry) => entry.startsWith("owner-") && entry.endsWith(".json"));
    if (!marker && !entries.includes("owner.json")) return undefined;
    ownerPath = join(lock, marker ?? "owner.json");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const owner: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (!isRecord(owner) || !Number.isInteger(owner.pid) || typeof owner.identity !== "string") return undefined;
    return processIdentity(Number(owner.pid)) !== owner.identity ? ownerPath : undefined;
  } catch {
    // Retain legacy damaged-metadata recovery, but remove only the exact
    // marker inspected, never a subsequently published directory.
    try {
      return Date.now() - statSync(ownerPath).mtimeMs >= 1_000 ? ownerPath : undefined;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function writeInventory(path: string, resources: InventoryResource[]): void {
  if (resources.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const inventory: ProcessInventory = { version: 1, resources };
  writeFileSync(temp, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function resourceKey(resource: InventoryResource): string {
  return resource.kind === "process" ? `process:${resource.pid}` : `tmux:${resource.socket}`;
}

function sameResource(left: InventoryResource, right: InventoryResource): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "process" && right.kind === "process") {
    return left.pid === right.pid && left.label === right.label && left.identity === right.identity;
  }
  return left.kind === "tmux-server" && right.kind === "tmux-server" &&
    left.socket === right.socket && left.socketPath === right.socketPath;
}

function isInventoryResource(value: unknown): value is InventoryResource {
  if (!isRecord(value)) return false;
  if (value.kind === "process") {
    return Number.isInteger(value.pid) && Number(value.pid) > 1 && typeof value.label === "string" &&
      (value.identity === undefined || typeof value.identity === "string");
  }
  return value.kind === "tmux-server" && typeof value.socket === "string" && value.socket.length > 0 &&
    (value.socketPath === undefined || typeof value.socketPath === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNoSuchProcess(error: unknown): boolean {
  return isRecord(error) && error.code === "ESRCH";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}
