type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(
  value: unknown,
  fields: readonly string[],
): UnknownRecord {
  if (!isRecord(value)) return { redacted: true };
  const safe: UnknownRecord = {};
  for (const field of fields) {
    const candidate = value[field];
    if (
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      candidate === null
    ) {
      safe[field] = candidate;
    }
  }
  return safe;
}

/**
 * Companion bridge invokes can contain complete documents, asset bytes, browser
 * capabilities, and event-derived text. E2E diagnostics need command counts and
 * routing metadata only, so every companion command is deny-by-default.
 */
export function redactE2EInvokeArgs(
  command: string,
  args: unknown,
): unknown {
  if (command.includes("transfer_peer_companion")) {
    switch (command) {
      case "observe_transfer_peer_companion":
      case "unobserve_transfer_peer_companion":
        return pick(args, ["peerId", "taskId", "generation"]);
      case "send_transfer_peer_companion_event":
        return pick(args, [
          "peerId",
          "taskId",
          "generation",
          "sessionId",
          "revision",
        ]);
      default:
        return { redacted: true };
    }
  }

  if (!command.includes("remote_companion")) return args;

  switch (command) {
    case "upsert_remote_companion_bridge":
      return pick(args, [
        "ownerDesktopId",
        "ownerTaskId",
        "sessionId",
        "revision",
      ]);
    case "set_remote_companion_bridge_state":
      return pick(args, ["bridgeId", "status", "selected"]);
    case "set_remote_companion_event_result":
      return pick(args, ["bridgeId", "sessionId", "revision", "accepted"]);
    case "close_remote_companion_bridge":
      return pick(args, ["bridgeId"]);
    default:
      return { redacted: true };
  }
}
