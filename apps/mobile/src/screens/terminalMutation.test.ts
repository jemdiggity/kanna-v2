import { describe, expect, it } from "vitest";
import { planTerminalMutation } from "./terminalMutation";

describe("planTerminalMutation", () => {
  it("replaces the terminal contents when the first output arrives", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 1,
        previousOutput: "",
        previousStart: 0,
        previousStatus: "connecting",
        nextEpoch: 1,
        nextOutput: "Claude Code is starting\n",
        nextStart: 0,
        nextStatus: "live"
      })
    ).toEqual({
      kind: "replace",
      output: "Claude Code is starting\n",
      status: "live"
    });
  });

  it("appends only the new chunk when output grows", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 1,
        previousOutput: "First line\n",
        previousStart: 0,
        previousStatus: "live",
        nextEpoch: 1,
        nextOutput: "First line\nSecond line\n",
        nextStart: 0,
        nextStatus: "live"
      })
    ).toEqual({
      kind: "append",
      chunk: "Second line\n"
    });
  });

  it("appends from the logical stream end after the retained prefix is compacted", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 7,
        previousOutput: "A\nB\n",
        previousStart: 0,
        previousStatus: "live",
        nextEpoch: 7,
        nextOutput: "B\nC\n",
        nextStart: 2,
        nextStatus: "live"
      })
    ).toEqual({
      kind: "append",
      chunk: "C\n"
    });
  });

  it("appends every unseen frame when React coalesces store publications", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 3,
        previousOutput: "A\nB\n",
        previousStart: 0,
        previousStatus: "live",
        nextEpoch: 3,
        nextOutput: "C\nD\nE\n",
        nextStart: 4,
        nextStatus: "live"
      })
    ).toEqual({ kind: "append", chunk: "C\nD\nE\n" });
  });

  it("replaces once when an authoritative snapshot starts a new epoch", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 4,
        previousOutput: "old\n",
        previousStart: 100,
        previousStatus: "live",
        nextEpoch: 5,
        nextOutput: "snapshot\n",
        nextStart: 0,
        nextStatus: "live"
      })
    ).toEqual({ kind: "replace", output: "snapshot\n", status: "live" });
  });

  it("prepends when the new epoch spliced older scrollback above the buffer", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 5,
        previousOutput: "window\n",
        previousStart: 0,
        previousStatus: "live",
        nextEpoch: 6,
        nextOutput: "older\nwindow\n",
        nextStart: 0,
        nextStatus: "live",
        nextPrependedScrollback: true
      })
    ).toEqual({ kind: "prepend", output: "older\nwindow\n", status: "live" });
  });

  it("uses the safe replacement path when compaction creates a genuine gap", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 2,
        previousOutput: "A\n",
        previousStart: 0,
        previousStatus: "live",
        nextEpoch: 2,
        nextOutput: "C\nD\n",
        nextStart: 4,
        nextStatus: "live"
      })
    ).toEqual({ kind: "replace", output: "C\nD\n", status: "live" });
  });

  it("replaces status copy when there is no terminal output", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 1,
        previousOutput: "",
        previousStart: 0,
        previousStatus: "connecting",
        nextEpoch: 1,
        nextOutput: "",
        nextStart: 0,
        nextStatus: "idle"
      })
    ).toEqual({
      kind: "replace",
      output: "",
      status: "idle"
    });
  });

  it("does nothing when neither the output nor the visible empty-state changes", () => {
    expect(
      planTerminalMutation({
        previousEpoch: 1,
        previousOutput: "First line\n",
        previousStart: 0,
        previousStatus: "live",
        nextEpoch: 1,
        nextOutput: "First line\n",
        nextStart: 0,
        nextStatus: "closed"
      })
    ).toEqual({ kind: "none" });
  });
});
