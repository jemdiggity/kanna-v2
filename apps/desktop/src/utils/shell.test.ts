import { describe, expect, it } from "vitest";
import { shellSingleQuote } from "./shell";

describe("shellSingleQuote", () => {
  it("wraps values in single quotes", () => {
    expect(shellSingleQuote("Ship it")).toBe("'Ship it'");
  });

  it("escapes embedded single quotes with the zsh-safe quote idiom", () => {
    const value = "don't stop 'til it works";
    const escaped = value.replace(/'/g, "'\\''");

    expect(shellSingleQuote(value)).toBe(`'${escaped}'`);
  });
});
