import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AnonymousPushRefusal,
  anonymousAuthPayload,
  consumePairingRequestLimit,
  validateAnonymousPushPairing,
  verifyAnonymousSignature,
} from "./anonymousPush.js";

function identity() {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: keys.privateKey,
    publicKey: Buffer.from(spki).subarray(-32).toString("base64url"),
  };
}

describe("anonymous push trust", () => {
  it("verifies the exact desktop certificate format emitted by kanna-server", () => {
    const keys = identity();
    const deviceId = "phone-1";
    const issuedAt = 1_000;
    const expiresAt = issuedAt + 730 * 24 * 60 * 60_000;
    const payload = Buffer.concat([
      Buffer.from("kanna.push-pairing-cert.v1\0", "utf8"),
      Buffer.from(JSON.stringify({ deviceId, issuedAt, expiresAt }), "utf8"),
    ]);
    const signature = sign(null, payload, keys.privateKey).toString("base64url");

    expect(validateAnonymousPushPairing({
      desktopPubKey: keys.publicKey,
      deviceId,
      fcmToken: "fcm-token",
      cert: { deviceId, issuedAt, expiresAt, signature },
    }, 2_000)).toMatchObject({ desktopPubKey: keys.publicKey, deviceId });
  });

  it("rejects an expired or differently signed pairing claim", () => {
    const keys = identity();
    const other = identity();
    const deviceId = "phone-1";
    const issuedAt = 1_000;
    const expiresAt = 2_000;
    const payload = Buffer.concat([
      Buffer.from("kanna.push-pairing-cert.v1\0", "utf8"),
      Buffer.from(JSON.stringify({ deviceId, issuedAt, expiresAt }), "utf8"),
    ]);
    const signature = sign(null, payload, other.privateKey).toString("base64url");
    expect(() => validateAnonymousPushPairing({
      desktopPubKey: keys.publicKey,
      deviceId,
      fcmToken: "fcm-token",
      cert: { deviceId, issuedAt, expiresAt, signature },
    }, 1_500)).toThrow(AnonymousPushRefusal);
    expect(() => validateAnonymousPushPairing({
      desktopPubKey: keys.publicKey,
      deviceId,
      fcmToken: "fcm-token",
      cert: { deviceId, issuedAt, expiresAt, signature },
    }, 2_001)).toThrow(AnonymousPushRefusal);
  });

  it("binds challenge proofs to the relay nonce", () => {
    const keys = identity();
    const firstNonce = Buffer.alloc(32, 1).toString("base64url");
    const secondNonce = Buffer.alloc(32, 2).toString("base64url");
    const signature = sign(null, anonymousAuthPayload(firstNonce), keys.privateKey)
      .toString("base64url");
    expect(verifyAnonymousSignature(
      keys.publicKey,
      anonymousAuthPayload(firstNonce),
      signature,
    )).toBe(true);
    expect(verifyAnonymousSignature(
      keys.publicKey,
      anonymousAuthPayload(secondNonce),
      signature,
    )).toBe(false);
  });

  it("refuses an IP after the registration burst", () => {
    const address = `registration-limit-${Date.now()}`;
    for (let index = 0; index < 30; index += 1) {
      expect(consumePairingRequestLimit(address, "POST", 10_000)).toBe(true);
    }
    expect(consumePairingRequestLimit(address, "POST", 10_000)).toBe(false);
  });

  it("independently refuses DELETE requests at the configured per-IP bound", () => {
    const address = `deletion-limit-${Date.now()}`;
    for (let index = 0; index < 30; index += 1) {
      expect(consumePairingRequestLimit(address, "DELETE", 10_000)).toBe(true);
    }
    expect(consumePairingRequestLimit(address, "DELETE", 10_000)).toBe(false);
  });
});
