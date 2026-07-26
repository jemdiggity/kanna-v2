#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeKdIdentity,
  ensureKdInstallation,
  formatKdCacheEvent,
  resolveKdCacheRoot,
  writeKdManifest
} from "./kd-cache.mjs";

const MAX_COMMAND_OUTPUT = 16_000;

function boundedOutput(value) {
  if (!value) {
    return "";
  }
  return value.length <= MAX_COMMAND_OUTPUT
    ? value
    : value.slice(value.length - MAX_COMMAND_OUTPUT);
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [boundedOutput(result.stdout), boundedOutput(result.stderr)]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status}${
        detail ? `\n${detail}` : ""
      }`
    );
  }
  return result;
}

function bootstrapDependencies(kdDir, repoRoot) {
  if (existsSync(join(kdDir, "node_modules"))) {
    return;
  }
  process.stderr.write("Bootstrapping tools/kd dependencies...\n");
  const result = runCaptured("pnpm", ["--dir", kdDir, "install"], {
    cwd: repoRoot,
    env: process.env
  });
  if (result.stdout) {
    process.stderr.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

async function resolveEntrypoint(entrypoint) {
  if (entrypoint !== "kd" && entrypoint !== "kd-mcp") {
    throw new Error(`Usage: kd-resolver.mjs kd|kd-mcp`);
  }

  const binDir = dirname(fileURLToPath(import.meta.url));
  const kdDir = resolve(binDir, "..");
  const repoRoot = resolve(kdDir, "../..");
  bootstrapDependencies(kdDir, repoRoot);

  const { parse } = await import("yaml");
  const lockfile = parse(readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8"));
  const runtime = {
    nodeMajor: process.versions.node.split(".")[0],
    platform: process.platform,
    arch: process.arch
  };
  const identity = await computeKdIdentity({
    repoRoot,
    lockfile,
    runtime
  });
  const cacheRoot = resolveKdCacheRoot({
    platform: process.platform,
    home: homedir(),
    env: process.env
  });

  return ensureKdInstallation({
    cacheRoot,
    identity,
    entrypoint,
    runtime,
    onCacheEvent: (event) => {
      process.stderr.write(`${formatKdCacheEvent(event)}\n`);
    },
    build: async ({ outputDir }) => {
      runCaptured(
        "pnpm",
        ["--dir", kdDir, "exec", "tsup", "--out-dir", outputDir],
        {
          cwd: repoRoot,
          env: process.env
        }
      );
      writeKdManifest(outputDir, identity, runtime);
      for (const path of ["bin/kd.js", "bin/kd-mcp.js"]) {
        runCaptured(process.execPath, ["--check", join(outputDir, path)], {
          cwd: repoRoot,
          env: process.env
        });
      }
    }
  });
}

try {
  const entrypoint = await resolveEntrypoint(process.argv[2]);
  process.stdout.write(`${entrypoint}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kd resolver failed: ${message}\n`);
  process.exitCode = 1;
}
