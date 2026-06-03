import { describe, expect, it } from "vitest";
import type { PipelineItem } from "@kanna/db";

import { sortSidebarItemsForRepo } from "./sidebarOrdering";

function item(overrides: Partial<PipelineItem>): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Task",
    pipeline: "default",
    stage: "in progress",
    stage_result: null,
    active_post_action: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: "task-task-1",
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: "2026-05-31T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    display_name: null,
    base_ref: null,
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    last_output_preview: null,
    created_at: "2026-05-31T00:00:00.000Z",
    updated_at: "2026-05-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("sidebarOrdering", () => {
  it("excludes closed rows even when their stage is still active", () => {
    const sorted = sortSidebarItemsForRepo({
      repoId: "repo-1",
      items: [
        item({ id: "closed-pr", stage: "pr", closed_at: "2026-05-31 10:56:44" }),
        item({ id: "open", stage: "in progress", closed_at: null }),
      ],
      getStageOrder: () => ["merge", "pr", "review", "in progress"],
    });

    expect(sorted.map((entry) => entry.id)).toEqual(["open"]);
  });
});
