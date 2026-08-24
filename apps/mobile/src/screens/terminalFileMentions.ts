import type { TaskFileMentionResolution } from "../lib/api/types";

export const MAX_TERMINAL_FILE_MENTIONS = 20;
export const MAX_TERMINAL_FILE_MENTION_PAYLOAD = 21;
const MAX_TERMINAL_FILE_MENTION_STRING_BYTES = 4 * 1024;

const TERMINAL_FILE_TOKEN_PATTERN =
  /^((?:\/)?[a-zA-Z0-9_.-][\w.\-/]*\.[a-zA-Z][a-zA-Z0-9]*)(?::(\d+))?(?::(\d+))?$/;
const UNSUPPORTED_IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "jpg",
  "jpeg",
  "png",
  "svg",
  "webp"
]);

export interface TerminalFileMention {
  raw: string;
  path: string;
  line?: number;
}

export interface TerminalFileMentionHistory {
  mentions: TerminalFileMention[];
  overflow: boolean;
}

export interface ResolvedMentionRow {
  path: string;
  mentionPath: string;
  line?: number;
  available: boolean;
  unavailableReason?: string;
}

export interface ResolvedMentionProjection {
  rows: ResolvedMentionRow[];
  unmatchedCount: number;
  truncated: boolean;
}

export function parseTerminalFileMentionRaw(
  raw: string
): { path: string; line?: number } | null {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    byteLength(raw) > MAX_TERMINAL_FILE_MENTION_STRING_BYTES
  ) {
    return null;
  }
  const match = TERMINAL_FILE_TOKEN_PATTERN.exec(raw);
  if (!match) {
    return null;
  }
  const path = match[1]!;
  if (
    byteLength(path) > MAX_TERMINAL_FILE_MENTION_STRING_BYTES ||
    path.split("/").includes("..")
  ) {
    return null;
  }
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (UNSUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return null;
  }

  const line = parsePositiveInteger(match[2]);
  const column = parsePositiveInteger(match[3]);
  if (
    (match[2] !== undefined && line === null) ||
    (match[3] !== undefined && column === null)
  ) {
    return null;
  }
  return line === null ? { path } : { path, line };
}

export function parseTerminalFileMentionHistory(
  payload: unknown
): TerminalFileMentionHistory | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    payload.type !== "terminal-file-mentions" ||
    typeof payload.overflow !== "boolean" ||
    !Array.isArray(payload.mentions) ||
    payload.mentions.length > MAX_TERMINAL_FILE_MENTION_PAYLOAD
  ) {
    return null;
  }

  const mentions: TerminalFileMention[] = [];
  for (const candidate of payload.mentions) {
    const parsed = parseHistoryRecord(candidate);
    if (parsed) {
      mentions.push(parsed);
    }
  }
  const overflow =
    payload.overflow || mentions.length > MAX_TERMINAL_FILE_MENTIONS;
  return {
    mentions: mentions.slice(0, MAX_TERMINAL_FILE_MENTIONS),
    overflow
  };
}

export function mentionedFilesActionLabel(
  history: TerminalFileMentionHistory
): string {
  const suffix = history.overflow ? "+" : "";
  return `Mentioned Files (${history.mentions.length}${suffix})`;
}

export function projectResolvedMentionRows(
  history: TerminalFileMentionHistory,
  resolution: TaskFileMentionResolution
): ResolvedMentionProjection {
  const rows: ResolvedMentionRow[] = [];
  const seenCanonicalPaths = new Set<string>();
  let unmatchedCount = 0;
  let truncated = history.overflow;

  for (let index = 0; index < history.mentions.length; index += 1) {
    const mention = history.mentions[index]!;
    const resolved = resolution.mentions[index];
    if (!resolved || resolved.path !== mention.path) {
      unmatchedCount += 1;
      continue;
    }
    truncated ||= resolved.truncated;
    const matches = resolved.matches
      .filter(
        (match) =>
          typeof match.path === "string" &&
          match.path.trim().length > 0 &&
          !match.path.split("/").includes("..")
      )
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path));
    if (matches.length === 0) {
      rows.push({
        path: mention.path,
        mentionPath: mention.path,
        ...(mention.line === undefined ? {} : { line: mention.line }),
        available: false,
        unavailableReason:
          typeof resolved.unavailableReason === "string" &&
          resolved.unavailableReason.trim().length > 0
            ? resolved.unavailableReason
            : "file not found"
      });
      continue;
    }
    for (const match of matches) {
      if (seenCanonicalPaths.has(match.path)) {
        continue;
      }
      seenCanonicalPaths.add(match.path);
      rows.push({
        path: match.path,
        mentionPath: mention.path,
        available: true,
        ...(mention.line === undefined ? {} : { line: mention.line })
      });
    }
  }

  return { rows, unmatchedCount, truncated };
}

function parseHistoryRecord(candidate: unknown): TerminalFileMention | null {
  if (
    !isRecord(candidate) ||
    typeof candidate.raw !== "string" ||
    typeof candidate.path !== "string"
  ) {
    return null;
  }
  const parsed = parseTerminalFileMentionRaw(candidate.raw);
  if (!parsed || parsed.path !== candidate.path) {
    return null;
  }
  const suppliedLine = candidate.line;
  if (
    suppliedLine !== undefined &&
    (!Number.isSafeInteger(suppliedLine) || (suppliedLine as number) <= 0)
  ) {
    return null;
  }
  if (parsed.line !== suppliedLine) {
    return null;
  }
  return {
    raw: candidate.raw,
    path: candidate.path,
    ...(parsed.line === undefined ? {} : { line: parsed.line })
  };
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
