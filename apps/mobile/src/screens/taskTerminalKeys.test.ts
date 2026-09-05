import { describe, expect, it } from "vitest";
import {
  TASK_TERMINAL_KEYS,
  taskTerminalInputDisabledReason
} from "./taskTerminalKeys";

describe("mobile terminal keys", () => {
  it("maps every key to exact terminal bytes and its coordination kind", () => {
    expect(
      TASK_TERMINAL_KEYS.map(({ id, dataB64, kind }) => ({
        id,
        bytes: [...Buffer.from(dataB64, "base64")],
        kind
      }))
    ).toEqual([
      { id: "escape", bytes: [0x1b], kind: "draft" },
      { id: "up", bytes: [0x1b, 0x5b, 0x41], kind: "control" },
      { id: "down", bytes: [0x1b, 0x5b, 0x42], kind: "control" },
      { id: "left", bytes: [0x1b, 0x5b, 0x44], kind: "control" },
      { id: "right", bytes: [0x1b, 0x5b, 0x43], kind: "control" },
      { id: "tab", bytes: [0x09], kind: "draft" },
      { id: "enter", bytes: [0x0d], kind: "submission" },
      { id: "ctrl-c", bytes: [0x03], kind: "draft" }
    ]);
  });

  it("explains every unavailable state and enables only a null state", () => {
    expect(taskTerminalInputDisabledReason(null)).toBeNull();
    expect(taskTerminalInputDisabledReason("connecting")).toMatch(/connection/i);
    expect(taskTerminalInputDisabledReason("authentication_required")).toMatch(/pair/i);
    expect(taskTerminalInputDisabledReason("capability_required")).toMatch(/update/i);
    expect(taskTerminalInputDisabledReason("terminal_detached")).toMatch(/attached/i);
  });
});
