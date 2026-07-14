import { describe, expect, it } from "vitest";
import {
  resolveActivityForRuntimeStatus,
  shouldIgnoreRuntimeStatusDuringSetup,
} from "./taskRuntimeStatus";

describe("shouldIgnoreRuntimeStatusDuringSetup", () => {
  it("ignores idle while task setup is still pending", () => {
    expect(shouldIgnoreRuntimeStatusDuringSetup("idle", true)).toBe(true);
  });

  it("does not ignore busy while task setup is pending", () => {
    expect(shouldIgnoreRuntimeStatusDuringSetup("busy", true)).toBe(false);
  });

  it("does not ignore waiting while task setup is pending", () => {
    expect(shouldIgnoreRuntimeStatusDuringSetup("waiting", true)).toBe(false);
  });

  it("does not ignore idle after task setup finishes", () => {
    expect(shouldIgnoreRuntimeStatusDuringSetup("idle", false)).toBe(false);
  });
});

describe("resolveActivityForRuntimeStatus", () => {
  it("maps busy to working", () => {
    expect(resolveActivityForRuntimeStatus("idle", "busy", false)).toBe("working");
  });

  it("maps idle to idle for the selected task", () => {
    expect(resolveActivityForRuntimeStatus("working", "idle", true)).toBe("idle");
  });

  it("maps idle to unread for an unselected working task", () => {
    expect(resolveActivityForRuntimeStatus("working", "idle", false)).toBe("unread");
  });

  it("maps waiting to idle for the selected task", () => {
    expect(resolveActivityForRuntimeStatus("working", "waiting", true)).toBe("idle");
  });

  it("maps waiting to unread for an unselected working task", () => {
    expect(resolveActivityForRuntimeStatus("working", "waiting", false)).toBe("unread");
  });

  it("does not rewrite idle tasks when waiting is received for the selected task", () => {
    expect(resolveActivityForRuntimeStatus("idle", "waiting", true)).toBe(null);
  });

  it("does not rewrite idle tasks when waiting is received for an unselected task", () => {
    expect(resolveActivityForRuntimeStatus("idle", "waiting", false)).toBe(null);
  });
});
