import { describe, expect, it } from "vitest";
import {
  assertAttachmentWithinBudget,
  attachmentFileName,
  base64ByteLength,
  ImageAttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_EDGE_PIXELS,
  resolveAttachmentResize
} from "./imageAttachmentBudget";

function base64OfBytes(byteLength: number): string {
  return Buffer.alloc(byteLength, 7).toString("base64");
}

describe("resolveAttachmentResize", () => {
  it("scales the longest edge down to the budget and keeps the aspect ratio", () => {
    expect(resolveAttachmentResize({ width: 4032, height: 3024 })).toEqual({
      width: MAX_ATTACHMENT_EDGE_PIXELS,
      height: 1176
    });
    expect(resolveAttachmentResize({ width: 3024, height: 4032 })).toEqual({
      width: 1176,
      height: MAX_ATTACHMENT_EDGE_PIXELS
    });
  });

  it("leaves a photo that already fits alone rather than re-scaling it", () => {
    expect(resolveAttachmentResize({ width: 1200, height: 800 })).toBeNull();
    expect(
      resolveAttachmentResize({
        width: MAX_ATTACHMENT_EDGE_PIXELS,
        height: MAX_ATTACHMENT_EDGE_PIXELS
      })
    ).toBeNull();
  });

  it("never scales an extreme aspect ratio to a zero-pixel edge", () => {
    const resized = resolveAttachmentResize({ width: 20000, height: 3 });

    expect(resized).toEqual({ width: MAX_ATTACHMENT_EDGE_PIXELS, height: 1 });
  });

  it("declines to resize dimensions the picker could not report", () => {
    expect(resolveAttachmentResize({ width: 0, height: 0 })).toBeNull();
    expect(
      resolveAttachmentResize({ width: Number.NaN, height: 100 })
    ).toBeNull();
  });
});

describe("base64ByteLength", () => {
  it("counts decoded bytes without decoding, padding included", () => {
    for (const byteLength of [1, 2, 3, 4, 5, 1024, 65_537]) {
      expect(base64ByteLength(base64OfBytes(byteLength))).toBe(byteLength);
    }
    expect(base64ByteLength("")).toBe(0);
  });
});

describe("assertAttachmentWithinBudget", () => {
  it("accepts a payload inside the budget and reports its size", () => {
    expect(
      assertAttachmentWithinBudget(base64OfBytes(512 * 1024), "photo.jpg")
    ).toBe(512 * 1024);
  });

  it("refuses a payload over the budget before it is uploaded", () => {
    const oversized = base64OfBytes(MAX_ATTACHMENT_BYTES + 1);

    expect(() => assertAttachmentWithinBudget(oversized, "photo.jpg")).toThrow(
      ImageAttachmentError
    );
    try {
      assertAttachmentWithinBudget(oversized, "photo.jpg");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageAttachmentError);
      expect((error as ImageAttachmentError).reason).toBe("too-large");
      expect((error as ImageAttachmentError).message).toContain("photo.jpg");
    }
  });

  it("refuses an empty payload as unreadable rather than as too large", () => {
    try {
      assertAttachmentWithinBudget("", "photo.jpg");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageAttachmentError);
      expect((error as ImageAttachmentError).reason).toBe("unreadable");
    }
  });
});

describe("attachmentFileName", () => {
  it("keeps the picked name's stem and re-extensions it as JPEG", () => {
    expect(attachmentFileName("file:///tmp/IMG_4821.HEIC")).toBe("IMG_4821.jpg");
    expect(attachmentFileName("IMG_4821.HEIC")).toBe("IMG_4821.jpg");
    expect(attachmentFileName("file:///tmp/shot.png?x=1")).toBe("shot.jpg");
  });

  it("falls back to a generic name when the source has none", () => {
    expect(attachmentFileName(undefined)).toBe("photo.jpg");
    expect(attachmentFileName("file:///tmp/")).toBe("photo.jpg");
  });
});
