import { describe, expect, it } from "vitest";
import { resolveAccountPortalUrl } from "./mobileEnvironment";

describe("resolveAccountPortalUrl", () => {
  it("uses the staging portal for dev and staging builds", () => {
    expect(resolveAccountPortalUrl("dev")).toBe(
      "https://kanna-staging-account.web.app/subscribe"
    );
    expect(resolveAccountPortalUrl("staging")).toBe(
      "https://kanna-staging-account.web.app/subscribe"
    );
  });

  it("uses the production portal for production and legacy builds", () => {
    expect(resolveAccountPortalUrl("prod")).toBe(
      "https://kanna-build-account.web.app/subscribe"
    );
    expect(resolveAccountPortalUrl(undefined)).toBe(
      "https://kanna-build-account.web.app/subscribe"
    );
  });
});
