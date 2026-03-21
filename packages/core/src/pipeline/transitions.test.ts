import { describe, it, expect } from "vitest";
import { canTransition, getTransition } from "./transitions.js";

describe("canTransition", () => {
  it("allows in_progress → pr", () => {
    expect(canTransition("in_progress", "pr")).toBe(true);
  });

  it("allows in_progress → done", () => {
    expect(canTransition("in_progress", "done")).toBe(true);
  });

  it("allows pr → done", () => {
    expect(canTransition("pr", "done")).toBe(true);
  });

  it("rejects pr → in_progress (backward)", () => {
    expect(canTransition("pr", "in_progress")).toBe(false);
  });

  it("rejects done → in_progress (terminal)", () => {
    expect(canTransition("done", "in_progress")).toBe(false);
  });

  it("rejects done → pr (terminal)", () => {
    expect(canTransition("done", "pr")).toBe(false);
  });
});

describe("getTransition", () => {
  it("returns transition for in_progress → pr", () => {
    expect(getTransition("in_progress", "pr")).toBeDefined();
  });

  it("returns undefined for invalid transition", () => {
    expect(getTransition("done", "pr")).toBeUndefined();
  });
});
