import { describe, expect, it } from "vitest";
import * as firebaseFunctions from "../src/index";
import { buildPairingArtifacts } from "../src/pairing";
import { emulatorPorts } from "../src/types";

describe("firebase functions exports", () => {
  it("does not export createPairingCode as a deployable Cloud Function", () => {
    expect(firebaseFunctions).not.toHaveProperty("createPairingCode");
  });
});

describe("firebase emulator configuration", () => {
  it("exposes the expected emulator ports for auth, firestore, and functions", () => {
    expect(emulatorPorts).toEqual({
      auth: 9099,
      firestore: 8080,
      functions: 5001,
    });
  });
});

describe("buildPairingArtifacts", () => {
  it("builds a pending pairing record, desktop record, and desktop response from fixed inputs", () => {
    const now = new Date("2026-04-19T00:00:00.000Z");

    const artifacts = buildPairingArtifacts({
      desktopDisplayName: "Studio Mac",
      now,
      expiresInMs: 5 * 60 * 1000,
      pairingCode: "ABC123",
      pairingCodeId: "pairing-code-1",
      desktopId: "desktop-1",
      desktopSecret: "desktop-secret-1",
      desktopClaimToken: "claim-token-1",
    });

    expect(artifacts.response).toEqual({
      pairingCode: "ABC123",
      pairingCodeId: "pairing-code-1",
      desktopId: "desktop-1",
      desktopSecret: "desktop-secret-1",
      desktopClaimToken: "claim-token-1",
      expiresAt: "2026-04-19T00:05:00.000Z",
    });

    expect(artifacts.pairingRecord).toEqual({
      desktopId: "desktop-1",
      desktopDisplayName: "Studio Mac",
      desktopClaimTokenHash:
        "fe628665630a347f9df9e91070c8ea2295292a6ebe7fe100cd0853bbea07c4ea",
      createdAt: "2026-04-19T00:00:00.000Z",
      expiresAt: "2026-04-19T00:05:00.000Z",
      status: "pending",
      claimedByUid: null,
      claimedAt: null,
    });

    expect(artifacts.desktopRecord).toEqual({
      desktopId: "desktop-1",
      displayName: "Studio Mac",
      desktopSecret: "desktop-secret-1",
      lastSeenAt: null,
      pairingCodeId: "pairing-code-1",
      revokedAt: null,
    });
  });
});
