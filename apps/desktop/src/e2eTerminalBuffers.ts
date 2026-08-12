import type { Terminal } from "@xterm/xterm";

export interface TerminalBufferStats {
  sessionId: string;
  instanceId: number;
  cols: number;
  rows: number;
  lineCount: number;
  baseY: number;
  viewportY: number;
  matchingLineCount: number;
  firstMatchingLine: string | null;
  lastMatchingLine: string | null;
  hasEndMarker: boolean;
}

const terminals = new Map<string, Terminal>();
const terminalInstanceIds = new WeakMap<Terminal, number>();
let nextTerminalInstanceId = 1;

export function registerE2ETerminalBuffer(sessionId: string, terminal: Terminal): () => void {
  if (!import.meta.env.DEV || !window.__KANNA_E2E__) return () => {};

  terminals.set(sessionId, terminal);
  if (!terminalInstanceIds.has(terminal)) {
    terminalInstanceIds.set(terminal, nextTerminalInstanceId++);
  }
  window.__KANNA_E2E__.terminalBuffers ??= {
    stats: getTerminalBufferStats,
    lines: getTerminalBufferLines,
    sessionIds: () => Array.from(terminals.keys()),
    write: writeTerminalBuffer,
    input: inputTerminalBuffer,
    selectText: selectTerminalBufferText,
  };

  return () => {
    const current = terminals.get(sessionId);
    if (current === terminal) {
      terminals.delete(sessionId);
    }
  };
}

function selectTerminalBufferText(sessionId: string, text: string): string | null {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }
  return selectTerminalText(terminal, text);
}

export function selectTerminalText(terminal: Terminal, text: string): string | null {
  if (!text) return null;

  const activeBuffer = terminal.buffer.active;
  for (let lineIndex = activeBuffer.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const line = activeBuffer.getLine(lineIndex)?.translateToString(true) ?? "";
    const column = line.lastIndexOf(text);
    if (column < 0) continue;
    terminal.select(column, lineIndex, text.length);
    return terminal.getSelection();
  }
  return null;
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
    instanceId: terminalInstanceIds.get(terminal) ?? 0,
    cols: terminal.cols,
    rows: terminal.rows,
    lineCount: activeBuffer.length,
    baseY: activeBuffer.baseY,
    viewportY: activeBuffer.viewportY,
    matchingLineCount,
    firstMatchingLine,
    lastMatchingLine,
    hasEndMarker,
  };
}
