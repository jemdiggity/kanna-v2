import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { __internal } = require("../plugins/withKannaBonjour.js");

describe("withKannaBonjour internals", () => {
  it("writes App Store-safe local network permission metadata", () => {
    const plist = __internal.applyInfoPlist({});

    expect(plist.NSBonjourServices).toEqual(["_kanna-mobile._tcp"]);
    expect(plist.NSLocalNetworkUsageDescription).toBe(
      "Kanna uses your local network to find and connect to your paired Kanna desktop app."
    );
  });

  it("deduplicates the Bonjour service and replaces stale permission copy", () => {
    const plist = __internal.applyInfoPlist({
      NSBonjourServices: ["_kanna-mobile._tcp", "_example._tcp"],
      NSLocalNetworkUsageDescription: "Old copy"
    });

    expect(plist.NSBonjourServices).toEqual([
      "_kanna-mobile._tcp",
      "_example._tcp"
    ]);
    expect(plist.NSLocalNetworkUsageDescription).toBe(
      "Kanna uses your local network to find and connect to your paired Kanna desktop app."
    );
  });
});
