export const MAX_TERMINAL_LIVE_OUTPUT_CHARS = 1_000_000;
/**
 * How much older scrollback this buffer will hold above its snapshot.
 *
 * The desktop retains ~1 MiB of history per attachment
 * (`TERMINAL_HISTORY_RETENTION_BYTES`), which is ~1.4M base64 chars, so a
 * reader who keeps walking upward *will* reach a client bound. It is a refusal
 * bound, not an eviction bound: the loaded buffer must stay contiguous, and the
 * only way to make room for older content would be to drop content below it.
 */
export const MAX_TERMINAL_SCROLLBACK_CHARS = 1_000_000;
export const TERMINAL_OUTPUT_SEGMENT_TARGET_CHARS = 64 * 1024;

/**
 * The retained terminal stream, in three regions that are always contiguous in
 * this order: `scrollbackSegments` (older history pulled on demand, oldest
 * first), `snapshot` (the attach frame), then `liveSegments`.
 *
 * Only `liveSegments` is evicted, and only from its front — the boundary that
 * existed before scrollback could be pulled at all. `scrollbackSegments` grows
 * at the head and is bounded by refusal
 * ([`prependTerminalScrollback`]), because evicting to make room for a prepend
 * would take frames out of the *middle* of the terminal.
 */
export interface TerminalOutputBuffer {
  readonly scrollbackSegments: readonly string[];
  readonly scrollbackLength: number;
  readonly snapshot: string;
  readonly liveSegments: readonly string[];
  readonly liveLength: number;
  readonly length: number;
}

export type TerminalOutputLike = TerminalOutputBuffer | string;

export interface AppendedTerminalOutput {
  output: TerminalOutputBuffer;
  droppedChars: number;
}

export interface PrependedTerminalScrollback {
  output: TerminalOutputBuffer;
  /** False when the chunk did not fit and the buffer was left untouched. */
  accepted: boolean;
}

export const EMPTY_TERMINAL_OUTPUT: TerminalOutputBuffer = Object.freeze({
  scrollbackSegments: Object.freeze([]) as readonly string[],
  scrollbackLength: 0,
  snapshot: "",
  liveSegments: Object.freeze([]) as readonly string[],
  liveLength: 0,
  length: 0
});

function outputFrames(output: string): string[] {
  if (!output) return [];

  const frames: string[] = [];
  let frameStart = 0;
  while (frameStart < output.length) {
    const newline = output.indexOf("\n", frameStart);
    if (newline < 0) {
      frames.push(output.slice(frameStart));
      break;
    }
    frames.push(output.slice(frameStart, newline + 1));
    frameStart = newline + 1;
  }
  return frames;
}

function packFrames(
  existingSegments: readonly string[],
  frames: readonly string[]
): string[] {
  const segments = [...existingSegments];
  for (const frame of frames) {
    if (!frame) continue;
    const lastIndex = segments.length - 1;
    const last = segments[lastIndex];
    if (
      last !== undefined &&
      last.length + frame.length <= TERMINAL_OUTPUT_SEGMENT_TARGET_CHARS
    ) {
      segments[lastIndex] = `${last}${frame}`;
    } else {
      segments.push(frame);
    }
  }
  return segments;
}

function capLiveSegments(
  liveSegments: readonly string[],
  liveLength: number
): { liveSegments: readonly string[]; liveLength: number; droppedChars: number } {
  if (liveLength <= MAX_TERMINAL_LIVE_OUTPUT_CHARS) {
    return { liveSegments, liveLength, droppedChars: 0 };
  }

  const segments = [...liveSegments];
  let retainedLength = liveLength;
  let droppedChars = 0;

  while (retainedLength > MAX_TERMINAL_LIVE_OUTPUT_CHARS && segments.length > 0) {
    const first = segments[0];
    const requiredDrop = retainedLength - MAX_TERMINAL_LIVE_OUTPUT_CHARS;

    if (requiredDrop >= first.length && segments.length > 1) {
      segments.shift();
      retainedLength -= first.length;
      droppedChars += first.length;
      continue;
    }

    const frameEnd = first.indexOf("\n", Math.max(0, requiredDrop - 1));
    if (frameEnd >= 0 && frameEnd + 1 < retainedLength) {
      const retainedFirst = first.slice(frameEnd + 1);
      const removed = frameEnd + 1;
      retainedLength -= removed;
      droppedChars += removed;
      if (retainedFirst) {
        segments[0] = retainedFirst;
      } else {
        segments.shift();
      }
      continue;
    }

    // The newest complete frame alone crosses the soft cap, or the remaining
    // data is an incomplete frame. Keep it intact so replay never receives a
    // partial base64 frame.
    break;
  }

  return {
    liveSegments: segments,
    liveLength: retainedLength,
    droppedChars
  };
}

