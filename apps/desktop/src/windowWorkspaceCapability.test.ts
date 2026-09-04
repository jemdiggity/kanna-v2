import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const capability = readFileSync(
  resolve(process.cwd(), "src-tauri/capabilities/default.json"),
  "utf8",
);

describe("window workspace native capability", () => {
  it("allows the geometry APIs used to validate and restore saved bounds", () => {
    expect(capability).toContain('"core:window:allow-set-position"');
    expect(capability).toContain('"core:window:allow-set-size"');
    expect(capability).toContain('"core:window:allow-set-min-size"');
    expect(capability).toContain('"core:window:allow-start-dragging"');
    expect(capability).toContain('"core:window:allow-available-monitors"');
    expect(capability).toContain('"core:window:allow-primary-monitor"');
    expect(capability).toContain('"core:window:allow-outer-position"');
    expect(capability).toContain('"core:window:allow-outer-size"');
    expect(capability).toContain('"core:window:allow-show"');
    expect(capability).toContain('"core:window:allow-set-focus"');
    expect(capability).toContain('"core:webview:allow-set-webview-focus"');
  });
});
