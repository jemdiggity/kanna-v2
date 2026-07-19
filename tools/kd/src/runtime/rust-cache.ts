import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync
} from "node:fs";
import { dirname, join } from "node:path";
import type { CommandRunner } from "./process";
import {
  KANACHE_REPOSITORY,
  KANACHE_REVISION,
  resolveKanachePaths
} from "./rust-cache-policy";

export interface RustCacheEvent {
  timestamp: string;
  repository: string;
  commit: string;
  destination: string;
  donor?: string;
  layouts: string[];
  outcome: "hit" | "miss" | "recorded" | "record-miss";
  category: string;
  wallMs: number;
  allocationDeltaBytes: number;
}

export async function ensureKanacheBinary(input: {
  homeDir: string;
  runner: CommandRunner;
}): Promise<string> {
  const paths = resolveKanachePaths(input.homeDir);
  if (existsSync(paths.binary)) return paths.binary;

  const parent = dirname(paths.versionRoot);
  mkdirSync(parent, { recursive: true });
  const tempRoot = mkdtempSync(join(parent, `.install-${KANACHE_REVISION}-`));

  try {
    const installed = await input.runner.run("cargo", [
      "install",
      "--git",
      KANACHE_REPOSITORY,
      "--rev",
      KANACHE_REVISION,
      "--locked",
      "--root",
      tempRoot
    ]);
    if (installed.exitCode !== 0) {
      throw new Error(installed.stderr.trim() || "cargo install failed");
    }

    const tempBinary = join(tempRoot, "bin", "kanache");
    if (!existsSync(tempBinary)) {
      throw new Error(`cargo install did not create ${tempBinary}`);
    }
    chmodSync(tempBinary, 0o755);
    const verified = await input.runner.run(tempBinary, ["--version"]);
    if (verified.exitCode !== 0 || !verified.stdout.startsWith("kanache 0.1.0")) {
      throw new Error("installed Kanache version check failed");
    }

    try {
      renameSync(tempRoot, paths.versionRoot);
    } catch (error) {
      if (!existsSync(paths.binary)) {
        throw new Error(`failed to publish Kanache at ${paths.versionRoot}`, { cause: error });
      }
    }
    return paths.binary;
  } finally {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

export function appendRustCacheEvent(homeDir: string, event: RustCacheEvent): void {
  const path = resolveKanachePaths(homeDir).events;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch (error) {
    throw new Error(`failed to append Kanache event log at ${path}`, { cause: error });
  }
}

export function readRustCacheEvents(
  homeDir: string,
  repository: string,
  limit: number,
  onWarning: (warning: string) => void = () => {}
): RustCacheEvent[] {
  const path = resolveKanachePaths(homeDir).events;
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`failed to read Kanache event log at ${path}`, { cause: error });
  }

  return raw
    .split("\n")
    .flatMap((line, index) => {
      if (!line) return [];
      try {
        const event = JSON.parse(line) as RustCacheEvent;
        return event.repository === repository ? [event] : [];
      } catch {
        onWarning(`Ignored malformed Kanache event log line ${index + 1}.`);
        return [];
      }
    })
    .slice(-limit);
}
