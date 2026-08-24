export interface MachinePairingPayload {
  desktopId: string;
  code: string;
}

export type PairingPayloadFailure = "invalid" | "unsupported-version";

export class PairingPayloadError extends Error {
  constructor(
    public readonly reason: PairingPayloadFailure,
    message: string
  ) {
    super(message);
    this.name = "PairingPayloadError";
  }
}

export function normalizePairingCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function parseMachinePairingPayload(raw: string): MachinePairingPayload {
  const trimmed = raw.trim();
  if (trimmed.startsWith("KANNA1:")) {
    return parseCompactPayload(trimmed);
  }
  if (/^KANNA\d+:/.test(trimmed)) {
    throw new PairingPayloadError(
      "unsupported-version",
      "This pairing code was made by an incompatible version of Kanna."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new PairingPayloadError("invalid", "This is not a Kanna machine pairing code.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new PairingPayloadError("invalid", "This is not a Kanna machine pairing code.");
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.type !== "kanna.machine-pairing") {
    throw new PairingPayloadError("invalid", "This is not a Kanna machine pairing code.");
  }
  if (candidate.version !== 1) {
    throw new PairingPayloadError(
      "unsupported-version",
      "This pairing code was made by an incompatible version of Kanna."
    );
  }

  const desktopId = typeof candidate.desktopId === "string"
    ? candidate.desktopId.trim()
    : "";
  const code = typeof candidate.code === "string"
    ? normalizePairingCode(candidate.code)
    : "";
  if (!desktopId || !/^[0-9A-F]{6}$/.test(code)) {
    throw new PairingPayloadError("invalid", "This Kanna machine pairing code is incomplete.");
  }

  return { desktopId, code };
}

function parseCompactPayload(raw: string): MachinePairingPayload {
  const fields = raw.slice("KANNA1:".length).split(":");
  if (fields.length !== 2) {
    throw new PairingPayloadError("invalid", "This Kanna machine pairing code is incomplete.");
  }

  const desktopId = fields[0]?.trim() ?? "";
  const code = normalizePairingCode(fields[1] ?? "");
  if (!desktopId || !/^[0-9A-F]{6}$/.test(code)) {
    throw new PairingPayloadError("invalid", "This Kanna machine pairing code is incomplete.");
  }
  return { desktopId, code };
}