export function createTerminalOutput(output: string): TerminalOutputBuffer {
  if (!output) return EMPTY_TERMINAL_OUTPUT;

  const snapshotEnd = output.indexOf("\n") + 1;
  if (snapshotEnd === 0) {
    return {
      scrollbackSegments: [],
      scrollbackLength: 0,
      snapshot: output,
      liveSegments: [],
      liveLength: 0,
      length: output.length
    };
  }

  const snapshot = output.slice(0, snapshotEnd);
  const liveOutput = output.slice(snapshotEnd);
  const packed = packFrames([], outputFrames(liveOutput));
  const capped = capLiveSegments(packed, liveOutput.length);
  return {
    scrollbackSegments: [],
    scrollbackLength: 0,
    snapshot,
    liveSegments: capped.liveSegments,
    liveLength: capped.liveLength,
    length: snapshot.length + capped.liveLength
  };
}

/**
 * Splice one chunk of older scrollback above the buffer.
 *
 * Refused — buffer returned unchanged, `accepted: false` — when the chunk would
 * take the retained history past [`MAX_TERMINAL_SCROLLBACK_CHARS`]. Refusing is
 * the whole point: the alternative is dropping frames that sit *below* the new
 * chunk, which leaves a hole in the middle of the terminal and puts the reader
 * back on content that is not what they were looking at.
 */
export function prependTerminalScrollback(
  output: TerminalOutputBuffer,
  chunk: string
): PrependedTerminalScrollback {
  if (!chunk) return { output, accepted: true };
  if (output.scrollbackLength + chunk.length > MAX_TERMINAL_SCROLLBACK_CHARS) {
    return { output, accepted: false };
  }

  return {
    output: {
      scrollbackSegments: [chunk, ...output.scrollbackSegments],
      scrollbackLength: output.scrollbackLength + chunk.length,
      snapshot: output.snapshot,
      liveSegments: output.liveSegments,
      liveLength: output.liveLength,
      length: output.length + chunk.length
    },
    accepted: true
  };
}

export function appendTerminalOutput(
  output: TerminalOutputBuffer,
  chunk: string
): AppendedTerminalOutput {
  if (!chunk) return { output, droppedChars: 0 };

  const packed = packFrames(output.liveSegments, outputFrames(chunk));
  const capped = capLiveSegments(packed, output.liveLength + chunk.length);
  return {
    output: {
      scrollbackSegments: output.scrollbackSegments,
      scrollbackLength: output.scrollbackLength,
      snapshot: output.snapshot,
      liveSegments: capped.liveSegments,
      liveLength: capped.liveLength,
      length:
        output.scrollbackLength + output.snapshot.length + capped.liveLength
    },
    droppedChars: capped.droppedChars
  };
}

export function terminalOutputLength(output: TerminalOutputLike): number {
  return output.length;
}

export function terminalOutputToString(output: TerminalOutputLike): string {
  if (typeof output === "string") return output;
  return `${output.scrollbackSegments.join("")}${output.snapshot}${output.liveSegments.join("")}`;
}

export function sliceTerminalOutput(
  output: TerminalOutputLike,
  start: number
): string {
  if (typeof output === "string") return output.slice(start);
  if (start <= 0) return terminalOutputToString(output);
  if (start >= output.length) return "";

  const parts: string[] = [];
  let remaining = start;
  for (const segment of output.scrollbackSegments) {
    if (remaining >= segment.length) {
      remaining -= segment.length;
      continue;
    }
    parts.push(segment.slice(remaining));
    remaining = 0;
  }
  if (remaining < output.snapshot.length) {
    parts.push(output.snapshot.slice(remaining));
    remaining = 0;
  } else {
    remaining -= output.snapshot.length;
  }

  for (const segment of output.liveSegments) {
    if (remaining >= segment.length) {
      remaining -= segment.length;
      continue;
    }
    parts.push(segment.slice(remaining));
    remaining = 0;
  }
  return parts.join("");
}
