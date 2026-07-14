import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function runtimeSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeSourceFiles(path);
    if (!/\.(?:ts|vue)$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [path];
  });
}

describe("cloud publication architecture", () => {
  it("keeps task publication and renderer election out of every renderer window", () => {
    const forbidden = [
      "desktopCloudPublisher",
      "publishDesktopTaskSnapshot",
      "reconcileDesktopTaskSnapshots",
      "navigator.locks",
      "cloudPublicationLease",
    ];
    const violations = runtimeSourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbidden
        .filter((token) => source.includes(token))
        .map((token) => `${relative(sourceRoot, path)}: ${token}`);
    });

    expect(violations).toEqual([]);
  });

  it("limits signed-in renderer writes to credential association without a tasks path", () => {
    const source = readFileSync(join(sourceRoot, "services/desktopCloudAssociation.ts"), "utf8");
    expect(source).toContain("desktopSecretHash");
    expect(source).not.toMatch(/["']tasks["']/);
  });
});
