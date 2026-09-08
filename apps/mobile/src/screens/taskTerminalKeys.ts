import type {
  TaskTerminalInputKind,
  TaskTerminalInputUnavailableReason
} from "../lib/api/client";

export type TaskTerminalKeyId =
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "tab"
  | "enter"
  | "ctrl-c";

export interface TaskTerminalKey {
  id: TaskTerminalKeyId;
  label: string;
  dataB64: string;
  kind: TaskTerminalInputKind;
}

export const TASK_TERMINAL_KEYS: readonly TaskTerminalKey[] = [
  { id: "escape", label: "Esc", dataB64: "Gw==", kind: "draft" },
  // Up/down can recall history into a composer, so they must pass through the
  // daemon's draft-byte classifier. That classifier leaves a harmless recall
  // unlatched once the rendered composer proves it stayed empty.
  { id: "up", label: "↑", dataB64: "G1tB", kind: "draft" },
  { id: "down", label: "↓", dataB64: "G1tC", kind: "draft" },
  { id: "left", label: "←", dataB64: "G1tE", kind: "control" },
  { id: "right", label: "→", dataB64: "G1tD", kind: "control" },
  { id: "tab", label: "Tab", dataB64: "CQ==", kind: "draft" },
  { id: "enter", label: "Enter", dataB64: "DQ==", kind: "submission" },
  { id: "ctrl-c", label: "Ctrl-C", dataB64: "Aw==", kind: "draft" }
];

export function taskTerminalInputDisabledReason(
  reason: TaskTerminalInputUnavailableReason | null
): string | null {
  switch (reason) {
    case null:
      return null;
    case "connecting":
      return "Terminal keys will be available when the desktop connection is ready.";
    case "authentication_required":
      return "Pair this phone again to enable terminal keys.";
    case "capability_required":
      return "Update Kanna on the desktop to enable terminal keys.";
    case "terminal_detached":
      return "Terminal keys need an attached desktop terminal.";
  }
}
