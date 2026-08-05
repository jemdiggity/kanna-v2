import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

interface CargoLockPackage {
  name?: unknown;
  dependencies?: unknown;
}

function parseTomlFile(path: string): Record<string, unknown> {
  return parseToml(readFileSync(resolve(repoRoot, path), "utf8")) as Record<string, unknown>;
}

function catalogManifestDependencies(): string[] {
  const manifest = parseTomlFile("crates/kanna-tool-catalog/Cargo.toml");
  const dependencies = manifest.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("kanna-tool-catalog Cargo.toml has no [dependencies] table");
  }

  return Object.entries(dependencies as Record<string, unknown>)
    .map(([name, specification]) => {
      if (!specification || typeof specification !== "object" || Array.isArray(specification)) {
        return name;
      }
      const packageName = (specification as Record<string, unknown>).package;
      return typeof packageName === "string" ? packageName : name;
    })
    .sort();
}

function lockedCatalogDependencies(lockPath: string): string[] {
  const lock = parseTomlFile(lockPath);
  if (!Array.isArray(lock.package)) {
    throw new Error(`${lockPath} has no [[package]] entries`);
  }

  const catalog = (lock.package as CargoLockPackage[]).find(
    (lockedPackage) => lockedPackage.name === "kanna-tool-catalog"
  );
  if (!catalog || !Array.isArray(catalog.dependencies)) {
    throw new Error(`${lockPath} has no kanna-tool-catalog dependency list`);
  }

  return catalog.dependencies
    .map((dependency) => {
      if (typeof dependency !== "string") {
        throw new Error(`${lockPath} contains a non-string kanna-tool-catalog dependency`);
      }
      return dependency.split(" ", 1)[0];
    })
    .sort();
}

describe("Bazel release Cargo locks", () => {
  it("keeps every direct tool-catalog dependency in each release sidecar graph", () => {
    const manifestDependencies = catalogManifestDependencies();
    const releaseLocks = [
      "crates/kanna-cli/Cargo.lock",
      "crates/kanna-mcp/Cargo.lock",
      "crates/kanna-server/Cargo.lock"
    ];

    for (const lockPath of releaseLocks) {
      expect(lockedCatalogDependencies(lockPath), lockPath).toEqual(manifestDependencies);
    }
  });

  it("derives the CLI catalog target from the CLI synthetic workspace and lock", () => {
    const moduleBazel = readFileSync(resolve(repoRoot, "MODULE.bazel"), "utf8");
    const catalogBuild = readFileSync(
      resolve(repoRoot, "crates/kanna-tool-catalog/BUILD.bazel"),
      "utf8"
    );

    expect(moduleBazel).toMatch(
      /name = "kanna_cli_crates",\s+cargo_lockfile = "\/\/crates\/kanna-cli:Cargo\.lock",\s+manifests = \["\/\/:Cargo\.cli\.toml"\]/
    );
    expect(catalogBuild).toContain(
      'deps = all_crate_deps_for_cli(normal = True, package_name = "crates/kanna-tool-catalog")'
    );
  });
});
