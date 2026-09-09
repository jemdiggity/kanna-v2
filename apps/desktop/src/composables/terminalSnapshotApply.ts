import type { Terminal } from "@xterm/xterm"

/** A full terminal reset (RIS) as a byte sequence rather than an API call.
 *
 *  A daemon terminal snapshot is Ghostty's xterm-compatible serialization: it
 *  paints from wherever the cursor is, with relative cursor movement and no
 *  clear of its own, so it is only correct in a terminal that has just been
 *  reset. `Terminal.reset()` cannot provide that guarantee mid-stream —
 *  it runs synchronously while `Terminal.write()` is queued, so it erases the
 *  buffer *ahead of* output frames the viewer has already accepted but xterm
 *  has not parsed yet. Those bytes then paint into the cleared grid and push
 *  the snapshot off its origin, which is how a stream re-attach rendered as
 *  the deltas without the initial state. xterm routes RIS straight back to
 *  `Terminal.reset()`, so this is the same reset — travelling in the byte
 *  stream, where it can never overtake output that came before it. */
export const TERMINAL_FULL_RESET = "\x1bc"

export interface TerminalSnapshotApplication {
  terminal: Terminal
  /** The grid the snapshot was serialized for. */
  cols: number
  rows: number
  data: string | Uint8Array
  /** Whether the snapshot replaces the buffer or is written on top of it. */
  replaceBuffer: boolean
  /** Wraps the grid resize, so a viewer can suppress the resize proposal it
   *  would otherwise echo back to the daemon while hydrating. */
  applyGeometry?: (resize: () => void) => void
  /** Runs once xterm has parsed the snapshot. */
  onParsed?: () => void
}

/** Hydrate a viewer from an authoritative daemon terminal snapshot.
 *
 *  The grid is sized before the snapshot is parsed so a full-screen TUI is
 *  never laid out at the viewer's own width and then reflowed. That resize
 *  stays a direct call rather than joining the byte stream: a replacing
 *  snapshot erases whatever it reflows on the way past, and a snapshot written
 *  on top of the buffer keeps the geometry handling it has always had. */
export function applyTerminalSnapshot(params: TerminalSnapshotApplication): void {
  const resize = () => {
    if (params.terminal.cols !== params.cols || params.terminal.rows !== params.rows) {
      params.terminal.resize(params.cols, params.rows)
    }
  }
  if (params.applyGeometry) {
    params.applyGeometry(resize)
  } else {
    resize()
  }
  if (params.replaceBuffer) {
    params.terminal.write(TERMINAL_FULL_RESET)
  }
  if (params.onParsed) {
    params.terminal.write(params.data, params.onParsed)
  } else {
    params.terminal.write(params.data)
  }
}
