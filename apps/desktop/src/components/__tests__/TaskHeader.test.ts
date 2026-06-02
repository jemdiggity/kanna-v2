// @vitest-environment happy-dom

import type { PipelineItem } from "@kanna/db";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../tauri-mock", () => ({
  isTauri: true,
}));

function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Fix port ordering",
    pipeline: "default",
    stage: "in progress",
    stage_result: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: "task-1",
    closed_at: null,
    agent_type: null,
    agent_provider: "claude",
    agent_session_id: null,
    activity: "idle",
    activity_changed_at: null,
    unread_at: null,
    port_offset: null,
    display_name: "Fix port ordering",
    port_env: JSON.stringify({
      API_PORT: 3001,
      KANNA_DEV_PORT: 1421,
    }),
    pinned: 0,
    pin_order: null,
    base_ref: null,
    previous_stage: null,
    teardown_started_at: null,
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("TaskHeader", () => {
  it("renders port badges in ascending numeric order", async () => {
    const { default: TaskHeader } = await import("../TaskHeader.vue");
    const wrapper = mount(TaskHeader, {
      props: {
        item: makeItem(),
      },
      global: {
        mocks: {
          $t: (key: string, fallback?: string) => fallback ?? key,
        },
      },
    });

    expect(
      wrapper.findAll(".meta-item.port").map((node) => node.text().trim()),
    ).toEqual([":1421", ":3001"]);
  });

  it("opens localhost for a port badge on double click", async () => {
    const { default: TaskHeader } = await import("../TaskHeader.vue");
    const wrapper = mount(TaskHeader, {
      props: {
        item: makeItem(),
      },
      global: {
        mocks: {
          $t: (key: string, fallback?: string) => fallback ?? key,
        },
      },
    });

    await wrapper.find(".meta-item.port").trigger("dblclick");

    expect(openUrl).toHaveBeenCalledWith("http://localhost:1421");
  });

  it("does not let the header mousedown guard cancel port interaction", async () => {
    const { default: TaskHeader } = await import("../TaskHeader.vue");
    const wrapper = mount(TaskHeader, {
      props: {
        item: makeItem(),
      },
      global: {
        mocks: {
          $t: (key: string, fallback?: string) => fallback ?? key,
        },
      },
    });

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    wrapper.find(".meta-item.port").element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
