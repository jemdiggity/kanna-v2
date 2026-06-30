import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeCargoConfig } from "../src/runtime/env-sync";

describe("env sync", () => {
  it("writes repo-local Cargo target and build metadata config", () => {
    const root = mkdtempSync(join(tmpdir(), "kd-env-"));
    const path = writeCargoConfig(root);

    expect(path).toBe(join(root, ".cargo/config.toml"));
    expect(readFileSync(path, "utf8")).toBe(
      '[build]\ntarget-dir = ".build"\nbuild-dir = ".build/cargo-build"\n'
    );
  });
});
