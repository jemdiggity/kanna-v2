import { describe, expect, it } from "vitest";
import {
  CLAUDE_PROJECT_SLUG_FIXTURES,
  claudeProjectSlug,
  claudeTranscriptPath,
} from "../../../../packages/core/src/claude-transcript";

// The offline half of the transcript-location contract. The live test
// (tests/live/claude-transcript-location.test.ts) proves the rule matches the
// real CLI; this one runs everywhere and catches an accidental edit to the
// derivation that both the transfer source and the transfer receiver depend on.

describe("claudeProjectSlug", () => {
  for (const fixture of CLAUDE_PROJECT_SLUG_FIXTURES) {
    it(`maps ${fixture.cwd} — ${fixture.note}`, () => {
      expect(claudeProjectSlug(fixture.cwd)).toBe(fixture.slug);
    });
  }

  it("is a pure function of the path, with no run collapsing", () => {
    expect(claudeProjectSlug("/a//b")).toBe("-a--b");
    expect(claudeProjectSlug("")).toBe("");
  });
});

describe("claudeTranscriptPath", () => {
  it("addresses the transcript by home, slug, and session id", () => {
    expect(
      claudeTranscriptPath({
        homeDir: "/Users/x",
        cwd: "/Users/x/.kanna/repos/r/.kanna-worktrees/task-abc123",
        sessionId: "11111111-2222-3333-4444-555555555555",
      }),
    ).toBe(
      "/Users/x/.claude/projects/-Users-x--kanna-repos-r--kanna-worktrees-task-abc123/" +
      "11111111-2222-3333-4444-555555555555.jsonl",
    );
  });

  it("tolerates a trailing slash on the home directory", () => {
    expect(
      claudeTranscriptPath({ homeDir: "/Users/x/", cwd: "/tmp/w", sessionId: "s" }),
    ).toBe("/Users/x/.claude/projects/-tmp-w/s.jsonl");
  });
});
