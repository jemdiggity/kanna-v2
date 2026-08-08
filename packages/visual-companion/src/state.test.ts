import { describe, expect, it } from "vitest";
import {
  initialCompanionState,
  reduceCompanionState,
  type CompanionSnapshot
} from "./index";

const snapshot: CompanionSnapshot = {
  sessionId: "session-1",
  revision: "revision-1",
  documentKind: "fragment",
  html: "<h2>Hello</h2>",
  sourceOrigin: "http://localhost:4312",
  assets: [
    {
      name: "layout.png",
      contentType: "image/png",
      digest: "digest-1",
      dataB64: "UE5H"
    }
  ]
};

describe("reduceCompanionState", () => {
  it("publishes a complete snapshot and resets event state", () => {
    expect(
      reduceCompanionState(initialCompanionState(), {
        type: "snapshot",
        snapshot
      })
    ).toMatchObject({
      status: "available",
      snapshot,
      eventStatus: "idle",
      unread: true
    });
  });

  it("retains the latest complete snapshot while reconnecting by default", () => {
    const available = reduceCompanionState(initialCompanionState(), {
      type: "snapshot",
      snapshot
    });

    expect(
      reduceCompanionState(available, {
        type: "connection",
        connected: false
      })
    ).toMatchObject({
      status: "reconnecting",
      snapshot
    });
  });

  it("can invalidate the snapshot at a compatibility boundary", () => {
    const available = reduceCompanionState(initialCompanionState(), {
      type: "snapshot",
      snapshot
    });

    expect(
      reduceCompanionState(available, {
        type: "connection",
        connected: false,
        retainSnapshot: false
      })
    ).toMatchObject({
      status: "reconnecting",
      snapshot: null
    });
  });

  it("tracks a pending event and only accepts its matching result", () => {
    const available = reduceCompanionState(initialCompanionState(), {
      type: "snapshot",
      snapshot,
      viewed: true
    });
    const sending = reduceCompanionState(available, {
      type: "begin_event",
      eventId: "event-2"
    });
    const stale = reduceCompanionState(sending, {
      type: "event_result",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "event-1",
        accepted: true
      }
    });
    const rejected = reduceCompanionState(stale, {
      type: "event_result",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "event-2",
        accepted: false,
        code: "stale_revision"
      }
    });

    expect(stale).toBe(sending);
    expect(rejected).toMatchObject({
      status: "available",
      snapshot,
      eventId: "event-2",
      eventStatus: "error",
      errorMessage: "Selection rejected: stale_revision"
    });
  });

  it("ignores matching event IDs from stale companion identities", () => {
    const available = reduceCompanionState(initialCompanionState(), {
      type: "snapshot",
      snapshot,
      viewed: true
    });
    const sending = reduceCompanionState(available, {
      type: "begin_event",
      eventId: "event-1"
    });

    const staleSession = reduceCompanionState(sending, {
      type: "event_result",
      result: {
        sessionId: "session-old",
        revision: "revision-1",
        eventId: "event-1",
        accepted: true
      }
    });
    const staleRevision = reduceCompanionState(sending, {
      type: "event_result",
      result: {
        sessionId: "session-1",
        revision: "revision-old",
        eventId: "event-1",
        accepted: true
      }
    });

    expect(staleSession).toBe(sending);
    expect(staleRevision).toBe(sending);
  });

  it("clears stale data for unavailable and source-error states", () => {
    const available = reduceCompanionState(initialCompanionState(), {
      type: "snapshot",
      snapshot
    });
    expect(
      reduceCompanionState(available, { type: "unavailable" })
    ).toMatchObject({
      status: "unavailable",
      snapshot: null,
      unread: false
    });
    expect(
      reduceCompanionState(available, {
        type: "error",
        message: "Unreadable"
      })
    ).toMatchObject({
      status: "error",
      snapshot: null,
      errorMessage: "Unreadable"
    });
  });
});
