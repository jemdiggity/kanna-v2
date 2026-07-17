import type { Terminal } from "@xterm/xterm";

export interface TerminalBufferStats {
  sessionId: string;
  lineCount: number;
  baseY: number;
  viewportY: number;
  matchingLineCount: number;
  firstMatchingLine: string | null;
  lastMatchingLine: string | null;
  hasEndMarker: boolean;
}

const terminals = new Map<string, Terminal>();

export function registerE2ETerminalBuffer(sessionId: string, terminal: Terminal): () => void {
  if (!import.meta.env.DEV || !window.__KANNA_E2E__) return () => {};

  terminals.set(sessionId, terminal);
  window.__KANNA_E2E__.terminalBuffers ??= {
    stats: getTerminalBufferStats,
    lines: getTerminalBufferLines,
    sessionIds: () => Array.from(terminals.keys()),
    write: writeTerminalBuffer,
    input: inputTerminalBuffer,
  };

  return () => {
    const current = terminals.get(sessionId);
    if (current === terminal) {
      terminals.delete(sessionId);
    }
  };
}

function inputTerminalBuffer(sessionId: string, data: string): void {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }
  terminal.input(data, true);
}

function writeTerminalBuffer(sessionId: string, data: string, callback?: () => void): void {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }
  terminal.write(data, callback);
}

function getTerminalBufferLines(sessionId: string): string[] {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }

  const activeBuffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let lineIndex = 0; lineIndex < activeBuffer.length; lineIndex += 1) {
    lines.push(activeBuffer.getLine(lineIndex)?.translateToString(true).trimEnd() ?? "");
  }
  return lines;
}

function getTerminalBufferStats(
  sessionId: string,
  matcher?: RegExp,
  endMarker = "KSCROLLEND",
): TerminalBufferStats {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }

  const activeBuffer = terminal.buffer.active;
  let matchingLineCount = 0;
  let firstMatchingLine: string | null = null;
  let lastMatchingLine: string | null = null;
  let hasEndMarker = false;

  for (let lineIndex = 0; lineIndex < activeBuffer.length; lineIndex += 1) {
    const line = activeBuffer.getLine(lineIndex)?.translateToString(true).trimEnd() ?? "";
    if (line === endMarker) {
      hasEndMarker = true;
    }
    if (matcher?.test(line)) {
      matchingLineCount += 1;
      firstMatchingLine ??= line;
      lastMatchingLine = line;
    }
  }

  return {
    sessionId,
    lineCount: activeBuffer.length,
    baseY: activeBuffer.baseY,
    viewportY: activeBuffer.viewportY,
    matchingLineCount,
    firstMatchingLine,
    lastMatchingLine,
    hasEndMarker,
  };
}
