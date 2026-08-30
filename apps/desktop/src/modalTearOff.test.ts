import { describe, expect, it, vi } from "vitest";
import {
  buildModalTearOffUrl,
  parseModalTearOffContext,
  resolveModalTearOffGeometry,
  type DiffTearOffContext,
} from "./modalTearOff";

describe("modal tear-off context", () => {
  it("round-trips diff state through the standalone window URL", () => {
    const context: DiffTearOffContext = {
      surface: "diff",
      repoPath: "/repo with spaces",
      worktreePath: "/repo/.kanna-worktrees/task-1",
      initialScope: "branch",
      initialScrollPositions: { branch: 412, working: 18 },
      initialBranchInclude: "staged",
      baseRef: "origin/main",
      taskId: "task-1",
      reviewComments: [{
        id: "comment-1",
        filePath: "src/日本語.ts",
        startLine: 4,
        endLine: 5,
        excerpt: "const answer = 42;",
        note: "Keep this state",
      }],
    };

    expect(parseModalTearOffContext(buildModalTearOffUrl(context).slice(1))).toEqual(context);
  });

  it("rejects malformed or unknown contexts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseModalTearOffContext("?tearOff=%7Bbad")).toBeNull();
    expect(parseModalTearOffContext("?tearOff=%7B%22surface%22%3A%22shell%22%7D")).toBeNull();
    warn.mockRestore();
  });
});

describe("modal tear-off geometry", () => {
  it("preserves the pointer grab offset and exact modal dimensions", () => {
    expect(resolveModalTearOffGeometry(
      {
        clientX: 250,
        clientY: 180,
        screenX: 650,
        screenY: 280,
        modalLeft: 100,
        modalTop: 80,
        modalWidth: 780.4,
        modalHeight: 520.6,
      },
      {
        clientX: 370,
        clientY: 240,
        screenX: 770,
        screenY: 340,
      },
    )).toEqual({
      x: 620,
      y: 240,
      width: 780,
      height: 521,
    });
  });
});
