import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { ref } from "vue";

let dbCalls: { eventType: string; pipelineItemId: string | null; repoId: string | null }[] = [];

mock.module("@kanna/db", () => ({
  insertOperatorEvent: async (
    _db: any,
    eventType: string,
    pipelineItemId: string | null,
    repoId: string | null
  ) => {
    dbCalls.push({ eventType, pipelineItemId, repoId });
  },
}));

const { useOperatorEvents } = await import("./useOperatorEvents");

describe("useOperatorEvents", () => {
  beforeEach(() => {
    dbCalls = [];
  });

  it("emits app_blur when document becomes hidden", () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const cleanup = useOperatorEvents(db as any);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].eventType).toBe("app_blur");
    expect(dbCalls[0].pipelineItemId).toBeNull();
    expect(dbCalls[0].repoId).toBeNull();

    cleanup();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("emits app_focus when document becomes visible", () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const cleanup = useOperatorEvents(db as any);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].eventType).toBe("app_focus");

    cleanup();
  });

  it("does not emit when db is null", () => {
    const db = ref(null);
    const cleanup = useOperatorEvents(db as any);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(dbCalls).toHaveLength(0);

    cleanup();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });
});
