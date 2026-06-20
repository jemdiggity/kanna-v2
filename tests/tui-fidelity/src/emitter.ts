import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { REPO_ROOT } from "./paths.ts";
import type { EmitterOutput } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface EmitFixtureOptions {
  fixturePath: string;
  cols: number;
  rows: number;
  snapshotAt: number;
}

export async function emitFixtureFrames(options: EmitFixtureOptions): Promise<EmitterOutput> {
  const { stdout } = await execFileAsync(
    "cargo",
    [
      "run",
      "-q",
      "-p",
      "kanna-daemon",
      "--bin",
      "tui-fidelity-emit",
      "--",
      "--cols",
      String(options.cols),
      "--rows",
      String(options.rows),
      "--snapshot-at",
      String(options.snapshotAt),
      "--chunk-pattern",
      "7,1,13,2,31",
      path.resolve(options.fixturePath)
    ],
    {
      cwd: REPO_ROOT,
      maxBuffer: 10 * 1024 * 1024
    }
  );
  return parseEmitterOutput(stdout);
}

function parseEmitterOutput(stdout: string): EmitterOutput {
  const parsed: unknown = JSON.parse(stdout);
  if (!isEmitterOutput(parsed)) {
    throw new Error("tui-fidelity-emit returned an unexpected JSON shape");
  }
  return parsed;
}

function isEmitterOutput(value: unknown): value is EmitterOutput {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fixture === "string" &&
    typeof value.cols === "number" &&
    typeof value.rows === "number" &&
    typeof value.snapshot_at === "number" &&
    typeof value.used_visible_text_fallback === "boolean" &&
    Array.isArray(value.frames) &&
    value.frames.every(isTerminalFrame)
  );
}

function isTerminalFrame(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "term_snapshot") {
    return (
      typeof value.task_id === "string" &&
      typeof value.cols === "number" &&
      typeof value.rows === "number" &&
      typeof value.data_b64 === "string"
    );
  }
  if (value.type === "term_output") {
    return typeof value.task_id === "string" && typeof value.data_b64 === "string";
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
