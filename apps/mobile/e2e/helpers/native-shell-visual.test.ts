import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  assertColorCoverage,
  decodePngScreenshot,
  isNonEmptyNativeRect,
  mapNativeRectToScreenshot
} from "./native-shell-visual";

function createScreenshot(
  width: number,
  height: number,
  color: readonly [number, number, number]
): string {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png).toString("base64");
}

describe("native shell screenshot inspection", () => {
  it("rejects transient zero-size native geometry", () => {
    expect(isNonEmptyNativeRect({ x: 16, y: 757, width: 64, height: 64 })).toBe(
      true
    );
    expect(isNonEmptyNativeRect({ x: 0, y: 0, width: 0, height: 64 })).toBe(false);
    expect(isNonEmptyNativeRect({ x: 0, y: 0, width: 64, height: 0 })).toBe(false);
  });

  it("maps native point rectangles into screenshot pixels", () => {
    const image = decodePngScreenshot(createScreenshot(300, 600, [8, 17, 30]));

    expect(
      mapNativeRectToScreenshot(
        { x: 10, y: 20, width: 30, height: 40 },
        { width: 100, height: 200 },
        image
      )
    ).toEqual({ x: 30, y: 60, width: 90, height: 120 });
  });

  it("accepts a patch whose exact expected color clears the threshold", () => {
    const image = decodePngScreenshot(createScreenshot(6, 6, [8, 17, 30]));

    expect(() =>
      assertColorCoverage({
        image,
        label: "Tasks canvas",
        minimumCoverage: 1,
        rect: { x: 0, y: 0, width: 6, height: 6 },
        expected: [8, 17, 30]
      })
    ).not.toThrow();
  });

  it("reports the observed coverage when a patch has the wrong color", () => {
    const image = decodePngScreenshot(createScreenshot(4, 4, [18, 43, 81]));

    expect(() =>
      assertColorCoverage({
        image,
        label: "Recent former ambient-circle patch",
        minimumCoverage: 0.95,
        rect: { x: 0, y: 0, width: 4, height: 4 },
        expected: [8, 17, 30]
      })
    ).toThrow(
      "Recent former ambient-circle patch expected rgb(8, 17, 30) coverage >= 95.0%, observed 0.0%"
    );
  });
});
