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

export interface VisibleTerminalTextCell {
  column: number;
  row: number;
  columns: number;
  rows: number;
}

export interface TerminalCursorPosition {
  column: number;
  row: number;
  visible: boolean;
  columns: number;
  rows: number;
}

export interface TerminalCellAttributes {
  bold: boolean;
  inverse: boolean;
  foreground: number;
  foregroundMode: number;
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
    refresh: refreshTerminalBuffer,
    element: getTerminalElement,
    findTextCell: findTerminalTextCell,
    cursor: getTerminalCursorPosition,
    cellAttributes: getTerminalCellAttributes,
    selectText: selectTerminalBufferText,
  };

  return () => {
    const current = terminals.get(sessionId);
    if (current === terminal) {
      terminals.delete(sessionId);
    }
  };
}

function getTerminalElement(sessionId: string): HTMLElement | null {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }
  return terminal.element ?? null;
}

function refreshTerminalBuffer(sessionId: string): void {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }
  const synchronousTerminal = terminal as unknown as {
    _core?: { refresh(start: number, end: number, sync: boolean): void };
  };
  synchronousTerminal._core?.refresh(0, terminal.rows - 1, true);
}

function getTerminalCellAttributes(
  sessionId: string,
  row: number,
  column: number,
): TerminalCellAttributes | null {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }
  const cell = terminal.buffer.active.getLine(row)?.getCell(column);
  return cell
    ? {
        bold: cell.isBold() !== 0,
        inverse: cell.isInverse() !== 0,
        foreground: cell.getFgColor(),
        foregroundMode: cell.getFgColorMode(),
      }
    : null;
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

function findTerminalTextCell(
  sessionId: string,
  text: string,
): VisibleTerminalTextCell | null {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }
  return findVisibleTerminalTextCell(terminal, text);
}

function getTerminalCursorPosition(sessionId: string): TerminalCursorPosition {
  const terminal = terminals.get(sessionId);
  if (!terminal) {
    throw new Error(`terminal buffer not registered for session ${sessionId}`);
  }
  const activeBuffer = terminal.buffer.active;
  return {
    column: activeBuffer.cursorX,
    row: activeBuffer.cursorY,
    // xterm's public buffer API exposes the authoritative cell; cursor
    // visibility is verified separately against the rendered terminal in the
    // real E2E lane (the public Terminal API has no cursorVisible property).
    visible: true,
    columns: terminal.cols,
    rows: terminal.rows,
  };
}

export function findVisibleTerminalTextCell(
  terminal: Terminal,
  text: string,
): VisibleTerminalTextCell | null {
  if (!text) return null;

  const activeBuffer = terminal.buffer.active;
  const firstLine = activeBuffer.viewportY;
  const lastLine = Math.min(activeBuffer.length, firstLine + terminal.rows);
  let match: VisibleTerminalTextCell | null = null;

  for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex += 1) {
    const line = activeBuffer.getLine(lineIndex)?.translateToString(true) ?? "";
    const textColumn = line.indexOf(text);
    if (textColumn < 0) continue;
    match = {
      column: textColumn + Math.floor(text.length / 2),
      row: lineIndex - firstLine,
      columns: terminal.cols,
      rows: terminal.rows,
    };
  }

  return match;
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
