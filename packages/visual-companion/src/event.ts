import type { CompanionEvent } from "@kanna/agent-protocol";

const MAX_BRIDGE_MESSAGE_BYTES = 8 * 1024;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function isBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty = true
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    utf8ByteLength(value) <= maxBytes
  );
}

export function parseCompanionBridgeEvent(
  data: string,
  sessionId: string,
  revision: string
): CompanionEvent | null {
  if (utf8ByteLength(data) > MAX_BRIDGE_MESSAGE_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const message = parsed as Record<string, unknown>;
  if (
    !hasOnlyKeys(message, ["event", "type"]) ||
    message.type !== "companion-event" ||
    typeof message.event !== "object" ||
    message.event === null ||
    Array.isArray(message.event)
  ) {
    return null;
  }

  const event = message.event as Record<string, unknown>;
  const unboundKeys = [
    "choice",
    "event_id",
    "id",
    "text",
    "timestamp",
    "type"
  ];
  const boundKeys = [...unboundKeys, "revision", "session_id"];
  if (
    (!hasOnlyKeys(event, unboundKeys) &&
      !hasOnlyKeys(event, boundKeys)) ||
    ("session_id" in event &&
      (event.session_id !== sessionId || event.revision !== revision)) ||
    event.type !== "click" ||
    !isBoundedString(event.event_id, 128, false) ||
    !isBoundedString(event.choice, 256, false) ||
    !isBoundedString(event.text, 4 * 1024) ||
    !(event.id === null || isBoundedString(event.id, 256)) ||
    typeof event.timestamp !== "number" ||
    !Number.isSafeInteger(event.timestamp) ||
    event.timestamp < 0
  ) {
    return null;
  }

  return {
    session_id: sessionId,
    revision,
    event_id: event.event_id,
    type: "click",
    choice: event.choice,
    text: event.text,
    id: event.id,
    timestamp: event.timestamp
  };
}

export function nextCompanionEventId(
  prefix: string,
  now: number,
  counter: number
): string {
  return `${prefix}-${now}-${counter}`;
}
