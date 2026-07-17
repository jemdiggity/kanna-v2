import { describe, expect, it } from "vitest";
import {
  normalizePairingCode,
  parseMachinePairingPayload
} from "./pairingPayload";

describe("parseMachinePairingPayload", () => {
  it("accepts the version-one desktop identity and code", () => {
    expect(parseMachinePairingPayload(JSON.stringify({
      type: "kanna.machine-pairing",
      version: 1,
      desktopId: "desktop-1",
      code: "abc123"
    }))).toEqual({ desktopId: "desktop-1", code: "ABC123" });
  });

  it.each([
    ["not-json", "invalid"],
    [JSON.stringify({ type: "other", version: 1 }), "invalid"],
    [JSON.stringify({ type: "kanna.machine-pairing", version: 2 }), "unsupported-version"]
  ])("rejects %s", (raw, reason) => {
    expect(() => parseMachinePairingPayload(raw)).toThrowError(
      expect.objectContaining({ reason })
    );
  });

  it("rejects missing identities and malformed codes", () => {
    expect(() => parseMachinePairingPayload(JSON.stringify({
      type: "kanna.machine-pairing",
      version: 1,
      desktopId: " ",
      code: "ABC123"
    }))).toThrowError(expect.objectContaining({ reason: "invalid" }));
    expect(() => parseMachinePairingPayload(JSON.stringify({
      type: "kanna.machine-pairing",
      version: 1,
      desktopId: "desktop-1",
      code: "too-long"
    }))).toThrowError(expect.objectContaining({ reason: "invalid" }));
  });
});

describe("normalizePairingCode", () => {
  it("removes spaces and hyphens and uppercases", () => {
    expect(normalizePairingCode("ab-c 123")).toBe("ABC123");
  });
});
