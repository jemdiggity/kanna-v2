import { describe, expect, it } from "vitest";
import {
  nextCompanionEventId,
  parseCompanionBridgeEvent
} from "./index";

describe("parseCompanionBridgeEvent", () => {
  it("accepts the exact byte-bounded click envelope", () => {
    const event = {
      session_id: "123-456",
      revision: "rev-1",
      event_id: "mobile-1",
      type: "click" as const,
      choice: "ship",
      text: "Ship",
      id: null,
      timestamp: Number.MAX_SAFE_INTEGER
    };

    expect(
      parseCompanionBridgeEvent(
        JSON.stringify({
          type: "companion-event",
          event: {
            event_id: event.event_id,
            type: event.type,
            choice: event.choice,
            text: event.text,
            id: event.id,
            timestamp: event.timestamp
          }
        }),
        "123-456",
        "rev-1"
      )
    ).toEqual(event);
  });

  it("accepts a durable click whose identity matches its envelope", () => {
    const event = {
      session_id: "123-456",
      revision: "rev-1",
      event_id: "browser-1",
      type: "click" as const,
      choice: "ship",
      text: "Ship",
      id: null,
      timestamp: 1
    };
    expect(
      parseCompanionBridgeEvent(
        JSON.stringify({ type: "companion-event", event }),
        event.session_id,
        event.revision
      )
    ).toEqual(event);
  });

  it.each([
    "not-json",
    JSON.stringify({ type: "other", event: {} }),
    JSON.stringify({
      type: "companion-event",
      event: {
        event_id: "x",
        type: "click",
        choice: "",
        text: "",
        id: null,
        timestamp: 1
      }
    }),
    JSON.stringify({
      type: "companion-event",
      event: {
        event_id: "x",
        type: "click",
        choice: "a",
        text: "x".repeat(8_192),
        id: null,
        timestamp: 1
      }
    }),
    JSON.stringify({
      type: "companion-event",
      event: {
        event_id: "x",
        type: "click",
        choice: "a",
        text: "",
        id: null,
        timestamp: 1.5
      }
    }),
    JSON.stringify({
      type: "companion-event",
      event: {
        event_id: "x",
        type: "click",
        choice: "a",
        text: "",
        id: null,
        timestamp: Number.MAX_SAFE_INTEGER + 1
      }
    }),
    JSON.stringify({
      type: "companion-event",
      event: {
        event_id: "x",
        type: "click",
        choice: "a",
        text: "",
        id: null,
        timestamp: Number.MAX_VALUE
      }
    }),
    JSON.stringify({
      type: "companion-event",
      event: {
        event_id: "x",
        type: "click",
        choice: "a",
        text: "",
        id: null,
        timestamp: 1,
        extra: true
      }
    })
  ])("rejects malformed or oversized bridge data %#", (data) => {
    expect(parseCompanionBridgeEvent(data, "123-456", "rev-1")).toBeNull();
  });

  it("bounds the outer bridge message in UTF-8 bytes", () => {
    expect(
      parseCompanionBridgeEvent("🙂".repeat(2_049), "123-456", "rev-1")
    ).toBeNull();
  });

  it("rejects a durable event whose embedded identity differs from its envelope", () => {
    expect(
      parseCompanionBridgeEvent(
        JSON.stringify({
          type: "companion-event",
          event: {
            session_id: "stale-session",
            revision: "stale-revision",
            event_id: "event-1",
            type: "click",
            choice: "a",
            text: "",
            id: null,
            timestamp: 1
          }
        }),
        "session-current",
        "revision-current"
      )
    ).toBeNull();
  });
});

describe("nextCompanionEventId", () => {
  it("combines a platform prefix, timestamp, and monotonic counter", () => {
    expect(nextCompanionEventId("browser", 1234, 7)).toBe("browser-1234-7");
  });
});
