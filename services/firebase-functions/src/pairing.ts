import { createHash } from "node:crypto";
import type {
  DesktopRecord,
  PairingResponse,
  PairingCodeRecord,
} from "./types.js";

export interface BuildPairingArtifactsInput {
  desktopDisplayName: string;
  now: Date;
  expiresInMs: number;
  pairingCode: string;
  pairingCodeId: string;
  desktopId: string;
  desktopSecret: string;
  desktopClaimToken: string;
}

export interface PairingArtifacts {
  response: PairingResponse;
  pairingRecord: PairingCodeRecord;
  desktopRecord: DesktopRecord;
}

export function buildPairingArtifacts(
  input: BuildPairingArtifactsInput
): PairingArtifacts {
  const expiresAt = new Date(input.now.getTime() + input.expiresInMs).toISOString();
  const createdAt = input.now.toISOString();

  return {
    response: {
      pairingCode: input.pairingCode,
      pairingCodeId: input.pairingCodeId,
      desktopId: input.desktopId,
      desktopSecret: input.desktopSecret,
      desktopClaimToken: input.desktopClaimToken,
      expiresAt,
    },
    pairingRecord: {
      desktopId: input.desktopId,
      desktopDisplayName: input.desktopDisplayName,
      desktopClaimTokenHash: sha256(input.desktopClaimToken),
      createdAt,
      expiresAt,
      status: "pending",
      claimedByUid: null,
      claimedAt: null,
    },
    desktopRecord: {
      desktopId: input.desktopId,
      displayName: input.desktopDisplayName,
      desktopSecret: input.desktopSecret,
      lastSeenAt: null,
      pairingCodeId: input.pairingCodeId,
      revokedAt: null,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
