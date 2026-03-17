import { describe, it, expect } from "vitest";
import { canTransition, getTransition } from "./transitions.js";

describe("canTransition", () => {
  it("allows queued → in_progress", () => {
    expect(canTransition("queued", "in_progress")).toBe(true);
  });

  it("allows in_progress → needs_review", () => {
    expect(canTransition("in_progress", "needs_review")).toBe(true);
  });

  it("allows needs_review → merged", () => {
    expect(canTransition("needs_review", "merged")).toBe(true);
  });

  it("allows needs_review → closed", () => {
    expect(canTransition("needs_review", "closed")).toBe(true);
  });

  it("allows in_progress → closed", () => {
    expect(canTransition("in_progress", "closed")).toBe(true);
  });

  it("allows queued → closed", () => {
    expect(canTransition("queued", "closed")).toBe(true);
  });

  it("rejects queued → merged (invalid)", () => {
    expect(canTransition("queued", "merged")).toBe(false);
  });

  it("rejects merged → closed (invalid)", () => {
    expect(canTransition("merged", "closed")).toBe(false);
  });

  it("rejects in_progress → queued (backward)", () => {
    expect(canTransition("in_progress", "queued")).toBe(false);
  });

  it("rejects needs_review → in_progress (backward)", () => {
    expect(canTransition("needs_review", "in_progress")).toBe(false);
  });
});

describe("getTransition", () => {
  it("returns transition with label for queued → in_progress", () => {
    const t = getTransition("queued", "in_progress");
    expect(t).toBeDefined();
    const label = t !== undefined && "label" in t ? t.label : undefined;
    expect(label).toBe("kn:wip");
  });

  it("returns transition with label for in_progress → needs_review", () => {
    const t = getTransition("in_progress", "needs_review");
    expect(t).toBeDefined();
    const label = t !== undefined && "label" in t ? t.label : undefined;
    expect(label).toBe("kn:pr-ready");
  });

  it("returns transition without label for needs_review → merged", () => {
    const t = getTransition("needs_review", "merged");
    expect(t).toBeDefined();
    // needs_review → merged has no label property
    const hasLabel = t !== undefined && "label" in t;
    expect(hasLabel).toBe(false);
  });

  it("returns undefined for invalid transition", () => {
    expect(getTransition("queued", "merged")).toBeUndefined();
  });

  it("returns undefined for merged → closed", () => {
    expect(getTransition("merged", "closed")).toBeUndefined();
  });
});
