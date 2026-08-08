import { describe, expect, it } from "vitest";
import {
  relayStartupReportedListening,
  targetNeedsPlaywrightChromium,
  targetNeedsIsolatedAgentProviders,
  targetNeedsEmulators,
  targetNeedsRelay,
  targetNeedsRelayControl,
  targetNeedsSecondaryInstance,
  resolveRelayControlOperation,
  shouldStartInitialInstances,
} from "./runPlan";

describe("shouldStartInitialInstances", () => {
  it("does not prestart an app before a real target", () => {
    expect(shouldStartInitialInstances("tests/e2e/real/auth-indexeddb-fallback.test.ts")).toBe(false);
  });

  it("prestarts an app before a mock target", () => {
    expect(shouldStartInitialInstances("tests/e2e/mock/app-launch.test.ts")).toBe(true);
  });
});

describe("remote visual companion runner plan", () => {
  const target = "tests/e2e/real/remote-visual-companion.test.ts";

  it("starts both desktop instances", () => {
    expect(targetNeedsSecondaryInstance(target)).toBe(true);
  });

  it("isolates real agent providers so the non-returning fixture setup cannot launch one", () => {
    expect(targetNeedsIsolatedAgentProviders(target)).toBe(true);
  });

  it("starts Firebase emulators and the relay", () => {
    expect(targetNeedsEmulators(target)).toBe(true);
    expect(targetNeedsRelay(target)).toBe(true);
    expect(targetNeedsRelayControl(target)).toBe(true);
  });

  it("requires the local Playwright Chromium preflight only for this target", () => {
    expect(targetNeedsPlaywrightChromium(target)).toBe(true);
    expect(targetNeedsPlaywrightChromium(
      "tests/e2e/real/cloud-task-sync.test.ts",
    )).toBe(false);
  });

  it("requires an unguessable exact capability and POST for relay lifecycle control", () => {
    const capability = "a".repeat(48);
    expect(resolveRelayControlOperation(
      "POST",
      `/${capability}/disconnect`,
      capability,
    )).toBe("disconnect");
    expect(resolveRelayControlOperation(
      "POST",
      `/${capability}/reconnect`,
      capability,
    )).toBe("reconnect");
    expect(resolveRelayControlOperation(
      "GET",
      `/${capability}/disconnect`,
      capability,
    )).toBeNull();
    expect(resolveRelayControlOperation(
      "POST",
      `/${"b".repeat(48)}/disconnect`,
      capability,
    )).toBeNull();
  });

  it("does not accept stale relay health without the new child listener marker", () => {
    expect(relayStartupReportedListening(
      "$ tsx src/index.ts\n",
      48121,
    )).toBe(false);
    expect(relayStartupReportedListening(
      "$ tsx src/index.ts\n[relay] Listening on port 48121\n",
      48121,
    )).toBe(true);
    expect(relayStartupReportedListening(
      "[relay] Listening on port 48120\n",
      48121,
    )).toBe(false);
  });
});
