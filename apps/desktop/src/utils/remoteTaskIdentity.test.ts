import { describe, expect, it } from "vitest";
import type { PipelineItem } from "../types/kanna";
import { remoteTaskClosureAliases, remoteTaskClosureKey, remoteTaskIsLocallyClosed } from "./remoteTaskIdentity";

function item(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "cloud:repo-remote:task-1",
    repo_id: "repo-local",
    prompt: "Remote task",
    workflow: "cloud",
    stage: "in progress",
    tags: "[\"in progress\"]",
    pr_number: null,
    pr_url: null,
    branch: "task-1",
    activity: "idle",
    activity_changed_at: "2026-05-23T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    display_name: null,
    issue_number: null,
    issue_title: null,
    closed_at: null,
    agent_session_id: null,
    base_ref: "origin/main",
    agent_provider: "codex",
    agent_type: "pty",
    previous_stage: null,
    stage_result: null,
    teardown_started_at: null,
    last_output_preview: null,
    active_post_action: null,
    created_at: "2026-05-23T00:00:00.000Z",
    updated_at: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("remoteTaskIdentity", () => {
  it("uses the owner desktop and owner local task as the canonical close key", () => {
    expect(remoteTaskClosureKey({
      ownerDesktopId: "peer-primary",
      ownerLocalTaskId: "task-1",
      transport: "lan",
    })).toBe("owner:peer-primary:task-1");
  });

  it("builds equivalent close aliases for cloud and LAN advertisements of the same owner task", () => {
    const cloudItem = item({ id: "cloud:repo-remote:task-1" });
    const lanItem = item({ id: "cloud:lan:peer-primary:repo-remote:task-1" });
    const ref = {
      ownerDesktopId: "peer-primary",
      ownerLocalTaskId: "task-1",
      transport: "lan" as const,
    };

    expect(remoteTaskClosureAliases(cloudItem, ref)).toContain("owner:peer-primary:task-1");
    expect(remoteTaskClosureAliases(lanItem, ref)).toContain("owner:peer-primary:task-1");
  });

  it("treats a cloud advertisement as closed when the LAN advertisement was closed first", () => {
    const cloudItem = item({ id: "cloud:repo-remote:task-1" });
    const cloudRef = {
      ownerDesktopId: "peer-primary",
      ownerLocalTaskId: "task-1",
      transport: "cloud" as const,
    };
    const closedFromLan = new Set([
      "cloud:lan:peer-primary:repo-remote:task-1",
      "owner:peer-primary:task-1",
    ]);

    expect(remoteTaskIsLocallyClosed(cloudItem, cloudRef, closedFromLan)).toBe(true);
  });
});
