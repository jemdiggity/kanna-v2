import { describe, expect, it, vi } from "vitest";
import {
  handleCloudTaskPublication,
  planTaskReconciliation,
  validateCloudTaskPublication,
  type CloudTaskPublicationStore,
} from "../src/cloudTaskPublication.js";

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cloudTaskId: "cloud-stable",
    localRepoId: "repo-1",
    ownerDesktopId: "desktop-1",
    ownerLocalTaskId: "task-1",
    title: "Publish from server",
    promptSnippet: "Publish from server",
    waitingPromptSnippet: "Ready for review",
    displayName: null,
    stage: "in progress",
    activity: "idle",
    activityRevision: 4,
    queuedInputCount: 2,
    queuedInputReason: "input_held_by_draft",
    blockerRevision: 6,
    transitionRevision: "run-4",
    status: "active",
    repo: {
      cloudRepoId: "repo-1",
      name: "Kanna",
      remoteUrl: "git@github.com:kanna/kanna.git",
      remoteUrlHash: "remote-hash",
      defaultBranch: "main",
    },
    branch: "task-task-1",
    baseRef: "origin/main",
    prNumber: null,
    prUrl: null,
    agent: { provider: "codex", type: "pty" },
    transfer: {
      state: "none",
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null,
    },
    blockedByTaskIds: [],
    pinned: false,
    pinOrder: null,
    createdAt: "2026-07-14 00:00:00",
    updatedAt: "2026-07-14 00:01:00",
    closedAt: null,
    ...overrides,
  };
}

function publication(
  tasks: unknown[] = [task()],
  desktop: Record<string, unknown> = {
    displayName: "Studio Mac",
    transfer: {
      peerId: "peer-a",
      publicKey: "base64-key",
      protocolVersion: 1,
      acceptingTransfers: true,
    },
  },
  schemaVersion: 1 | 2 = 2,
): Record<string, unknown> {
  return {
    schemaVersion,
    desktop,
    tasks,
  };
}

