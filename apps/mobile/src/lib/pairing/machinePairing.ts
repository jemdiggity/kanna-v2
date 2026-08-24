import type { PairingClaimRequest, PairingClaimResponse } from "../api/types";
import type { BonjourBrowser, BonjourService } from "../discovery/bonjour";
import type { FetchLike } from "../transports/lanTransport";
import type { TrustedDesktopRecord } from "../../state/sessionPersistence";
import {
  normalizePairingCode,
  parseMachinePairingPayload
} from "./pairingPayload";

export type MachinePairingFailure =
  | "invalid-code"
  | "expired"
  | "rate-limited"
  | "not-found"
  | "multiple-matches"
  | "identity-mismatch"
  | "unreachable";

export class MachinePairingError extends Error {
  constructor(
    public readonly reason: MachinePairingFailure,
    message: string
  ) {
    super(message);
    this.name = "MachinePairingError";
  }
}

export interface MobileDeviceIdentity {
  deviceId: string;
  deviceName: string;
}

export interface MachinePairingService {
  claimPayload(rawPayload: string): Promise<TrustedDesktopRecord>;
  claimCode(code: string): Promise<TrustedDesktopRecord>;
}

export function createMachinePairingService(input: {
  bonjourBrowser: BonjourBrowser;
  fetchImpl: FetchLike;
  getDeviceIdentity(): MobileDeviceIdentity;
  claimTimeoutMs?: number;
  now?: () => Date;
}): MachinePairingService {
  const now = input.now ?? (() => new Date());
  const claimTimeoutMs = input.claimTimeoutMs ?? 5_000;

  async function claimCandidates(
    code: string,
    candidates: readonly BonjourService[],
    claimMode: "payload" | "code"
  ): Promise<TrustedDesktopRecord> {
    if (candidates.length === 0) {
      throw pairingError("not-found");
    }

    const settled = await Promise.allSettled(
      candidates.map((candidate) => claimCandidate({
        candidate,
        code,
        deviceIdentity: input.getDeviceIdentity(),
        fetchImpl: input.fetchImpl,
        timeoutMs: claimTimeoutMs,
        now
      }))
    );
    const successes = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );

    if (successes.length === 1) {
      return successes[0];
    }
    if (successes.length > 1) {
      throw pairingError("multiple-matches");
    }

    const failures = settled.flatMap((result) =>
      result.status === "rejected" && result.reason instanceof MachinePairingError
        ? [result.reason.reason]
        : ["unreachable" as const]
    );
    if (failures.includes("rate-limited")) throw pairingError("rate-limited");
    if (failures.includes("expired")) throw pairingError("expired");
    if (failures.includes("identity-mismatch")) throw pairingError("identity-mismatch");
    if (failures.every((failure) => failure === "unreachable")) {
      throw pairingError("unreachable");
    }
    if (claimMode === "payload" && failures.includes("unreachable")) {
      throw pairingError("unreachable");
    }
    throw pairingError("not-found");
  }

  return {
    async claimPayload(rawPayload) {
      const payload = parseMachinePairingPayload(rawPayload);
      const candidates = input.bonjourBrowser.getServices().filter(
        (service) => desktopIdsEqual(service.txt.desktopId, payload.desktopId)
      );
      return claimCandidates(payload.code, candidates, "payload");
    },

    async claimCode(rawCode) {
      const code = normalizePairingCode(rawCode);
      if (!/^[0-9A-F]{6}$/.test(code)) {
        throw pairingError("invalid-code");
      }
      const candidates = input.bonjourBrowser.getServices().filter(
        (service) => typeof service.txt.desktopId === "string" && service.txt.desktopId.trim()
      );
      return claimCandidates(code, candidates, "code");
    }
  };
}

async function claimCandidate(input: {
  candidate: BonjourService;
  code: string;
  deviceIdentity: MobileDeviceIdentity;
  fetchImpl: FetchLike;
  timeoutMs: number;
  now(): Date;
}): Promise<TrustedDesktopRecord> {
  const desktopId = input.candidate.txt.desktopId;
  const baseUrl = `http://${input.candidate.host}:${input.candidate.port}`;
  const body: PairingClaimRequest = {
    code: input.code,
    deviceId: input.deviceIdentity.deviceId,
    deviceName: input.deviceIdentity.deviceName
  };

  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let response;
  try {
    response = await Promise.race([
      input.fetchImpl(`${baseUrl}/v1/pairing/sessions/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortController.signal
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(pairingError("unreachable"));
        }, input.timeoutMs);
      })
    ]);
  } catch (error) {
    if (error instanceof MachinePairingError) throw error;
    throw pairingError("unreachable");
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 410) throw pairingError("expired");
    if (response.status === 429) throw pairingError("rate-limited");
    if (response.status === 400 || response.status === 409) {
      throw pairingError("not-found");
    }
    throw pairingError("unreachable");
  }

  let claim: PairingClaimResponse;
  try {
    claim = await response.json() as PairingClaimResponse;
  } catch {
    throw pairingError("unreachable");
  }
  if (
    !claim ||
    typeof claim.desktopId !== "string" ||
    typeof claim.desktopName !== "string" ||
    !desktopIdsEqual(claim.desktopId, desktopId)
  ) {
    throw pairingError("identity-mismatch");
  }

  const lastSeenAt = input.now().toISOString();
  return {
    desktopId: claim.desktopId,
    displayName: claim.desktopName,
    lanEndpoints: [{ baseUrl, lastSeenAt }],
    lastSeenAt,
    ...(typeof claim.deviceSecret === "string" && claim.deviceSecret
      ? { deviceSecret: claim.deviceSecret }
      : {})
  };
}

function desktopIdsEqual(left: string, right: string): boolean {
  return left.toUpperCase() === right.toUpperCase();
}

function pairingError(reason: MachinePairingFailure): MachinePairingError {
  const messages: Record<MachinePairingFailure, string> = {
    "invalid-code": "Enter the six-character pairing code shown on the desktop.",
    expired: "That pairing session expired. Start a new one on the desktop.",
    "rate-limited": "Too many attempts. Start a new pairing session on the desktop.",
    "not-found": "No machine on this network accepted that pairing code.",
    "multiple-matches": "More than one machine accepted that code. Start a new pairing session.",
    "identity-mismatch": "The machine identity did not match its network advertisement.",
    unreachable: "The machine could not be reached. Check that both apps are on the same network."
  };
  return new MachinePairingError(reason, messages[reason]);
}
