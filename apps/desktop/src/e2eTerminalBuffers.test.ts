import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { selectTerminalText } from "./e2eTerminalBuffers";

function terminalWithLines(lines: string[]): Terminal {
  let selection = "";
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine(index: number) {
          return { translateToString: () => lines[index] ?? "" };
        },
      },
    },
    getSelection: () => selection,
    select: (column: number, row: number, length: number) => {
      selection = lines[row]?.slice(column, column + length) ?? "";
    },
  } as unknown as Terminal;
}

describe("E2E terminal buffer selection", () => {
  it("selects the last matching terminal text", () => {
    const marker = "copy this output";
    const terminal = terminalWithLines([marker, "middle", `prefix ${marker} suffix`]);

    expect(selectTerminalText(terminal, marker)).toBe(marker);
    expect(selectTerminalText(terminal, "missing")).toBeNull();
  });
});