describe("cloud task publication validation", () => {
  it("accepts and normalizes the existing mobile cloud snapshot schema", () => {
    const parsed = validateCloudTaskPublication(publication(), "desktop-1");
    expect(parsed.transfer).toEqual({
      peerId: "peer-a",
      publicKey: "base64-key",
      protocolVersion: 1,
      acceptingTransfers: true,
    });
    expect(parsed.tasks[0]).toMatchObject({
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      cloudTaskId: "cloud-stable",
      activity: "idle",
      activityRevision: 4,
      queuedInputCount: 2,
      queuedInputReason: "input_held_by_draft",
      blockerRevision: 6,
      transitionRevision: "run-4",
      waitingPromptSnippet: "Ready for review",
      pinned: false,
      pinOrder: null,
      agent: { provider: "codex", type: "pty" },
      repo: { remoteUrlHash: "remote-hash" },
    });
  });

  it("preserves queued input status and defaults older publishers to no queue", () => {
    const queued = validateCloudTaskPublication(publication(), "desktop-1");
    expect(queued.tasks[0]).toMatchObject({
      queuedInputCount: 2,
      queuedInputReason: "input_held_by_draft",
    });

    const legacyTask = task();
    delete legacyTask.queuedInputCount;
    delete legacyTask.queuedInputReason;
    const legacy = validateCloudTaskPublication(
      publication([legacyTask]),
      "desktop-1",
    );
    expect(legacy.tasks[0]).toMatchObject({
      queuedInputCount: 0,
      queuedInputReason: null,
    });

    expect(() => validateCloudTaskPublication(
      publication([task({ queuedInputReason: "lost" })]),
      "desktop-1",
    )).toThrow(/queuedInputReason/);
  });

  it("preserves canonical pin metadata and defaults older publishers to unpinned", () => {
    const pinned = validateCloudTaskPublication(
      publication([task({ pinned: true, pinOrder: 4 })]),
      "desktop-1",
    );
    expect(pinned.tasks[0]).toMatchObject({ pinned: true, pinOrder: 4 });

    const legacyTask = task();
    delete legacyTask.pinned;
    delete legacyTask.pinOrder;
    const legacy = validateCloudTaskPublication(
      publication([legacyTask]),
      "desktop-1",
    );
    expect(legacy.tasks[0]).toMatchObject({ pinned: false });
  });

  it("accepts older publishers without desktop transfer metadata", () => {
    const parsed = validateCloudTaskPublication(
      publication([], { displayName: "Studio Mac" }, 1),
      "desktop-1",
    );

    expect(parsed.transfer).toBeNull();
  });

  it("carries the publishing desktop's agent provider inventory", () => {
    const parsed = validateCloudTaskPublication(
      publication([], {
        displayName: "Studio Mac",
        agentProviders: ["opencode"],
      }),
      "desktop-1",
    );

    expect(parsed.agentProviders).toEqual(["opencode"]);
  });

  it("keeps an empty inventory distinct from a desktop that reports none", () => {
    const empty = validateCloudTaskPublication(
      publication([], { displayName: "Studio Mac", agentProviders: [] }),
      "desktop-1",
    );
    const legacy = validateCloudTaskPublication(
      publication([], { displayName: "Studio Mac" }),
      "desktop-1",
    );

    expect(empty.agentProviders).toEqual([]);
    expect(legacy.agentProviders).toBeNull();
  });

  it.each([
    ["not-an-array", "opencode"],
    ["blank entry", [" "]],
    ["non-string entry", [7]],
  ])("rejects an invalid agent provider inventory (%s)", (_label, agentProviders) => {
    expect(() => validateCloudTaskPublication(
      publication([], { displayName: "Studio Mac", agentProviders }),
      "desktop-1",
    )).toThrow(/desktop\.agentProviders/);
  });

  it("requires schema v1 publishers to down-convert widened transfer states", () => {
    expect(() => validateCloudTaskPublication(
      publication([task({
        transfer: {
          state: "outgoing",
          transferId: "transfer-1",
          sourceDesktopId: "desktop-1",
          destinationDesktopId: "desktop-b",
        },
      })], { displayName: "Studio Mac" }, 1),
      "desktop-1",
    )).toThrow(/must be none for schemaVersion 1/);
  });

  it.each([
    ["peerId", ""],
    ["publicKey", "   "],
    ["protocolVersion", 0],
    ["protocolVersion", 1.5],
    ["acceptingTransfers", "yes"],
  ])("rejects invalid desktop transfer %s", (field, value) => {
    expect(() => validateCloudTaskPublication(
      publication([], {
        displayName: "Studio Mac",
        transfer: {
          peerId: "peer-a",
          publicKey: "base64-key",
          protocolVersion: 1,
          acceptingTransfers: true,
          [field]: value,
        },
      }),
      "desktop-1",
    )).toThrow(new RegExp(`desktop\\.transfer\\.${field}`));
  });

  it("accepts exactly the four transfer states with authenticated desktop ids", () => {
    const states = ["none", "outgoing", "incoming", "finalization_pending"] as const;

    for (const state of states) {
      const transfer = state === "none"
        ? {
            state,
            transferId: null,
            sourceDesktopId: null,
            destinationDesktopId: null,
          }
        : {
            state,
            transferId: "transfer-1",
            sourceDesktopId: state === "outgoing" ? "desktop-1" : "desktop-a",
            destinationDesktopId: state === "outgoing" ? "desktop-b" : "desktop-1",
          };
      const parsed = validateCloudTaskPublication(
        publication([task({ transfer })]),
        "desktop-1",
      );

      expect(parsed.tasks[0]?.transfer).toEqual(transfer);
    }

    expect(() => validateCloudTaskPublication(
      publication([task({
        transfer: {
          state: "finished",
          transferId: "transfer-1",
          sourceDesktopId: "desktop-a",
          destinationDesktopId: "desktop-b",
        },
      })]),
      "desktop-1",
    )).toThrow(/transfer.state/);
  });

  it.each([
    ["outgoing", "desktop-other", "desktop-target"],
    ["incoming", "desktop-source", "desktop-other"],
    ["finalization_pending", "desktop-source", "desktop-other"],
  ])("rejects %s publication by a desktop that does not own its role", (
    state,
    sourceDesktopId,
    destinationDesktopId,
  ) => {
    expect(() => validateCloudTaskPublication(
      publication([task({
        transfer: {
          state,
          transferId: "transfer-1",
          sourceDesktopId,
          destinationDesktopId,
        },
      })]),
      "desktop-1",
    )).toThrow(/authenticated desktop/);
  });

  it.each([
    ["transferId", null],
    ["sourceDesktopId", null],
    ["destinationDesktopId", null],
  ])("rejects outgoing transfer missing %s", (field, missingValue) => {
    expect(() => validateCloudTaskPublication(
      publication([task({
        transfer: {
          state: "outgoing",
          transferId: "transfer-1",
          sourceDesktopId: "desktop-1",
          destinationDesktopId: "desktop-b",
          [field]: missingValue,
        },
      })]),
      "desktop-1",
    )).toThrow(new RegExp(`transfer\\.${field}`));
  });

  it.each([
    ["transferId", "empty", ""],
    ["transferId", "whitespace-only", " \t "],
    ["sourceDesktopId", "empty", ""],
    ["sourceDesktopId", "whitespace-only", "\n  "],
    ["destinationDesktopId", "empty", ""],
    ["destinationDesktopId", "whitespace-only", "   "],
  ])("rejects outgoing transfer with %s %s", (field, _kind, invalidValue) => {
    expect(() => validateCloudTaskPublication(
      publication([task({
        transfer: {
          state: "outgoing",
          transferId: "transfer-1",
          sourceDesktopId: "desktop-1",
          destinationDesktopId: "desktop-b",
          [field]: invalidValue,
        },
      })]),
      "desktop-1",
    )).toThrow(new RegExp(`transfer\\.${field}`));
  });

  it("accepts legacy missing transition revisions but rejects malformed values", () => {
    const legacy = validateCloudTaskPublication(
      publication([task({ transitionRevision: undefined })]),
      "desktop-1",
    );
    expect(legacy.tasks[0]?.transitionRevision).toBeNull();

    expect(validateCloudTaskPublication(
      publication([task({ transitionRevision: null })]),
      "desktop-1",
    ).tasks[0]?.transitionRevision).toBeNull();

    for (const transitionRevision of ["", "r".repeat(129), 4]) {
      expect(() => validateCloudTaskPublication(
        publication([task({ transitionRevision })]),
        "desktop-1",
      )).toThrow(/transitionRevision/);
    }
  });

  it("accepts legacy missing revisions but rejects malformed activity revisions", () => {
    const legacy = validateCloudTaskPublication(
      publication([task({ activityRevision: undefined })]),
      "desktop-1",
    );
    expect(legacy.tasks[0]?.activityRevision).toBeUndefined();

    for (const activityRevision of [-1, 1.5, "4"]) {
      expect(() => validateCloudTaskPublication(
        publication([task({ activityRevision })]),
        "desktop-1",
      )).toThrow(/activityRevision/);
    }
  });

  it("accepts legacy missing blocker revisions but preserves and validates present revisions", () => {
    const legacy = validateCloudTaskPublication(
      publication([task({ blockerRevision: undefined })]),
      "desktop-1",
    );
    expect(legacy.tasks[0]?.blockerRevision).toBeUndefined();

    for (const blockerRevision of [-1, 1.5, "6"]) {
      expect(() => validateCloudTaskPublication(
        publication([task({ blockerRevision })]),
        "desktop-1",
      )).toThrow(/blockerRevision/);
    }
  });

  it("normalizes missing waiting prompts and bounds them by Unicode scalar count", () => {
    const legacy = validateCloudTaskPublication(
      publication([task({ waitingPromptSnippet: undefined })]),
      "desktop-1",
    );
    expect(legacy.tasks[0]?.waitingPromptSnippet).toBeNull();

    const bounded = validateCloudTaskPublication(
      publication([task({ waitingPromptSnippet: "🙂".repeat(240) })]),
      "desktop-1",
    );
    expect(bounded.tasks[0]?.waitingPromptSnippet).toBe("🙂".repeat(240));

    expect(() => validateCloudTaskPublication(
      publication([task({ waitingPromptSnippet: "🙂".repeat(241) })]),
      "desktop-1",
    )).toThrow(/waitingPromptSnippet/);
  });

  it("normalizes missing running-post flags and passes present ones through", () => {
    const legacy = validateCloudTaskPublication(
      publication([task({ hasRunningPost: undefined })]),
      "desktop-1",
    );
    expect(legacy.tasks[0]?.hasRunningPost).toBe(false);

    const running = validateCloudTaskPublication(
      publication([task({ hasRunningPost: true })]),
      "desktop-1",
    );
    expect(running.tasks[0]?.hasRunningPost).toBe(true);

    expect(() => validateCloudTaskPublication(
      publication([task({ hasRunningPost: "yes" })]),
      "desktop-1",
    )).toThrow(/hasRunningPost/);
  });

  it("normalizes missing parent task ids and bounds present ones", () => {
    const legacy = validateCloudTaskPublication(
      publication([task({ parentTaskId: undefined })]),
      "desktop-1",
    );
    expect(legacy.tasks[0]?.parentTaskId).toBeNull();

    const nested = validateCloudTaskPublication(
      publication([task({ parentTaskId: "task-parent" })]),
      "desktop-1",
    );
    expect(nested.tasks[0]?.parentTaskId).toBe("task-parent");

    expect(() => validateCloudTaskPublication(
      publication([task({ parentTaskId: "x".repeat(129) })]),
      "desktop-1",
    )).toThrow(/parentTaskId/);
  });

  it("rejects malformed, cross-desktop, duplicate, and oversized publications", () => {
    expect(() => validateCloudTaskPublication(null, "desktop-1")).toThrow(/object/);
    expect(() => validateCloudTaskPublication(publication([
      task({ ownerDesktopId: "desktop-2" }),
    ]), "desktop-1")).toThrow(/ownerDesktopId/);
    expect(() => validateCloudTaskPublication(publication([task(), task()]), "desktop-1"))
      .toThrow(/duplicate/);
    expect(() => validateCloudTaskPublication(publication([
      task({ title: "x".repeat(513) }),
    ]), "desktop-1")).toThrow(/title/);
    expect(() => validateCloudTaskPublication(publication(
      Array.from({ length: 251 }, (_, index) => task({ ownerLocalTaskId: `task-${index}` })),
    ), "desktop-1")).toThrow(/at most 250/);
  });

  it("measures prompt snippets in Unicode characters like kanna-server", () => {
    const promptSnippet = `${"😀".repeat(250)}${"界".repeat(250)}`;
    const parsed = validateCloudTaskPublication(
      publication([task({ promptSnippet })]),
      "desktop-1",
    );
    expect(parsed.tasks[0]?.promptSnippet).toBe(promptSnippet);

    expect(() => validateCloudTaskPublication(
      publication([task({ promptSnippet: `${promptSnippet}x` })]),
      "desktop-1",
    )).toThrow(/promptSnippet/);
  });
});

