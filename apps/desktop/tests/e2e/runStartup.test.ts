import { describe, expect, it } from "vitest";
import {
  advanceAppStartupDeadline,
  classifyAppStartup,
  describeAppStartupFailure,
} from "./runStartup";

const DEV_URL = "http://localhost:25000";

describe("classifyAppStartup", () => {
  it("is ready once the app hook reports ready", () => {
    expect(
      classifyAppStartup({ webdriverReady: true, url: `${DEV_URL}/`, appReady: true }, DEV_URL),
    ).toBe("ready");
  });

  it("waits while the app is still building", () => {
    expect(classifyAppStartup({ webdriverReady: false, url: null, appReady: false }, DEV_URL)).toBe(
      "booting",
    );
  });

  it("waits while the right page is still booting its JavaScript", () => {
    expect(
      classifyAppStartup({ webdriverReady: true, url: `${DEV_URL}/`, appReady: false }, DEV_URL),
    ).toBe("booting");
  });

  it("flags a window stuck on about:blank", () => {
    expect(
      classifyAppStartup({ webdriverReady: true, url: "about:blank", appReady: false }, DEV_URL),
    ).toBe("wrong-url");
  });

  it("flags a window loaded from another run's dev server", () => {
    expect(
      classifyAppStartup(
        { webdriverReady: true, url: "http://localhost:25500/", appReady: false },
        DEV_URL,
      ),
    ).toBe("wrong-url");
  });
});

describe("describeAppStartupFailure", () => {
  it("names both URLs and points at the compiled-in devUrl for a wrong URL", () => {
    const message = describeAppStartupFailure({
      baseUrl: "http://127.0.0.1:25001",
      expectedUrl: DEV_URL,
      probe: { webdriverReady: true, url: "about:blank", appReady: false },
      reason: "wrong-url",
      paneLog: "Running `.build/debug/kanna-desktop`",
    });

    expect(message).toContain("about:blank");
    expect(message).toContain(DEV_URL);
    expect(message).toContain("dev_url.rs");
    expect(message).toContain("Running `.build/debug/kanna-desktop`");
  });

  it("distinguishes a build that never produced a running app", () => {
    const message = describeAppStartupFailure({
      baseUrl: "http://127.0.0.1:25001",
      expectedUrl: DEV_URL,
      probe: { webdriverReady: false, url: null, appReady: false },
      reason: "timeout",
    });

    expect(message).toContain("timed out waiting for app");
    expect(message).toContain("WebDriver never answered");
  });
});

describe("advanceAppStartupDeadline", () => {
  it("does not charge a cold build against the app boot timeout", () => {
    const building = { deadline: 10_000, webdriverObserved: false };
    expect(
      advanceAppStartupDeadline(
        building,
        { webdriverReady: false, url: null, appReady: false },
        9_500,
        2_000,
      ),
    ).toEqual(building);

    expect(
      advanceAppStartupDeadline(
        building,
        { webdriverReady: true, url: DEV_URL, appReady: false },
        9_500,
        2_000,
      ),
    ).toEqual({ deadline: 11_500, webdriverObserved: true });
  });

  it("only resets the deadline for the first WebDriver response", () => {
    const booting = { deadline: 11_500, webdriverObserved: true };
    expect(
      advanceAppStartupDeadline(
        booting,
        { webdriverReady: true, url: DEV_URL, appReady: false },
        11_000,
        2_000,
      ),
    ).toEqual(booting);
  });
});
