import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_MEDIA_TYPE,
  ImageAttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_EDGE_PIXELS
} from "./imageAttachmentBudget";
import {
  imageAttachmentPermissionMessage,
  pickImageAttachment,
  prepareImageAttachment,
  type ImageAttachmentPermission,
  type ImageAttachmentPickerDeps,
  type ImageAttachmentRenderer,
  type PickedImageAsset
} from "./pickImageAttachment";

function base64OfBytes(byteLength: number): string {
  return Buffer.alloc(byteLength, 7).toString("base64");
}

function renderer(
  base64 = base64OfBytes(1024)
): ReturnType<typeof vi.fn<ImageAttachmentRenderer>> {
  return vi.fn<ImageAttachmentRenderer>(async () => ({
    uri: "file:///tmp/rendered.jpg",
    base64
  }));
}

const PHONE_PHOTO: PickedImageAsset = {
  uri: "file:///tmp/IMG_4821.HEIC",
  width: 4032,
  height: 3024,
  fileName: "IMG_4821.HEIC"
};

describe("prepareImageAttachment", () => {
  it("resizes an oversized photo and uploads it as JPEG", async () => {
    const render = renderer();

    const prepared = await prepareImageAttachment(PHONE_PHOTO, render);

    expect(render).toHaveBeenCalledWith(PHONE_PHOTO, {
      width: MAX_ATTACHMENT_EDGE_PIXELS,
      height: 1176
    });
    expect(prepared).toEqual({
      previewUri: "file:///tmp/rendered.jpg",
      byteLength: 1024,
      payload: {
        fileName: "IMG_4821.jpg",
        mediaType: ATTACHMENT_MEDIA_TYPE,
        dataBase64: base64OfBytes(1024)
      }
    });
  });

  it("still re-encodes a photo that needs no resizing", async () => {
    const render = renderer();

    await prepareImageAttachment(
      { uri: "file:///tmp/small.heic", width: 800, height: 600 },
      render
    );

    // `null` means "do not resize" — not "do nothing": the picker hands back
    // HEIC on iOS and the upload must be JPEG either way.
    expect(render).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("refuses a rendered image that is still over the budget", async () => {
    const render = renderer(base64OfBytes(MAX_ATTACHMENT_BYTES + 1));

    await expect(prepareImageAttachment(PHONE_PHOTO, render)).rejects.toThrow(
      ImageAttachmentError
    );
  });
});

function granted(): ImageAttachmentPermission {
  return { granted: true, canAskAgain: false, status: "granted" };
}

function refused(canAskAgain: boolean): ImageAttachmentPermission {
  return { granted: false, canAskAgain, status: "denied" };
}

describe("imageAttachmentPermissionMessage", () => {
  it("points a permanently denied permission at Settings", () => {
    // Once the OS has recorded a denial it shows no further dialog, so "try
    // again" would send the user in a circle.
    expect(imageAttachmentPermissionMessage("library", refused(false))).toBe(
      "Photo access is off. Turn it on for Kanna in Settings to attach a photo."
    );
    expect(imageAttachmentPermissionMessage("camera", refused(false))).toBe(
      "Camera access is off. Turn it on for Kanna in Settings to attach a photo."
    );
  });

  it("tells a still-askable permission to retry", () => {
    expect(imageAttachmentPermissionMessage("library", refused(true))).toBe(
      "Photo access is needed to attach a photo. Tap 📎 again and allow it."
    );
    expect(imageAttachmentPermissionMessage("camera", refused(true))).toBe(
      "Camera access is needed to attach a photo. Tap 📎 again and allow it."
    );
  });
});

describe("pickImageAttachment", () => {
  function deps(
    overrides: Partial<ImageAttachmentPickerDeps> = {}
  ): ImageAttachmentPickerDeps {
    return {
      requestPermission: vi.fn(async () => granted()),
      launch: vi.fn(async () => PHONE_PHOTO),
      render: renderer(),
      ...overrides
    };
  }

  it("prepares the picked photo for both sources", async () => {
    for (const source of ["library", "camera"] as const) {
      const dependencies = deps();

      const prepared = await pickImageAttachment(source, dependencies);

      expect(dependencies.requestPermission).toHaveBeenCalledWith(source);
      expect(dependencies.launch).toHaveBeenCalledWith(source);
      expect(prepared?.payload.mediaType).toBe(ATTACHMENT_MEDIA_TYPE);
    }
  });

  it("reports a declined permission as a failure rather than a silent null", async () => {
    // A cancellation resolves null and says nothing. A denial must not: the
    // sheet closes, the OS will never ask again, and a user given no message
    // is left tapping a control that can no longer do anything.
    const dependencies = deps({
      requestPermission: vi.fn(async () => refused(false))
    });

    await expect(
      pickImageAttachment("library", dependencies)
    ).rejects.toThrow(ImageAttachmentError);
    expect(dependencies.launch).not.toHaveBeenCalled();
    expect(dependencies.render).not.toHaveBeenCalled();
  });

  it("carries the permission reason and an actionable message on the error", async () => {
    const dependencies = deps({
      requestPermission: vi.fn(async () => refused(true))
    });

    await expect(
      pickImageAttachment("camera", dependencies)
    ).rejects.toMatchObject({
      reason: "permission-denied",
      message: imageAttachmentPermissionMessage("camera", refused(true))
    });
  });

  it("stops without rendering when the picker is cancelled", async () => {
    const dependencies = deps({ launch: vi.fn(async () => null) });

    await expect(pickImageAttachment("camera", dependencies)).resolves.toBeNull();
    expect(dependencies.render).not.toHaveBeenCalled();
  });
});
