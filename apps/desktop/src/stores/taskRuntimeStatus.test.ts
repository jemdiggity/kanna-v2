import { describe, expect, it } from "vitest";
import { resolveActivityForRuntimeStatus } from "./taskRuntimeStatus";

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
