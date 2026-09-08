import { describe, expect, it } from "vitest";

import { parseServerTimestamp } from "../serverTimestamp";

describe("parseServerTimestamp", () => {
  it("reads SQLite's zone-less datetime('now') as UTC", () => {
    expect(parseServerTimestamp("2026-09-08 03:59:28").toISOString())
      .toBe("2026-09-08T03:59:28.000Z");
  });

  it("keeps an explicit UTC designator", () => {
    expect(parseServerTimestamp("2026-09-08T03:59:28.000Z").toISOString())
      .toBe("2026-09-08T03:59:28.000Z");
  });

  it("keeps an explicit numeric offset", () => {
    expect(parseServerTimestamp("2026-09-08T12:59:28+09:00").toISOString())
      .toBe("2026-09-08T03:59:28.000Z");
  });

  it("does not drift a zone-less timestamp with the host time zone", () => {
    const parsed = parseServerTimestamp("2026-09-08 03:59:28").getTime();
    expect(parsed).toBe(Date.UTC(2026, 8, 8, 3, 59, 28));
  });
});
