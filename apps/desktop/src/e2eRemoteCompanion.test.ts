import { beforeEach, describe, expect, it } from "vitest";
import {
  captureRemoteCompanionOpenForE2E,
  createE2ERemoteCompanionApi,
  observeRemoteCompanionStatusForE2E,
  recordRemoteCompanionOpenerForE2E,
} from "./e2eRemoteCompanion";

const FIRST_OWNER = {
  ownerDesktopId: "desktop:a",
  ownerTaskId: "task:shared",
} as const;
const SECOND_OWNER = {
  ownerDesktopId: "desktop:b",
  ownerTaskId: "task:shared",
} as const;

describe("remote companion E2E boundary", () => {
  beforeEach(() => {
    window.__KANNA_E2E__ = {
      remoteCompanion: createE2ERemoteCompanionApi(),
    } as Window["__KANNA_E2E__"];
  });

  it("does not expose a callback that can bypass the actual terminal link handler", () => {
    expect(window.__KANNA_E2E__?.remoteCompanion).not.toHaveProperty("activate");
  });

  it("captures exactly one explicitly armed open without cross-desktop collisions", () => {
    const hook = window.__KANNA_E2E__?.remoteCompanion;
    hook?.captureNextOpen(FIRST_OWNER);

    expect(captureRemoteCompanionOpenForE2E({
      ...SECOND_OWNER,
      sessionId: "session-b",
      revision: "revision-b",
      status: "available",
      entryUrl:
        `http://${"b".repeat(32)}.localhost:4312/?cap=${"2".repeat(32)}`,
    })).toBe(false);
    expect(hook?.snapshot(SECOND_OWNER)).toBeNull();

    const firstEntryUrl =
      `http://${"a".repeat(32)}.localhost:4312/?cap=${"1".repeat(32)}`;
    expect(captureRemoteCompanionOpenForE2E({
      ...FIRST_OWNER,
      sessionId: "session-a",
      revision: "revision-a",
      status: "available",
      entryUrl: firstEntryUrl,
    })).toBe(true);
    expect(hook?.snapshot(FIRST_OWNER)).toEqual({
      ...FIRST_OWNER,
      sessionId: "session-a",
      revision: "revision-a",
      status: "available",
      entryUrl: firstEntryUrl,
      openerAttempt: 0,
      openerOutcome: null,
    });

    expect(captureRemoteCompanionOpenForE2E({
      ...FIRST_OWNER,
      sessionId: "session-a",
      revision: "revision-b",
      status: "available",
      entryUrl:
        `http://${"c".repeat(32)}.localhost:4312/?cap=${"3".repeat(32)}`,
    })).toBe(false);
    expect(hook?.snapshot(FIRST_OWNER)?.entryUrl).toBe(firstEntryUrl);
  });

  it("publishes only sanitized owner, session, revision, and lifecycle metadata", () => {
    const hook = window.__KANNA_E2E__?.remoteCompanion;
    observeRemoteCompanionStatusForE2E({
      ...FIRST_OWNER,
      sessionId: "session-a",
      revision: "revision-a",
      status: "reconnecting",
    });

    const snapshot = hook?.snapshot(FIRST_OWNER);
    expect(snapshot).toEqual({
      ...FIRST_OWNER,
      sessionId: "session-a",
      revision: "revision-a",
      status: "reconnecting",
      entryUrl: null,
      openerAttempt: 0,
      openerOutcome: null,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /documentHtml|assets|events|cookies|cap=/,
    );
  });

  it("records a sanitized successful OS opener boundary without exposing its capability URL", () => {
    const hook = window.__KANNA_E2E__?.remoteCompanion;
    observeRemoteCompanionStatusForE2E({
      ...FIRST_OWNER,
      sessionId: "session-a",
      revision: "revision-a",
      status: "available",
    });

    const attempt = recordRemoteCompanionOpenerForE2E({
      ...FIRST_OWNER,
      outcome: "pending",
    });
    expect(attempt).toBe(1);
    expect(hook?.snapshot(FIRST_OWNER)).toEqual({
      ...FIRST_OWNER,
      sessionId: "session-a",
      revision: "revision-a",
      status: "available",
      entryUrl: null,
      openerAttempt: 1,
      openerOutcome: "pending",
    });

    recordRemoteCompanionOpenerForE2E({
      ...FIRST_OWNER,
      attempt,
      outcome: "success",
    });
    const snapshot = hook?.snapshot(FIRST_OWNER);
    expect(snapshot?.openerAttempt).toBe(1);
    expect(snapshot?.openerOutcome).toBe("success");
    expect(JSON.stringify(snapshot)).not.toMatch(/capability|localhost|entryUrl":"http/);
  });

  it("does nothing unless the development hook is installed", () => {
    delete window.__KANNA_E2E__;
    expect(captureRemoteCompanionOpenForE2E({
      ...FIRST_OWNER,
      sessionId: "session-a",
      revision: "revision-a",
      status: "available",
      entryUrl:
        `http://${"a".repeat(32)}.localhost:4312/?cap=${"1".repeat(32)}`,
    })).toBe(false);
  });
});
