import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/remote-e2e.yml"), "utf8");

function lineNumber(needle: string): number {
  const index = workflow.indexOf(needle);
  expect(index, `expected workflow to include ${needle}`).toBeGreaterThanOrEqual(0);
  return workflow.slice(0, index).split("\n").length;
}

describe("remote-e2e workflow", () => {
  it("installs native toolchains before running the dev remote E2E lane", () => {
    const javaLine = lineNumber("uses: actions/setup-java@v4");
    const zigLine = lineNumber("Install Zig");
    const runtimeLine = lineNumber("Install Linux runtime packages");
    const layerBLine = lineNumber("run: ./kd test remote-e2e");

    expect(javaLine).toBeLessThan(layerBLine);
    expect(zigLine).toBeLessThan(layerBLine);
    expect(runtimeLine).toBeLessThan(layerBLine);
    expect(workflow).toContain("ZIG_VERSION: 0.15.2");
    expect(workflow).toContain("libc++-dev");
    expect(workflow).toContain("libc++abi-dev");
    expect(workflow).toContain("zsh");
  });

  it("keeps relay Layer A and the current dev Layer B suite wired into PR CI", () => {
    const layerALine = lineNumber("run: pnpm --dir services/relay test");
    const layerBLine = lineNumber("run: ./kd test remote-e2e");

    expect(layerALine).toBeLessThan(layerBLine);
    expect(workflow).toContain("timeout-minutes: 60");
  });
});