describe("cloud task publication reconciliation", () => {
  it("sets current tasks, carries activity-only changes, and deletes stale and duplicate docs", () => {
    const plan = planTaskReconciliation(
      [
        { id: "current", data: task({ activity: "idle" }) },
        { id: "duplicate", data: task({ activity: "idle" }) },
        { id: "stale", data: task({ ownerLocalTaskId: "task-stale" }) },
      ],
      validateCloudTaskPublication(publication([task({ activity: "working" })]), "desktop-1").tasks,
      () => "new-auto-id",
    );

    expect(plan.sets).toEqual([{ id: "current", data: expect.objectContaining({ activity: "working" }) }]);
    expect(plan.deleteIds).toEqual(["duplicate", "stale"]);
  });

  it("uses only the authenticated user and desktop subtree", async () => {
    const reconcile = vi.fn(async () => undefined);
    const store: CloudTaskPublicationStore = { reconcile };

    await handleCloudTaskPublication({
      userId: "user-owner",
      desktopId: "desktop-1",
      generation: { session: 4, sequence: 2 },
      snapshot: publication(),
      store,
    } as Parameters<typeof handleCloudTaskPublication>[0]);

    expect(reconcile).toHaveBeenCalledWith({
      userId: "user-owner",
      desktopId: "desktop-1",
      generation: { session: 4, sequence: 2 },
      displayName: "Studio Mac",
      agentProviders: null,
      transfer: {
        peerId: "peer-a",
        publicKey: "base64-key",
        protocolVersion: 1,
        acceptingTransfers: true,
      },
      tasks: expect.arrayContaining([
        expect.objectContaining({ ownerDesktopId: "desktop-1", ownerLocalTaskId: "task-1" }),
      ]),
    });
  });

});
