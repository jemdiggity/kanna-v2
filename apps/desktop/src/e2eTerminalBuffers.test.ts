import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  findVisibleTerminalTextCell,
  selectTerminalText,
} from "./e2eTerminalBuffers";

function terminalWithLines(input: {
  lines: string[];
  viewportY: number;
  rows: number;
  cols?: number;
}): Terminal {
  let selection = "";
  return {
    cols: input.cols ?? 80,
    rows: input.rows,
    buffer: {
      active: {
        length: input.lines.length,
        viewportY: input.viewportY,
        getLine: (index: number) => {
          const line = input.lines[index];
          return line === undefined
            ? undefined
            : { translateToString: () => line };
        },
      },
    },
    getSelection: () => selection,
    select: (column: number, row: number, length: number) => {
      selection = input.lines[row]?.slice(column, column + length) ?? "";
    },
  } as unknown as Terminal;
}

describe("E2E terminal buffer", () => {
  it("locates the midpoint of the last visible matching text in xterm coordinates", () => {
    const uri = "http://companion.test";
    const terminal = terminalWithLines({
      lines: [
        `${uri} offscreen`,
        "older output",
        `prefix ${uri} visible`,
        `${uri} newest`,
        "",
      ],
      viewportY: 1,
      rows: 4,
      cols: 100,
    });

    expect(findVisibleTerminalTextCell(terminal, uri)).toEqual({
      column: Math.floor(uri.length / 2),
      row: 2,
      columns: 100,
      rows: 4,
    });
  });

  it("returns null when matching text exists only outside the viewport", () => {
    const uri = "http://companion.test";
    const terminal = terminalWithLines({
      lines: [`${uri} offscreen`, "one", "two"],
      viewportY: 1,
      rows: 2,
    });

    expect(findVisibleTerminalTextCell(terminal, uri)).toBeNull();
  });

  it("selects the last matching text for a clipboard E2E assertion", () => {
    const marker = "copy this output";
    const terminal = terminalWithLines({
      lines: [marker, "middle", `prefix ${marker} suffix`],
      viewportY: 0,
      rows: 3,
    });

    expect(selectTerminalText(terminal, marker)).toBe(marker);
    expect(selectTerminalText(terminal, "missing")).toBeNull();
  });
});
