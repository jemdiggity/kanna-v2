import { describe, expect, it } from "vitest";
import {
  getMobileInstallLink,
  isConfiguredMobileInstallLink,
  MOBILE_INSTALL_LINKS,
  normalizeMobileInstallEnvironment,
} from "./mobileInstallLinks";

describe("mobile install links", () => {
  it.each([
    ["development", "dev"],
    ["dev", "dev"],
    ["staging", "staging"],
    ["production", "production"],
    ["prod", "production"],
  ])("normalizes %s as %s", (raw, expected) => {
    expect(normalizeMobileInstallEnvironment(raw)).toBe(expected);
  });

  it("does not guess an environment or treat placeholders as links", () => {
    expect(normalizeMobileInstallEnvironment("unknown")).toBeNull();
    expect(isConfiguredMobileInstallLink(MOBILE_INSTALL_LINKS.production)).toBe(false);
    expect(getMobileInstallLink("production")).toBeNull();
  });

  it("returns only a configured HTTPS link from the typed environment map", () => {
    const original = MOBILE_INSTALL_LINKS.production;
    MOBILE_INSTALL_LINKS.production = "https://apps.apple.com/app/kanna";
    try {
      expect(getMobileInstallLink("production")).toBe("https://apps.apple.com/app/kanna");
    } finally {
      MOBILE_INSTALL_LINKS.production = original;
    }
  });
});
