import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { findClaudeBinary } from "./claude";
import { findCodexBinary } from "./codex";
import { findOpenCodeBinary } from "./opencode";

/**
 * "Is this CLI installed?" resolvers. A missing or unauthenticated CLI must
 * skip the pin, never fail it — the suite runs on developer machines where not
 * every provider is installed, and a red suite that means "codex isn't here"
 * teaches everyone to ignore it.
 */

async function resolve(finder: () => Promise<string>): Promise<string | null> {
  try {
    const binary = await finder();
    // findCodexBinary falls back to the bare name "codex" when `command -v`
    // finds nothing; treat that as absent rather than letting the spawn fail.
    if (!binary.startsWith("/")) return null;
    await access(binary, constants.X_OK);
    return binary;
  } catch {
    return null;
  }
}

export function claudeBinaryOrNull(): Promise<string | null> {
  return resolve(findClaudeBinary);
}

export function codexBinaryOrNull(): Promise<string | null> {
  return resolve(findCodexBinary);
}

export function openCodeBinaryOrNull(): Promise<string | null> {
  return resolve(findOpenCodeBinary);
}

/** The PTY tests need system python3 to host the terminal (see helpers/pty.ts). */
export async function ptyBridgeAvailable(): Promise<boolean> {
  try {
    await access("/usr/bin/python3", constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
