import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeCargoConfig } from "../src/runtime/env-sync";

describe("env sync", () => {
  it("writes only repo-local Cargo target config without machine-specific paths", () => {
    const root = mkdtempSync(join(tmpdir(), "kd-env-"));
    const path = writeCargoConfig(root);

    expect(path).toBe(join(root, ".cargo/config.toml"));
    expect(readFileSync(path, "utf8")).toBe(
      '[build]\ntarget-dir = ".build"\n'
    );
  });
});
