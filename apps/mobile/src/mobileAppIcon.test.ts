import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../assets");

function readPng(name: string): PNG {
  return PNG.sync.read(readFileSync(resolve(assetsDir, name)));
}

function pixelAt(png: PNG, x: number, y: number): number[] {
  const offset = (png.width * y + x) * 4;
  return Array.from(png.data.subarray(offset, offset + 4));
}

interface AlphaBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function alphaBounds(png: PNG): AlphaBounds {
  const bounds: AlphaBounds = {
    minX: png.width,
    minY: png.height,
    maxX: -1,
    maxY: -1
  };

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alphaOffset = (png.width * y + x) * 4 + 3;
      if (png.data[alphaOffset] === 0) {
        continue;
      }
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }

  return bounds;
}

describe("mobile app icon assets", () => {
  it("uses an opaque, full-bleed platform icon without a baked-in outer mask", () => {
    const icon = readPng("icon.png");

    expect({ width: icon.width, height: icon.height }).toEqual({
      width: 1024,
      height: 1024
    });
    expect(alphaBounds(icon)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 1023,
      maxY: 1023
    });
    expect(pixelAt(icon, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(icon, 1023, 1023)).toEqual([243, 244, 246, 255]);

    const source = readFileSync(resolve(assetsDir, "icon.svg"), "utf8");
    expect(source).toContain('id="mobile-icon-background"');
    expect(source).toContain('width="512" height="512"');
    expect(source).not.toContain('id="app-icon-background"');
  });

  it("keeps Android foreground artwork transparent and inside its safe zone", () => {
    const foreground = readPng("adaptive-icon-foreground.png");
    const background = readPng("adaptive-icon-background.png");

    expect(pixelAt(foreground, 0, 0)[3]).toBe(0);
    expect(alphaBounds(foreground)).toEqual({
      minX: 260,
      minY: 205,
      maxX: 767,
      maxY: 818
    });
    expect(alphaBounds(background)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 1023,
      maxY: 1023
    });
  });
});
