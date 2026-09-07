import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { processInventoryPath, recordInventoryResource, removeInventoryResource } from "../../../tools/kd/src/runtime/process-inventory";
import { localProcessFetch } from "./localProcessFetch";

export interface ManagedProcess {
  readonly name: string;
  readonly process: ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
}

export interface RunCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  inventoryRoot?: string;
}

export async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

export async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const response = await localProcessFetch(url).catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (response?.ok) {
      return;
    }
    if (response) {
      lastError = `${response.status} ${response.statusText}`;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}${lastError ? ` (${lastError})` : ""}`);
}

export async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const { access } = await import("node:fs/promises");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await access(path).then(() => true).catch(() => false)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

export async function runCommand(command: string, args: string[], options: RunCommandOptions): Promise<void> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "pipe"
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      reject(new Error(`${command} ${args.join(" ")} exited with ${suffix}\n${stderr || stdout}`));
    });
  });
}

export function startManagedProcess(
  name: string,
  command: string,
  args: string[],
  options: RunCommandOptions
): ManagedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "pipe"
  });
  const inventoryPath = processInventoryPath(options.inventoryRoot ?? options.cwd);
  if (child.pid) {
    recordInventoryResource(inventoryPath, { kind: "process", pid: child.pid, label: name });
  }
  child.stdout.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });
  child.once("exit", (code, signal) => {
    if (child.pid) {
      removeInventoryResource(inventoryPath, { kind: "process", pid: child.pid, label: name });
    }
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      process.stderr.write(`[${name}] exited with ${reason}\n`);
    }
  });

  return {
    name,
    process: child,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (child.pid) removeInventoryResource(inventoryPath, { kind: "process", pid: child.pid, label: name });
        return;
      }
      child.kill("SIGTERM");
      const exited = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
        });
      }
      if (child.pid) removeInventoryResource(inventoryPath, { kind: "process", pid: child.pid, label: name });
    }
  };
}
