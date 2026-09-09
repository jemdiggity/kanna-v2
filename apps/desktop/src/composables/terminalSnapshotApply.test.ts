import { describe, it, expect } from "vitest"
import { Terminal } from "@xterm/xterm"
import { applyTerminalSnapshot, TERMINAL_FULL_RESET } from "./terminalSnapshotApply"

// A daemon snapshot as Ghostty serializes one: content painted from the
// cursor with relative movement only, and no clear of its own.
const SNAPSHOT_VT = [
  "history line one",
  "history line two",
  "history line three",
  "\x1b[2mspinner Rooming\x1b[0m",
].join("\r\n")

// What a differential TUI sends afterwards: absolute addressing that repaints
// only the cells that changed.
const POST_SNAPSHOT_DELTA = "\x1b[4;12H\x1b[2mt\x1b[0m"

function drain(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write("", () => resolve()))
}

function renderedRows(term: Terminal): string[] {
  const rows: string[] = []
  for (let y = 0; y < term.rows; y += 1) {
    const line = term.buffer.active.getLine(term.buffer.active.viewportY + y)
    rows.push(line ? line.translateToString(true) : "")
  }
  return rows
}

function newTerminal(cols = 40, rows = 10): Terminal {
  return new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 })
}

async function daemonFrame(): Promise<string[]> {
  const daemon = newTerminal()
  daemon.write(SNAPSHOT_VT)
  daemon.write(POST_SNAPSHOT_DELTA)
  await drain(daemon)
  return renderedRows(daemon)
}

describe("applyTerminalSnapshot", () => {
  // The owner viewer's cell: an attached local terminal whose server stream
  // re-attached to a replacement daemon.
  it("re-seeds an owner viewer that still has unparsed output queued", async () => {
    const viewer = newTerminal()
    // Output the viewer accepted before the stream re-attached. xterm has not
    // parsed it yet: writes are queued, so a synchronous Terminal.reset() here
    // would be applied ahead of these bytes and the snapshot would then paint
    // below them instead of at the origin.
    viewer.write("stale frame that the re-attach replaces\r\n")
    viewer.write("more stale output\r\n")

    applyTerminalSnapshot({
      terminal: viewer,
      cols: 40,
      rows: 10,
      data: SNAPSHOT_VT,
      replaceBuffer: true,
    })
    viewer.write(POST_SNAPSHOT_DELTA)
    await drain(viewer)

    // The rows the re-attach did not change must be there, not only the cells
    // the differential redraw touched afterwards.
    expect(renderedRows(viewer)).toEqual(await daemonFrame())
    expect(renderedRows(viewer)[0]).toBe("history line one")
    expect(renderedRows(viewer)[3]).toBe("spinner Rooting")
  })

  // The follower viewer's cell: CloudTerminalView hydrates the same way, with
  // the geometry unguarded (a follower's fit proposal is presentation-only)
  // and a callback that marks the view live once the snapshot is on screen.
  it("re-seeds a follower viewer that still has unparsed output queued", async () => {
    const follower = newTerminal()
    follower.write("stale frame from the previous subscription\r\n")
    follower.write("more stale output\r\n")

    let liveAfter: string[] = []
    await new Promise<void>((resolve) => {
      applyTerminalSnapshot({
        terminal: follower,
        cols: 40,
        rows: 10,
        data: new TextEncoder().encode(SNAPSHOT_VT),
        replaceBuffer: true,
        onParsed: () => {
          liveAfter = renderedRows(follower)
          resolve()
        },
      })
    })
    follower.write(POST_SNAPSHOT_DELTA)
    await drain(follower)

    expect(liveAfter[0]).toBe("history line one")
    expect(renderedRows(follower)).toEqual(await daemonFrame())
  })

  it("sizes the grid to the snapshot before the snapshot is parsed", async () => {
    const viewer = newTerminal(20, 10)
    viewer.write("stale\r\n")
    applyTerminalSnapshot({
      terminal: viewer,
      cols: 40,
      rows: 10,
      data: "0123456789012345678901234567890123456789",
      replaceBuffer: true,
    })
    await drain(viewer)
    expect(viewer.cols).toBe(40)
    expect(renderedRows(viewer)[0]).toBe("0123456789012345678901234567890123456789")
    expect(renderedRows(viewer)[1]).toBe("")
  })

  it("suppresses the resize echo through applyGeometry", async () => {
    const viewer = newTerminal(20, 10)
    const observed: boolean[] = []
    let hydrating = false
    viewer.onResize(() => observed.push(hydrating))
    applyTerminalSnapshot({
      terminal: viewer,
      cols: 30,
      rows: 12,
      data: "x",
      replaceBuffer: true,
      applyGeometry: (resize) => {
        hydrating = true
        resize()
        hydrating = false
      },
    })
    await drain(viewer)
    expect(observed).toEqual([true])
  })

  it("appends without clearing when the snapshot must not replace the buffer", async () => {
    const viewer = newTerminal()
    viewer.write("kept scrollback\r\n")
    applyTerminalSnapshot({
      terminal: viewer,
      cols: 40,
      rows: 10,
      data: "appended snapshot",
      replaceBuffer: false,
    })
    await drain(viewer)
    expect(renderedRows(viewer)[0]).toBe("kept scrollback")
    expect(renderedRows(viewer)[1]).toBe("appended snapshot")
  })

  it("runs onParsed after the snapshot has been parsed", async () => {
    const viewer = newTerminal()
    viewer.write("pending\r\n")
    let rowsWhenParsed: string[] = []
    await new Promise<void>((resolve) => {
      applyTerminalSnapshot({
        terminal: viewer,
        cols: 40,
        rows: 10,
        data: SNAPSHOT_VT,
        replaceBuffer: true,
        onParsed: () => {
          rowsWhenParsed = renderedRows(viewer)
          resolve()
        },
      })
    })
    expect(rowsWhenParsed[0]).toBe("history line one")
  })

  it("uses RIS, which xterm routes to a full terminal reset", async () => {
    const viewer = newTerminal()
    viewer.write("\x1b[?1049hALT SCREEN")
    for (let index = 0; index < 30; index += 1) viewer.write(`scrollback ${index}\r\n`)
    viewer.write(TERMINAL_FULL_RESET)
    viewer.write("after reset")
    await drain(viewer)
    expect(viewer.buffer.active.type).toBe("normal")
    expect(viewer.buffer.active.length).toBe(viewer.rows)
    expect(renderedRows(viewer)[0]).toBe("after reset")
  })
})
