import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ref } from "vue";
import type { PipelineItem } from "@kanna/db";

// Track DB calls
let dbCalls: { activity: string; id: string }[] = [];

// Mock @kanna/db
mock.module("@kanna/db", () => ({
  updatePipelineItemActivity: async (
    _db: any,
    id: string,
    activity: string
  ) => {
    dbCalls.push({ id, activity });
  },
}));

const { useMarkAsRead } = await import("./useMarkAsRead");

function makeItem(
  overrides: Partial<PipelineItem> = {}
): PipelineItem {
  return {
    id: "item-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: null,
    stage: "in_progress",
    pr_number: null,
    pr_url: null,
    branch: null,
    agent_type: "pty",
    activity: "unread",
    activity_changed_at: "2026-03-21T00:00:00.000Z",
    port_offset: null,
    display_name: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    created_at: "2026-03-21T09:00:00.000Z",
    updated_at: "2026-03-21T09:00:00.000Z",
    ...overrides,
  };
}

describe("useMarkAsRead", () => {
  beforeEach(() => {
    dbCalls = [];
  });

  it("marks an unread item as idle after debounce", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-21T00:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    // Should NOT be marked immediately
    await new Promise((r) => setTimeout(r, 100));
    expect(dbCalls).toHaveLength(0);
    expect(item.activity).toBe("unread");

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 1100));
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0]).toEqual({ id: "item-1", activity: "idle" });
    expect(item.activity).toBe("idle");
  });

  it("does not mark idle items", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "idle" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(0);
  });

  it("cancels pending mark-as-read on rapid navigation", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item1 = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-21T00:00:00.000Z" });
    const item2 = makeItem({ id: "item-2", activity: "unread", activity_changed_at: "2026-03-21T00:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item1, item2]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    // Navigate rapidly: item-1 → item-2
    selectedItemId.value = "item-1";
    await new Promise((r) => setTimeout(r, 200));
    selectedItemId.value = "item-2";

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 1200));

    // Only item-2 should be marked
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].id).toBe("item-2");
    expect(item1.activity).toBe("unread");
    expect(item2.activity).toBe("idle");
  });

  it("skips mark-as-read if activity_changed_at is newer than selection time", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    // Set activity_changed_at far in the future so it's always after selectionTime
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2099-01-01T00:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 1200));

    // Should NOT mark as read — activity_changed_at is after selection time
    expect(dbCalls).toHaveLength(0);
    expect(item.activity).toBe("unread");
  });

  it("handles null activity_changed_at (treats as old)", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: null });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(1);
    expect(item.activity).toBe("idle");
  });

  it("cancels pending mark-as-read when selectedItemId becomes null", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-21T00:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    // Select item (starts debounce)
    selectedItemId.value = "item-1";
    await new Promise((r) => setTimeout(r, 200));

    // Deselect (should cancel pending debounce)
    selectedItemId.value = null;

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(0);
    expect(item.activity).toBe("unread");
  });

  it("no-ops when db is null", async () => {
    const db = ref(null);
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-21T00:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(0);
  });

  it("no-ops when item is removed from allItems during debounce", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-21T00:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    // Remove item before debounce fires
    await new Promise((r) => setTimeout(r, 200));
    allItems.value = [];

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(0);
  });
});
