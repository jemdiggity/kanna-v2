import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { operatorRealE2eFiles, unattendedRealE2eFiles } from "./realTiers";

describe("desktop real E2E tiers", () => {
  it("classifies every real test file exactly once", async () => {
    const realDir = join(dirname(fileURLToPath(import.meta.url)), "real");
    const realFiles = (await readdir(realDir))
      .filter((file) => file.endsWith(".test.ts"))
      .sort();
    const unattended = [...unattendedRealE2eFiles];
    const operator = [...operatorRealE2eFiles];
    const operatorSet = new Set<string>(operator);

    expect(new Set(unattended).size).toBe(unattended.length);
    expect(new Set(operator).size).toBe(operator.length);
    expect(unattended.filter((file) => operatorSet.has(file))).toEqual([]);
    expect([...unattended, ...operator].sort()).toEqual(realFiles);
  });
});
