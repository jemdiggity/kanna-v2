import { describe, expect, it } from "vitest";

import {
  buildRevisionPrompt,
  formatReviewAnchor,
  type PendingReviewComment,
} from "./reviewComments";

describe("review comment prompt composition", () => {
  it("formats single-line and range anchors", () => {
    expect(formatReviewAnchor({ filePath: "apps/desktop/src/stores/pipeline.ts", startLine: 118, endLine: 118 }))
      .toBe("apps/desktop/src/stores/pipeline.ts:118");
    expect(formatReviewAnchor({ filePath: "crates/kanna-server/src/http_api/task_actions.rs", startLine: 41, endLine: 44 }))
      .toBe("crates/kanna-server/src/http_api/task_actions.rs:41-44");
  });

  it("builds the revision prompt with anchors, excerpts, notes, and summary", () => {
    const comments: PendingReviewComment[] = [
      {
        id: "comment-1",
        filePath: "apps/desktop/src/stores/pipeline.ts",
        startLine: 118,
        endLine: 124,
        excerpt: "for (const attempt of attempts) {\n  await run();\n}",
        note: "This retry loop hides the real error - surface it and drop the loop.",
        headCommit: "83b57a05e2eb8d4a9ad53bbfdb8fece00cf6c4dd",
      },
      {
        id: "comment-2",
        filePath: "crates/kanna-server/src/http_api/task_actions.rs",
        startLine: 41,
        endLine: 41,
        excerpt: "let task = resolve_existing_task_id(&db, &task_id)?;",
        note: "Same guard as close_task; extract and share it.",
        headCommit: "83b57a05e2eb8d4a9ad53bbfdb8fece00cf6c4dd",
      },
    ];

    expect(buildRevisionPrompt({
      taskId: "8f41c409",
      headCommit: "83b57a05e2eb8d4a9ad53bbfdb8fece00cf6c4dd",
      baseRef: "main",
      comments,
      summary: "good direction; fix the two issues above and re-run the daemon tests.",
    })).toBe([
      "Revision requested from review of task-8f41c409 @ 83b57a05 (branch diff vs main).",
      "",
      "apps/desktop/src/stores/pipeline.ts:118-124",
      "> for (const attempt of attempts) {",
      ">   await run();",
      "> }",
      "This retry loop hides the real error - surface it and drop the loop.",
      "",
      "crates/kanna-server/src/http_api/task_actions.rs:41",
      "> let task = resolve_existing_task_id(&db, &task_id)?;",
      "Same guard as close_task; extract and share it.",
      "",
      "Overall: good direction; fix the two issues above and re-run the daemon tests.",
    ].join("\n"));
  });

  it("marks comments written against a stale branch tip", () => {
    const comments: PendingReviewComment[] = [
      {
        id: "comment-1",
        filePath: "src/main.ts",
        startLine: 9,
        endLine: 10,
        excerpt: "return oldValue;",
        note: "This was reviewed before the force-push.",
        headCommit: "1111111111111111111111111111111111111111",
      },
    ];

    expect(buildRevisionPrompt({
      taskId: "task-already-prefixed",
      headCommit: "2222222222222222222222222222222222222222",
      baseRef: "origin/main",
      comments,
      summary: "",
    })).toBe([
      "Revision requested from review of task-already-prefixed @ 22222222 (branch diff vs origin/main).",
      "",
      "src/main.ts:9-10 (written against 11111111)",
      "> return oldValue;",
      "This was reviewed before the force-push.",
    ].join("\n"));
  });
});
