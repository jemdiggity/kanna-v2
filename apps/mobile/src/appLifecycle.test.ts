import { describe, expect, it } from "vitest";
import {
  getForegroundTransitionAction,
  shouldCheckForOtaUpdateOnForeground,
  shouldRefreshOnAppStateTransition
} from "./appLifecycle";

describe("shouldRefreshOnAppStateTransition", () => {
  it("refreshes when the app returns to the foreground", () => {
    expect(shouldRefreshOnAppStateTransition("background", "active")).toBe(true);
    expect(shouldRefreshOnAppStateTransition("inactive", "active")).toBe(true);
  });

  it("does not refresh for non-foreground transitions", () => {
    expect(shouldRefreshOnAppStateTransition("active", "inactive")).toBe(false);
    expect(shouldRefreshOnAppStateTransition("active", "background")).toBe(false);
    expect(shouldRefreshOnAppStateTransition("background", "background")).toBe(false);
  });
});

describe("getForegroundTransitionAction", () => {
  it.each([
    ["background", "active"],
    ["inactive", "active"]
  ] as const)(
    "refreshes for a normal %s -> %s foreground transition",
    (previousState, nextState) => {
      expect(
        getForegroundTransitionAction({
          previousState,
          nextState,
          hasDownloadedUpdate: false
        })
      ).toBe("refresh");
    }
  );

  it("reloads a downloaded update on the exact background -> active transition", () => {
    expect(
      getForegroundTransitionAction({
        previousState: "background",
        nextState: "active",
        hasDownloadedUpdate: true
      })
    ).toBe("reload");
  });

  it("preserves refresh behavior for downloaded updates returning from inactive", () => {
    expect(
      getForegroundTransitionAction({
        previousState: "inactive",
        nextState: "active",
        hasDownloadedUpdate: true
      })
    ).toBe("refresh");
  });

  it("does nothing for a non-foreground transition", () => {
    expect(
      getForegroundTransitionAction({
        previousState: "active",
        nextState: "background",
        hasDownloadedUpdate: false
      })
    ).toBe("none");
  });
});

describe("shouldCheckForOtaUpdateOnForeground", () => {
  it("checks on foreground when no prior check has run", () => {
    expect(
      shouldCheckForOtaUpdateOnForeground({
        previousState: "background",
        nextState: "active",
        nowMs: 1_000,
        lastCheckAtMs: null,
        throttleMs: 300_000
      })
    ).toBe(true);
  });

  it("throttles foreground checks within the configured interval", () => {
    expect(
      shouldCheckForOtaUpdateOnForeground({
        previousState: "background",
        nextState: "active",
        nowMs: 100_000,
        lastCheckAtMs: 10_000,
        throttleMs: 300_000
      })
    ).toBe(false);
  });

  it("checks again after the throttle interval has elapsed", () => {
    expect(
      shouldCheckForOtaUpdateOnForeground({
        previousState: "inactive",
        nextState: "active",
        nowMs: 400_000,
        lastCheckAtMs: 90_000,
        throttleMs: 300_000
      })
    ).toBe(true);
  });
});
