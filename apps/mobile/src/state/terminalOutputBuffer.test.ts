import { describe, expect, it, vi } from "vitest";
import {
  appendTerminalOutput,
  createTerminalOutput,
  MAX_TERMINAL_LIVE_OUTPUT_CHARS,
  sliceTerminalOutput,
  TERMINAL_OUTPUT_SEGMENT_TARGET_CHARS,
  terminalOutputToString
} from "./terminalOutputBuffer";

describe("terminalOutputBuffer", () => {
  it("appends from the logical cursor without rebuilding retained history", () => {
    const snapshot = `${"S".repeat(750_000)}\n`;
    let output = createTerminalOutput(snapshot);
    const frame = `${"F".repeat(4_095)}\n`;

    for (let index = 0; index < 20; index += 1) {
      output = appendTerminalOutput(output, frame).output;
    }
    const completedSegment = output.liveSegments[0];
    const previousLength = output.length;

    const appended = appendTerminalOutput(output, "dGFpbA==\n").output;

    expect(appended.snapshot).toBe(snapshot);
    expect(appended.liveSegments[0]).toBe(completedSegment);
    expect(sliceTerminalOutput(appended, previousLength)).toBe("dGFpbA==\n");
    expect(
      appended.liveSegments.every(
        (segment) => segment.length <= TERMINAL_OUTPUT_SEGMENT_TARGET_CHARS
      )
    ).toBe(true);
  });

  it("bounds per-frame string scanning independently of retained history", () => {
    const snapshot = `${"A".repeat(750_000)}\n`;
    let output = createTerminalOutput(snapshot);
    const scannedLengths: number[] = [];
    const nativeIndexOf = String.prototype.indexOf;
    const boundedSpy = vi
      .spyOn(String.prototype, "indexOf")
      .mockImplementation(function boundedIndexOf(
        this: string,
        searchString: string,
        position?: number
      ) {
        scannedLengths.push(String(this).length);
        return nativeIndexOf.call(this, searchString, position);
      });

    for (let index = 0; index < 10_000; index += 1) {
      output = appendTerminalOutput(
        output,
        `${String(index).padStart(8, "0")}_${"X".repeat(119)}\n`
      ).output;
    }
    boundedSpy.mockRestore();

    expect(Math.max(...scannedLengths)).toBeLessThanOrEqual(
      TERMINAL_OUTPUT_SEGMENT_TARGET_CHARS
    );
    expect(output.snapshot).toBe(snapshot);
    expect(output.liveLength).toBeLessThanOrEqual(
      MAX_TERMINAL_LIVE_OUTPUT_CHARS
    );
  });

  it("evicts complete live frames while preserving snapshot and cursor math", () => {
    const snapshot = "c25hcHNob3Q=\n";
    let output = createTerminalOutput(snapshot);
    let droppedChars = 0;
    const frames = ["B", "C", "D", "E"].map(
      (value) => `${value.repeat(300_000)}\n`
    );

    for (const frame of frames) {
      const appended = appendTerminalOutput(output, frame);
      output = appended.output;
      droppedChars += appended.droppedChars;
    }

    expect(terminalOutputToString(output)).toBe(
      `${snapshot}${frames.slice(-3).join("")}`
    );
    expect(droppedChars).toBe(frames[0].length);
  });
});
