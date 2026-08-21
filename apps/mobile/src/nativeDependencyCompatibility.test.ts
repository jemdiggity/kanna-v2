import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
  version?: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const mobileRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function readPackageManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return undefined;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function satisfiesExpoRange(version: string, expectedRange: string): boolean {
  const actual = parseVersion(version);
  const operator = expectedRange.startsWith("~") || expectedRange.startsWith("^")
    ? expectedRange[0]
    : "=";
  const expected = parseVersion(operator === "=" ? expectedRange : expectedRange.slice(1));
  if (!actual || !expected) return false;
  if (operator === "=") return compareVersions(actual, expected) === 0;
  if (compareVersions(actual, expected) < 0) return false;
  if (operator === "~") {
    return actual.major === expected.major && actual.minor === expected.minor;
  }
  if (expected.major > 0) return actual.major === expected.major;
  if (expected.minor > 0) {
    return actual.major === 0 && actual.minor === expected.minor;
  }
  return actual.major === 0 && actual.minor === 0 && actual.patch === expected.patch;
}

function usesNativeExpoRecommendation(packageName: string): boolean {
  return packageName.startsWith("expo-") ||
    packageName === "react-native" ||
    packageName === "react-native-screens";
}

function matchesExpoRecommendation(
  packageName: string,
  declaredRange: string,
  expectedRange: string
): boolean {
  return !usesNativeExpoRecommendation(packageName) || declaredRange === expectedRange;
}

describe("Expo native dependency compatibility", () => {
  it("rejects the reported SDK 57.0.6 image-manipulator skew", () => {
    expect(
      matchesExpoRecommendation("expo-image-manipulator", "~57.0.11", "~57.0.4")
    ).toBe(false);
  });

  it("resolves every direct Expo-managed dependency inside the installed SDK matrix", () => {
    const mobileManifest = readPackageManifest(join(mobileRoot, "package.json"));
    const expoRoot = join(mobileRoot, "node_modules", "expo");
    const expoManifest = readPackageManifest(join(expoRoot, "package.json"));
    const expoMatrix = JSON.parse(
      readFileSync(join(expoRoot, "bundledNativeModules.json"), "utf8")
    ) as Record<string, string>;
    const dependencies = mobileManifest.dependencies ?? {};
    const failures: string[] = [];
    const specifierFailures: string[] = [];

    for (const packageName of Object.keys(dependencies).sort()) {
      const expectedRange = expoMatrix[packageName];
      if (!expectedRange) continue;
      if (
        !matchesExpoRecommendation(packageName, dependencies[packageName], expectedRange)
      ) {
        specifierFailures.push(
          `${packageName}: declared ${dependencies[packageName]}, Expo recommends ${expectedRange}`
        );
      }
      const resolved = readPackageManifest(
        join(mobileRoot, "node_modules", packageName, "package.json")
      ).version;
      if (!resolved || !satisfiesExpoRange(resolved, expectedRange)) {
        failures.push(`${packageName}: resolved ${resolved ?? "unknown"}, Expo expects ${expectedRange}`);
      }
    }

    expect(expoManifest.version).toBeDefined();
    expect(satisfiesExpoRange(expoManifest.version ?? "", dependencies.expo ?? "")).toBe(true);
    expect(parseVersion(expoManifest.version ?? "")?.major).toBe(57);
    expect(specifierFailures).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("keeps the image-manipulator lifecycle symbol in Expo Modules Core", () => {
    const expoRoot = realpathSync(join(mobileRoot, "node_modules", "expo"));
    const coreRoot = realpathSync(join(dirname(expoRoot), "expo-modules-core"));
    const baseModuleSource = readFileSync(
      join(coreRoot, "ios", "Core", "Modules", "Module.swift"),
      "utf8"
    );

    expect(baseModuleSource).toContain("open func willDestroy()");
  });
});
