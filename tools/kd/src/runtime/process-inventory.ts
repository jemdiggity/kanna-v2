import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandRunner } from "./process";

export interface InventoryProcess {
  kind: "process";
  pid: number;
  label: string;
}

export interface InventoryTmuxServer {
  kind: "tmux-server";
  socket: string;
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

export function recordInventoryResource(path: string, resource: InventoryResource): void {
  const resources = readProcessInventory(path).filter((candidate) => resourceKey(candidate) !== resourceKey(resource));
  resources.push(resource);
  writeInventory(path, resources);
}

export function removeInventoryResource(path: string, resource: InventoryResource): void {
  const resources = readProcessInventory(path).filter((candidate) => resourceKey(candidate) !== resourceKey(resource));
  writeInventory(path, resources);
}

export async function cleanupProcessInventory(
  path: string,
  runner: CommandRunner,
  killProcess: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM")
): Promise<InventoryCleanupResult> {
  const resources = readProcessInventory(path);
  const cleaned: InventoryResource[] = [];
  const failed: InventoryResource[] = [];
  for (const resource of [...resources].reverse()) {
    try {
      if (resource.kind === "process") {
        killProcess(resource.pid);
      } else {
        const result = await runner.run("tmux", ["-L", resource.socket, "kill-server"]);
        // A missing server means the exact recorded resource is already clean.
        if (result.exitCode !== 0 && !/no server running|failed to connect/i.test(result.stderr)) {
          throw new Error(result.stderr);
        }
      }
      cleaned.push(resource);
    } catch (error) {
      // ESRCH is success: the recorded process ended in-band before cleanup.
      if (isNoSuchProcess(error)) cleaned.push(resource);
      else failed.push(resource);
    }
  }
  if (failed.length === 0) rmSync(path, { force: true });
  else writeInventory(path, failed.reverse());
  return { cleaned, failed };
}

function writeInventory(path: string, resources: InventoryResource[]): void {
  if (resources.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  const inventory: ProcessInventory = { version: 1, resources };
  writeFileSync(temp, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function resourceKey(resource: InventoryResource): string {
  return resource.kind === "process" ? `process:${resource.pid}` : `tmux:${resource.socket}`;
}

function isInventoryResource(value: unknown): value is InventoryResource {
  if (!isRecord(value)) return false;
  if (value.kind === "process") {
    return Number.isInteger(value.pid) && Number(value.pid) > 1 && typeof value.label === "string";
  }
  return value.kind === "tmux-server" && typeof value.socket === "string" && value.socket.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNoSuchProcess(error: unknown): boolean {
  return isRecord(error) && error.code === "ESRCH";
}
