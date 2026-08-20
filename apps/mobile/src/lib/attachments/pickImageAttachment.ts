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

/**
 * The Expo permission response, narrowed to what the composer acts on.
 *
 * `canAskAgain` is the field that decides what the user is told. Once a
 * permission is denied the OS never shows its own dialog again, so a message
 * saying "try again" would be a lie and the only real route left is Settings.
 * `status` is carried through untouched for the same reason `granted` is not
 * enough on its own: it is what a diagnostic needs to tell "denied" from
 * "restricted by policy".
 */
export interface ImageAttachmentPermission {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
}

export interface ImageAttachmentPickerDeps {
  /** Reports the OS decision. A denial is a failure the user must hear about,
   * not the silent `null` a cancellation resolves to. */
  requestPermission(
    source: ImageAttachmentSource
  ): Promise<ImageAttachmentPermission>;
  /** Resolves null when the user cancelled the picker. */
  launch(source: ImageAttachmentSource): Promise<PickedImageAsset | null>;
  render: ImageAttachmentRenderer;
}

/**
 * What to tell the user about a refused permission.
 *
 * Same split as the pairing sheet's camera card: a permanently denied
 * permission points at Settings, because nothing the app does will raise the
 * system dialog again; a still-askable one only needs the user to try once
 * more and allow it.
 */
export function imageAttachmentPermissionMessage(
  source: ImageAttachmentSource,
  permission: ImageAttachmentPermission
): string {
  const subject = source === "camera" ? "Camera access" : "Photo access";
  return permission.canAskAgain
    ? `${subject} is needed to attach a photo. Tap 📎 again and allow it.`
    : `${subject} is off. Turn it on for Kanna in Settings to attach a photo.`;
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
 * Full flow: permission, picker, prepare.
 *
 * Resolves `null` only when the user cancelled the picker — a deliberate
 * "never mind" that deserves no message. A refused permission throws instead,
 * because it is the one outcome the user cannot diagnose from the UI: the
 * sheet closes and nothing happens, the OS will not ask again, and without a
 * message the control simply looks broken.
 */
export async function pickImageAttachment(
  source: ImageAttachmentSource,
  deps?: ImageAttachmentPickerDeps
): Promise<PreparedImageAttachment | null> {
  const resolvedDeps = deps ?? (await expoImageAttachmentPickerDeps());
  const permission = await resolvedDeps.requestPermission(source);
  if (!permission.granted) {
    throw new ImageAttachmentError(
      "permission-denied",
      imageAttachmentPermissionMessage(source, permission)
    );
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
      return {
        granted: response.granted,
        canAskAgain: response.canAskAgain,
        status: response.status
      };
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
