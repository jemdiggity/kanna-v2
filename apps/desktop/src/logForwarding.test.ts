import { describe, expect, it } from "vitest";
import { AppError } from "./appError";
import { formatLogArgument } from "./logForwarding";

describe("formatLogArgument", () => {
  it("includes error message and code for AppError instances", () => {
    const error = new AppError("worktree failed", "permission_denied");

    expect(formatLogArgument(error)).toContain("AppError: worktree failed code=permission_denied");
  });

  it("serializes plain objects as JSON", () => {
    expect(formatLogArgument({ status: "ok" })).toBe('{"status":"ok"}');
  });

  it("serializes circular objects and bigint values without throwing", () => {
    const value: { count: bigint; self?: unknown } = { count: 2n };
    value.self = value;

    expect(formatLogArgument(value)).toBe('{"count":"2","self":"[Circular]"}');
  });
});
