import { describe, expect, it } from "vitest";
import type { PipelineItem } from "../types/kanna";
import { taskSearchMatch } from "./taskSearch";

function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "item-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Refactor task search behavior to reduce false positives",
    workflow: "default",
    stage: "in progress",
    stage_result: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: "task-search-tuning",
    closed_at: null,
    agent_type: "claude",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: null,
    unread_at: null,
    port_offset: null,
    display_name: "Tighten task search",
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    created_at: "2026-04-08T00:00:00.000Z",
    updated_at: "2026-04-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("taskSearchMatch", () => {
  it("accepts structural searchable task data without an identity", () => {
    const searchable = {
      display_name: "Stable creation slot",
      issue_title: null,
      branch: null,
      prompt: "Keep one row while the durable task hydrates",
    };

    expect(taskSearchMatch("creation slot", searchable)?.score).toBeGreaterThan(0);
  });

  it("matches non-Latin queries in task titles", () => {
    const japaneseItem = makeItem({
      display_name: "タスク検索",
      prompt: "",
      branch: "task-1234",
    });
    const koreanItem = makeItem({
      display_name: "작업개선",
      prompt: "",
      branch: "task-5678",
    });

    expect(taskSearchMatch("検索", japaneseItem)?.score).toBeGreaterThan(0);
    expect(taskSearchMatch("개선", koreanItem)?.score).toBeGreaterThan(0);
  });

  it("matches contiguous substrings but rejects subsequence-only title matches", () => {
    const contiguous = makeItem({
      display_name: "hot-unfuck-fix",
      prompt: "",
      branch: "task-1234",
    });
    const subsequenceOnly = makeItem({
      display_name: "unrelated notification flow update checklist",
      prompt: "",
      branch: "task-5678",
    });

    expect(taskSearchMatch("unfuck", contiguous)?.score).toBeGreaterThan(0);
    expect(taskSearchMatch("unfuck", subsequenceOnly)).toBeNull();
  });

  it("matches exact, prefix, and substring hits in descending strength", () => {
    const exact = makeItem({ display_name: "unfuck", prompt: "" });
    const prefix = makeItem({ display_name: "unfucked terminal", prompt: "" });
    const substring = makeItem({ display_name: "preunfuckpost", prompt: "" });

    const exactScore = taskSearchMatch("unfuck", exact)?.score ?? 0;
    const prefixScore = taskSearchMatch("unfuck", prefix)?.score ?? 0;
    const substringScore = taskSearchMatch("unfuck", substring)?.score ?? 0;

    expect(exactScore).toBeGreaterThan(prefixScore);
    expect(prefixScore).toBeGreaterThan(substringScore);
  });

  it("matches exact and prefix terms in the task title", () => {
    const item = makeItem();

    expect(taskSearchMatch("tight", item)?.score).toBeGreaterThan(0);
    expect(taskSearchMatch("search", item)?.score).toBeGreaterThan(0);
  });

  it("matches branch terms without relying on character-by-character fuzziness", () => {
    const item = makeItem({ display_name: "Improve sidebar filtering" });

    expect(taskSearchMatch("search tuning", item)?.score).toBeGreaterThan(0);
    expect(taskSearchMatch("sst", item)).toBeNull();
  });

  it("matches a durable task id exactly or by a literal partial id", () => {
    const item = makeItem({
      id: "eef65d54",
      branch: null,
      display_name: "Unrelated title",
      prompt: "Unrelated prompt",
    });

    expect(taskSearchMatch("eef65d54", item)?.score).toBeGreaterThan(0);
    expect(taskSearchMatch("EEF65", item)?.score).toBeGreaterThan(0);
    expect(taskSearchMatch("65d5", item)?.score).toBeGreaterThan(0);
    expect(taskSearchMatch("ef54", item)).toBeNull();
  });

  it("matches the durable id exposed by a sidebar task slot", () => {
    const item = {
      task_id: "eef65d54",
      display_name: "Unrelated title",
      issue_title: null,
      branch: null,
      prompt: null,
    };

    expect(taskSearchMatch("eef65", item)?.score).toBeGreaterThan(0);
  });

  it("requires every query term to match somewhere meaningful", () => {
    const item = makeItem();

    expect(taskSearchMatch("tight false", item)?.score).toBeGreaterThan(0);
    expect(taskSearchMatch("tight zebra", item)).toBeNull();
  });

  it("does not treat scattered letters in a long prompt as a match", () => {
    const item = makeItem({
      display_name: null,
      issue_title: null,
      prompt: "Close the terminal modal after the agent finishes cleanly",
      branch: "task-1234",
    });

    expect(taskSearchMatch("ctma", item)).toBeNull();
    expect(taskSearchMatch("terminal modal", item)?.score).toBeGreaterThan(0);
  });

  it("prefers stronger title matches over weaker prompt-only matches", () => {
    const titleMatch = makeItem();
    const promptMatch = makeItem({
      display_name: "Sidebar cleanup",
      prompt: "Tighten task search behavior to reduce false positives",
    });

    const titleScore = taskSearchMatch("tight", titleMatch)?.score ?? 0;
    const promptScore = taskSearchMatch("tight", promptMatch)?.score ?? 0;

    expect(titleScore).toBeGreaterThan(promptScore);
  });
});
