#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_RESOLVER_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 1_000;

function resolverTimeoutMs(env = process.env) {
  const configured = env.KANNA_KD_RESOLVER_TIMEOUT_MS?.trim();
  if (!configured) {
    return DEFAULT_RESOLVER_TIMEOUT_MS;
  }
  const timeoutMs = Number(configured);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `KANNA_KD_RESOLVER_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(
        configured
      )}`
    );
  }
  return timeoutMs;
}

function signalResolverGroup(child, signal) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH" && error?.code !== "EPERM") {
      throw error;
    }
  }
}

async function launchResolver(resolver, entrypoint) {
  const timeoutMs = resolverTimeoutMs();
  const child = spawn(process.execPath, [resolver, entrypoint], {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      KANNA_KD_WRAPPER_PID: String(process.ppid)
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  let timedOut = false;
  let forwardedSignal;
  let forceKillTimeout;
  let resolveForcedExit;
  const forcedExit = new Promise((resolvePromise) => {
    resolveForcedExit = resolvePromise;
  });

  const terminateResolver = (signal) => {
    signalResolverGroup(child, signal);
    forceKillTimeout ??= setTimeout(() => {
      signalResolverGroup(child, "SIGKILL");
      resolveForcedExit({ code: null, signal: "SIGKILL" });
    }, TERMINATION_GRACE_MS);
  };
  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    terminateResolver(signal);
  };
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const forwardTermination = () => forwardSignal("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateResolver("SIGTERM");
  }, timeoutMs);

  let result;
  try {
    result = await Promise.race([
      new Promise((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          resolvePromise({ code, signal });
        });
      }),
      forcedExit
    ]);
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKillTimeout);
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTermination);
  }

  if (timedOut) {
    signalResolverGroup(child, "SIGKILL");
    process.stderr.write(
      `kd resolver timed out after ${timeoutMs}ms while resolving ${entrypoint}; terminated the resolver process group\n`
    );
    return 124;
  }
  if (forwardedSignal) {
    signalResolverGroup(child, "SIGKILL");
    return forwardedSignal === "SIGINT" ? 130 : 143;
  }
  if (result.signal) {
    signalResolverGroup(child, "SIGKILL");
    process.stderr.write(`kd resolver terminated by ${result.signal}\n`);
    return 1;
  }
  if (result.code !== 0) {
    signalResolverGroup(child, "SIGKILL");
  }
  return result.code ?? 1;
}

const [resolver, entrypoint] = process.argv.slice(2);
if (!resolver || (entrypoint !== "kd" && entrypoint !== "kd-mcp")) {
  process.stderr.write("Usage: kd-launcher.mjs <resolver> kd|kd-mcp\n");
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await launchResolver(resolver, entrypoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kd launcher failed: ${message}\n`);
    process.exitCode = 1;
  }
}
