/**
 * The size budget a photo has to fit inside before the phone uploads it, and
 * the arithmetic that gets it there.
 *
 * A phone photo is the wrong shape for this job twice over. It is many
 * megabytes, and both mobile transports carry it in a JSON body over the same
 * connection that carries the task's terminal stream — the relay tunnels a
 * desktop invocation as one WebSocket message, so a 12 MP HEIC would stall
 * live output while it drains. And an agent gains nothing from the extra
 * pixels: the vision models behind every supported CLI downscale a long edge
 * past ~1568px themselves. So the phone resizes and re-encodes first, and the
 * numbers it uses live here, apart from the Expo modules that apply them, so
 * they can be reasoned about and tested without a device.
 */

/**
 * Longest edge, in pixels, of an uploaded photo. Matches the largest edge the
 * vision models keep, so downscaling further would cost detail the agent could
 * have used and going higher would only cost bytes.
 */
export const MAX_ATTACHMENT_EDGE_PIXELS = 1568;

/**
 * JPEG quality for the re-encode. High enough that screenshots of code stay
 * readable, low enough that an ordinary photo lands in the low hundreds of KB.
 */
export const ATTACHMENT_JPEG_QUALITY = 0.7;

/**
 * Hard ceiling on the encoded bytes the phone will upload, mirroring
 * `MAX_TASK_INPUT_ATTACHMENT_BYTES` on the server. The client checks it too so
 * an over-budget photo fails on the phone with an explanation the user can act
 * on, instead of after a multi-megabyte upload.
 */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** The media type the phone always uploads: the resize step re-encodes to it. */
export const ATTACHMENT_MEDIA_TYPE = "image/jpeg";

export interface ImageAttachmentPayload {
  fileName: string;
  mediaType: string;
  dataBase64: string;
}

export interface PreparedImageAttachment {
  /** Local URI of the resized copy, for the composer thumbnail. */
  previewUri: string;
  /** Decoded size of what will be uploaded. */
  byteLength: number;
  payload: ImageAttachmentPayload;
}

export type ImageAttachmentFailureReason = "too-large" | "unreadable";

export class ImageAttachmentError extends Error {
  readonly reason: ImageAttachmentFailureReason;

  constructor(reason: ImageAttachmentFailureReason, message: string) {
    super(message);
    this.name = "ImageAttachmentError";
    this.reason = reason;
  }
}

export interface ImageAttachmentSize {
  width: number;
  height: number;
}

/**
 * The size to resize a picked photo to, or `null` when it already fits.
 *
 * Returning `null` rather than the original size is the point: a photo that is
 * already small must not be re-encoded, because a second lossy pass costs
 * quality and buys nothing.
 */
export function resolveAttachmentResize(
  source: ImageAttachmentSize
): ImageAttachmentSize | null {
  const { width, height } = source;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const longestEdge = Math.max(width, height);
  if (longestEdge <= MAX_ATTACHMENT_EDGE_PIXELS) {
    return null;
  }

  const scale = MAX_ATTACHMENT_EDGE_PIXELS / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/** Decoded byte length of a base64 payload, without decoding it. */
export function base64ByteLength(dataBase64: string): number {
  const encoded = dataBase64.trim();
  if (encoded.length === 0) {
    return 0;
  }

  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, (encoded.length * 3) / 4 - padding);
}

/**
 * Refuse a payload the server would refuse anyway.
 *
 * The resize above is what normally keeps a photo in budget; this is the
 * backstop for the cases it cannot fix — an image that is small in pixels but
 * huge in bytes, or a picker that handed back something unexpected.
 */
export function assertAttachmentWithinBudget(
  dataBase64: string,
  fileName: string
): number {
  const byteLength = base64ByteLength(dataBase64);
  if (byteLength === 0) {
    throw new ImageAttachmentError(
      "unreadable",
      `${fileName} could not be read as an image.`
    );
  }
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw new ImageAttachmentError(
      "too-large",
      `${fileName} is ${formatBytes(byteLength)}, over the ${formatBytes(
        MAX_ATTACHMENT_BYTES
      )} attachment limit.`
    );
  }
  return byteLength;
}

/** Name the upload after the picked file, falling back to a generic one. */
export function attachmentFileName(sourceUri: string | undefined): string {
  const lastSegment = sourceUri?.split(/[?#]/, 1)[0]?.split("/").pop() ?? "";
  const stem = lastSegment.replace(/\.[^./]+$/, "").trim();
  return stem.length > 0 ? `${stem}.jpg` : "photo.jpg";
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toFixed(1)} MB`;
}
