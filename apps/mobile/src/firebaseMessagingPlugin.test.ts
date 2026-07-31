import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/withKannaFirebaseMessaging.js");
const { __internal } = plugin;

const mobileProjectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PluginConfig {
  name: string;
  slug: string;
  _internal?: { projectRoot: string };
  mods?: {
    ios?: Record<string, unknown>;
  };
}

describe("withKannaFirebaseMessaging internals", () => {
  it("forces static frameworks so Firebase Swift pods integrate after a clean prebuild", () => {
    const properties = __internal.applyFirebaseStaticFrameworks({
      "expo.jsEngine": "hermes"
    });

    expect(properties).toEqual({
      "expo.jsEngine": "hermes",
      "ios.useFrameworks": "static"
    });
  });

  it("is idempotent across repeated prebuilds", () => {
    const once = __internal.applyFirebaseStaticFrameworks({});
    const twice = __internal.applyFirebaseStaticFrameworks(once);

    expect(twice).toEqual({ "ios.useFrameworks": "static" });
  });

  it("registers an iOS Podfile-properties mod instead of hand-editing generated files", () => {
    const config = __internal.withFirebaseStaticFrameworks({
      name: "Kanna Staging",
      slug: "kanna-mobile"
    }) as PluginConfig;

    expect(typeof config.mods?.ios?.podfileProperties).toBe("function");
  });

  it("keeps the iOS-only Firebase mods and the static-frameworks mod on the app config", () => {
    const config = plugin({
      name: "Kanna Staging",
      slug: "kanna-mobile",
      _internal: { projectRoot: mobileProjectRoot }
    }) as PluginConfig;

    // The upstream iOS mods register dangerous (AppDelegate patch) and
    // xcodeproj (GoogleService plist) mods, and withFirebaseStaticFrameworks
    // adds the podfileProperties mod; no Android mods may be registered
    // because there is no Android Firebase app.
    expect(Object.keys(config.mods ?? {})).toEqual(["ios"]);
    expect(Object.keys(config.mods?.ios ?? {}).sort()).toEqual([
      "dangerous",
      "podfileProperties",
      "xcodeproj"
    ]);
  });
});
