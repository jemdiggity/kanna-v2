import { describe, expect, it } from "vitest";
import type { TaskFileMentionResolution } from "../lib/api/types";
import {
  MAX_TERMINAL_FILE_MENTION_PAYLOAD,
  mentionedFilesActionLabel,
  parseTerminalFileMentionHistory,
  parseTerminalFileMentionRaw,
  projectResolvedMentionRows
} from "./terminalFileMentions";

describe("terminal file mention history", () => {
  it("parses source tokens and strips line and column suffixes", () => {
    expect(parseTerminalFileMentionRaw("src/App.tsx:42:7")).toEqual({
      path: "src/App.tsx",
      line: 42
    });
    expect(parseTerminalFileMentionRaw("/tmp/work/file.rs:9")).toEqual({
      path: "/tmp/work/file.rs",
      line: 9
    });
    expect(parseTerminalFileMentionRaw("README.md")).toEqual({
      path: "README.md"
    });
  });

  it("rejects traversal, invalid lines, and unsupported image tokens", () => {
    for (const raw of [
      "../escape.ts",
      "src/../escape.ts",
      "src/App.tsx:0",
      "src/App.tsx:4:0",
      "src/App.tsx:not-a-line",
      "assets/logo.PNG",
      "art/icon.svg:2"
    ]) {
      expect(parseTerminalFileMentionRaw(raw), raw).toBeNull();
    }
  });

  it("keeps only bounded records whose raw token reparses identically", () => {
    expect(parseTerminalFileMentionHistory({
      type: "terminal-file-mentions",
      mentions: [
        { raw: "src/App.tsx:42:7", path: "src/App.tsx", line: 42 },
        { raw: "../escape.ts", path: "../escape.ts" },
        { raw: "forged.ts", path: "different.ts" },
        { raw: "src/Zero.ts:0", path: "src/Zero.ts", line: 0 },
        { raw: "x".repeat(4_097) + ".ts", path: "x".repeat(4_097) + ".ts" }
      ],
      overflow: false
    })).toEqual({
      mentions: [
        { raw: "src/App.tsx:42:7", path: "src/App.tsx", line: 42 }
      ],
      overflow: false
    });
  });

  it("rejects malformed envelopes and payloads over the bridge limit", () => {
    expect(parseTerminalFileMentionHistory(null)).toBeNull();
    expect(parseTerminalFileMentionHistory({
      type: "terminal-file-mentions",
      mentions: [],
      overflow: "false"
    })).toBeNull();
    expect(parseTerminalFileMentionHistory({
      type: "terminal-file-mentions",
      mentions: new Array(MAX_TERMINAL_FILE_MENTION_PAYLOAD + 1).fill({
        raw: "file.ts",
        path: "file.ts"
      }),
      overflow: false
    })).toBeNull();
  });

  it("caps a defensive 21-record payload and marks overflow", () => {
    const parsed = parseTerminalFileMentionHistory({
      type: "terminal-file-mentions",
      mentions: Array.from({ length: MAX_TERMINAL_FILE_MENTION_PAYLOAD }, (_, index) => ({
        raw: `file-${index}.ts`,
        path: `file-${index}.ts`
      })),
      overflow: false
    });

    expect(parsed?.mentions).toHaveLength(20);
    expect(parsed?.overflow).toBe(true);
  });

  it("formats exact and overflow action counts", () => {
    const valid = { raw: "file.ts", path: "file.ts" };
    expect(mentionedFilesActionLabel({ mentions: [], overflow: false }))
      .toBe("Mentioned Files (0)");
    expect(mentionedFilesActionLabel({
      mentions: [valid, { raw: "other.rs", path: "other.rs" }],
      overflow: false
    })).toBe("Mentioned Files (2)");
    expect(mentionedFilesActionLabel({
      mentions: new Array(20).fill(valid),
      overflow: true
    })).toBe("Mentioned Files (20+)");
  });

  it("projects canonical rows in MRU order and reports missing mentions", () => {
    const history = {
      mentions: [
        { raw: "Newest.ts:9", path: "Newest.ts", line: 9 },
        { raw: "Shared.ts", path: "Shared.ts" },
        { raw: "Missing.rs", path: "Missing.rs" }
      ],
      overflow: false
    };
    const resolution: TaskFileMentionResolution = {
      mentions: [
        {
          path: "Newest.ts",
          line: 9,
          matches: [{ path: "src/Newest.ts" }],
          truncated: false
        },
        {
          path: "Shared.ts",
          matches: [{ path: "b/Shared.ts" }, { path: "a/Shared.ts" }],
          truncated: false
        },
        {
          path: "Missing.rs",
          matches: [],
          truncated: false,
          unavailableReason: "file not found"
        }
      ]
    };

    expect(projectResolvedMentionRows(history, resolution)).toEqual({
      rows: [
        { path: "src/Newest.ts", line: 9, mentionPath: "Newest.ts", available: true },
        { path: "a/Shared.ts", mentionPath: "Shared.ts", available: true },
        { path: "b/Shared.ts", mentionPath: "Shared.ts", available: true },
        {
          path: "Missing.rs",
          mentionPath: "Missing.rs",
          available: false,
          unavailableReason: "file not found"
        }
      ],
      unmatchedCount: 0,
      truncated: false
    });
  });

  it("collapses canonical duplicates and preserves the newest line", () => {
    const history = {
      mentions: [
        { raw: "src/App.ts:31", path: "src/App.ts", line: 31 },
        { raw: "App.ts:4", path: "App.ts", line: 4 }
      ],
      overflow: true
    };
    const resolution: TaskFileMentionResolution = {
      mentions: [
        {
          path: "src/App.ts",
          line: 31,
          matches: [{ path: "src/App.ts" }],
          truncated: false
        },
        {
          path: "App.ts",
          line: 4,
          matches: [{ path: "src/App.ts" }],
          truncated: true
        }
      ]
    };

    expect(projectResolvedMentionRows(history, resolution)).toEqual({
      rows: [
        { path: "src/App.ts", line: 31, mentionPath: "src/App.ts", available: true }
      ],
      unmatchedCount: 0,
      truncated: true
    });
  });
});
