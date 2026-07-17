import { PNG } from "pngjs";

export interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeSize {
  width: number;
  height: number;
}

export interface ScreenshotImage {
  data: Uint8Array;
  width: number;
  height: number;
}

type Rgb = readonly [number, number, number];

export function isNonEmptyNativeRect(rect: NativeRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function decodePngScreenshot(base64: string): ScreenshotImage {
  const png = PNG.sync.read(Buffer.from(base64, "base64"));
  return {
    data: png.data,
    height: png.height,
    width: png.width
  };
}

export function mapNativeRectToScreenshot(
  rect: NativeRect,
  windowSize: NativeSize,
  image: ScreenshotImage
): NativeRect {
  if (windowSize.width <= 0 || windowSize.height <= 0) {
    throw new Error("Native window dimensions must be positive");
  }

  const scaleX = image.width / windowSize.width;
  const scaleY = image.height / windowSize.height;
  const x = Math.floor(rect.x * scaleX);
  const y = Math.floor(rect.y * scaleY);
  const right = Math.ceil((rect.x + rect.width) * scaleX);
  const bottom = Math.ceil((rect.y + rect.height) * scaleY);

  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

export function assertColorCoverage(options: {
  image: ScreenshotImage;
  label: string;
  minimumCoverage: number;
  rect: NativeRect;
  expected: Rgb;
}): void {
  const { image, label, minimumCoverage, expected } = options;
  const left = Math.max(0, Math.floor(options.rect.x));
  const top = Math.max(0, Math.floor(options.rect.y));
  const right = Math.min(image.width, Math.ceil(options.rect.x + options.rect.width));
  const bottom = Math.min(
    image.height,
    Math.ceil(options.rect.y + options.rect.height)
  );

  if (right <= left || bottom <= top) {
    throw new Error(`${label} resolved to an empty screenshot rectangle`);
  }

  let matching = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (
        image.data[offset] === expected[0] &&
        image.data[offset + 1] === expected[1] &&
        image.data[offset + 2] === expected[2]
      ) {
        matching += 1;
      }
      total += 1;
    }
  }

  const coverage = matching / total;
  if (coverage < minimumCoverage) {
    throw new Error(
      `${label} expected rgb(${expected.join(", ")}) coverage >= ${(
        minimumCoverage * 100
      ).toFixed(1)}%, observed ${(coverage * 100).toFixed(1)}%`
    );
  }
}
