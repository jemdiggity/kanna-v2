/**
 * Picking a photo and getting it inside the upload budget.
 *
 * Two Expo native modules do the work — `expo-image-picker` opens the library
 * or the camera, `expo-image-manipulator` resizes and re-encodes — and both
 * are loaded lazily, inside the deps factory, for the same reason
 * `sessionPersistence` and `mobilePush` load theirs that way: a static import
 * puts a native module on the module graph of every screen that touches the
 * composer, and every test that renders one then has to mock it. Everything
 * above the factory is ordinary TypeScript, so the preparation logic is
 * testable without a device. See `imageAttachmentBudget.ts` for the numbers.
 */

import type * as ExpoImagePicker from "expo-image-picker";
import {
  assertAttachmentWithinBudget,
  attachmentFileName,
  ATTACHMENT_JPEG_QUALITY,
  ATTACHMENT_MEDIA_TYPE,
  ImageAttachmentError,
  resolveAttachmentResize,
  type ImageAttachmentSize,
  type PreparedImageAttachment
} from "./imageAttachmentBudget";

export type ImageAttachmentSource = "library" | "camera";

export interface PickedImageAsset {
  uri: string;
  width: number;
  height: number;
  fileName?: string | null;
}

export interface RenderedImage {
  uri: string;
  base64: string;
}

/**
 * Produce the bytes to upload. `size` is `null` when the picked photo already
 * fits, in which case the renderer must still re-encode to JPEG — the picker
 * hands back HEIC on iOS, which not every agent CLI can read.
 */
export type ImageAttachmentRenderer = (
  asset: PickedImageAsset,
  size: ImageAttachmentSize | null
) => Promise<RenderedImage>;

export interface ImageAttachmentPickerDeps {
  /** Resolves false when the user declined; the caller shows nothing further. */
  requestPermission(source: ImageAttachmentSource): Promise<boolean>;
  /** Resolves null when the user cancelled the picker. */
  launch(source: ImageAttachmentSource): Promise<PickedImageAsset | null>;
  render: ImageAttachmentRenderer;
}

/**
 * Resize (when needed), re-encode to JPEG, and check the result against the
 * budget.
 *
 * The budget check is not redundant with the resize: an image can be inside
 * the pixel limit and still be megabytes of JPEG, and the server would refuse
 * it after the upload rather than before it.
 */
export async function prepareImageAttachment(
  asset: PickedImageAsset,
  render: ImageAttachmentRenderer
): Promise<PreparedImageAttachment> {
  const rendered = await render(
    asset,
    resolveAttachmentResize({ width: asset.width, height: asset.height })
  );
  const fileName = attachmentFileName(asset.fileName ?? asset.uri);
  const byteLength = assertAttachmentWithinBudget(rendered.base64, fileName);

  return {
    previewUri: rendered.uri,
    byteLength,
    payload: {
      fileName,
      mediaType: ATTACHMENT_MEDIA_TYPE,
      dataBase64: rendered.base64
    }
  };
}

/**
 * Full flow: permission, picker, prepare. Resolves `null` when the user
 * declined permission or cancelled — neither is an error worth surfacing.
 */
export async function pickImageAttachment(
  source: ImageAttachmentSource,
  deps?: ImageAttachmentPickerDeps
): Promise<PreparedImageAttachment | null> {
  const resolvedDeps = deps ?? (await expoImageAttachmentPickerDeps());
  if (!(await resolvedDeps.requestPermission(source))) {
    return null;
  }
  const asset = await resolvedDeps.launch(source);
  if (!asset) {
    return null;
  }
  return prepareImageAttachment(asset, resolvedDeps.render);
}

export async function expoImageAttachmentPickerDeps(): Promise<ImageAttachmentPickerDeps> {
  const [picker, manipulator] = await Promise.all([
    import("expo-image-picker"),
    import("expo-image-manipulator")
  ]);

  return {
    async requestPermission(source) {
      const response =
        source === "camera"
          ? await picker.requestCameraPermissionsAsync()
          : await picker.requestMediaLibraryPermissionsAsync();
      return response.granted;
    },
    async launch(source) {
      // Photos only, and one at a time: v1 delivers a single image reference
      // in a single injected message, so a multi-select would have nowhere to
      // put the extras.
      const options: ExpoImagePicker.ImagePickerOptions = {
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        exif: false
      };
      const result =
        source === "camera"
          ? await picker.launchCameraAsync(options)
          : await picker.launchImageLibraryAsync(options);
      if (result.canceled) {
        return null;
      }
      const [asset] = result.assets;
      if (!asset) {
        return null;
      }
      return {
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        fileName: asset.fileName
      };
    },
    async render(asset, size) {
      const context = manipulator.ImageManipulator.manipulate(asset.uri);
      if (size) {
        context.resize(size);
      }
      const image = await context.renderAsync();
      const saved = await image.saveAsync({
        base64: true,
        compress: ATTACHMENT_JPEG_QUALITY,
        format: manipulator.SaveFormat.JPEG
      });
      if (!saved.base64) {
        throw new ImageAttachmentError(
          "unreadable",
          "The photo could not be encoded for upload."
        );
      }
      return { uri: saved.uri, base64: saved.base64 };
    }
  };
}
