/**
 * What the renderer still parses off the transfer sidecar: peers and pairing.
 *
 * The transfer *payload* contract — the outgoing payload, its artifact
 * contracts, the incoming-request and lifecycle-event parsers — used to live
 * here too, because the renderer was the thing that built and validated a
 * transfer. It is not any more: `kanna-server`'s transfer engine owns every one
 * of those steps, and the contract is enforced in
 * `crates/kanna-server/src/transfer_engine/payload.rs`, where both ends of the
 * wire can be checked in one place. Keeping a second copy of it here only
 * offered a copy to drift.
 *
 * Pairing stayed, because it is still a renderer flow: the operator picks a
 * machine, confirms a verification code, and both sides show progress.
 */

export interface TransferPeerOption {
  id: string;
  name: string;
  subtitle?: string;
  trusted: boolean;
  acceptingTransfers: boolean;
}

export interface PairingResult {
  peer: TransferPeerOption;
  verificationCode: string;
}

export interface PairingCompletedEvent {
  peerId: string;
  displayName: string;
  verificationCode: string;
}

export interface PairingRequestedEvent {
  requestId: string;
  peerId: string;
  displayName: string;
  verificationCode: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function readRequiredString(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  throw new Error(label);
}

function readRequiredBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  throw new Error(label);
}

function parseTransferPeer(value: unknown): TransferPeerOption | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = readRequiredString(record, ["peer_id", "peerId"], "transfer peer missing peer_id");
  const name = readRequiredString(
    record,
    ["display_name", "displayName", "name"],
    "transfer peer missing display_name",
  );
  const trusted = readRequiredBoolean(
    record,
    ["trusted"],
    "transfer peer missing trusted flag",
  );
  const acceptingTransfers = readRequiredBoolean(
    record,
    ["accepting_transfers", "acceptingTransfers"],
    "transfer peer missing accepting_transfers flag",
  );

  return {
    id,
    name,
    trusted,
    acceptingTransfers,
    subtitle: trusted ? "paired" : "not paired",
  };
}

export function parseTransferPeers(value: unknown): TransferPeerOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseTransferPeer)
    .filter((peer): peer is TransferPeerOption => peer !== null);
}

export function parsePairingResult(value: unknown): PairingResult {
  const record = asRecord(value);
  if (!record) {
    throw new Error("start_peer_pairing returned an invalid payload");
  }

  const peer = parseTransferPeer(record.peer);
  if (!peer) {
    throw new Error("start_peer_pairing response missing peer");
  }

  return {
    peer,
    verificationCode: readRequiredString(
      record,
      ["verificationCode", "verification_code"],
      "start_peer_pairing response missing verification code",
    ),
  };
}

export function parsePairingCompletedEvent(value: unknown): PairingCompletedEvent {
  const record = asRecord(value);
  if (!record) {
    throw new Error("pairing-completed event payload is invalid");
  }

  return {
    peerId: readRequiredString(record, ["peerId", "peer_id"], "pairing-completed event missing peer id"),
    displayName: readRequiredString(
      record,
      ["displayName", "display_name"],
      "pairing-completed event missing display name",
    ),
    verificationCode: readRequiredString(
      record,
      ["verificationCode", "verification_code"],
      "pairing-completed event missing verification code",
    ),
  };
}

export function parsePairingRequestedEvent(value: unknown): PairingRequestedEvent {
  const record = asRecord(value);
  if (!record) {
    throw new Error("pairing-requested event payload is invalid");
  }

  return {
    requestId: readRequiredString(
      record,
      ["requestId", "request_id"],
      "pairing-requested event missing request id",
    ),
    peerId: readRequiredString(record, ["peerId", "peer_id"], "pairing-requested event missing peer id"),
    displayName: readRequiredString(
      record,
      ["displayName", "display_name"],
      "pairing-requested event missing display name",
    ),
    verificationCode: readRequiredString(
      record,
      ["verificationCode", "verification_code"],
      "pairing-requested event missing verification code",
    ),
  };
}
