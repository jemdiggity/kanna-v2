import { ref, watch, type Ref } from "vue"

// A full-screen TUI on the alternate screen (Claude's REPL enters it with
// `?1049h`) hides the primary buffer — setup-script output and any history a
// stage transition carried over — and xterm cannot scroll into the normal
// buffer while the alternate one is active. This composable watches which
// buffer is active and reads the hidden normal-buffer text so the view can
// offer it without disturbing the live session.
//
// Structural slices of xterm's buffer API, so the logic is testable without a
// real Terminal.
export interface AltHistoryBufferLine {
  isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

export interface AltHistoryBuffer {
  type: "normal" | "alternate"
  length: number
  getLine(y: number): AltHistoryBufferLine | undefined
}

export interface AltHistoryBufferNamespace {
  active: AltHistoryBuffer
  normal: AltHistoryBuffer
  onBufferChange(listener: () => void): { dispose(): void }
}

export interface AltHistoryTerminal {
  buffer: AltHistoryBufferNamespace
}

/** The buffer's logical lines: wrapped rows joined onto the line they
 * continue, trailing blank lines dropped. */
export function collapseBufferLines(buffer: AltHistoryBuffer): string[] {
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text
    } else {
      lines.push(text)
    }
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop()
  }
  return lines
}

function bufferHasText(buffer: AltHistoryBuffer): boolean {
  for (let y = 0; y < buffer.length; y++) {
    if (buffer.getLine(y)?.translateToString(true).trim()) return true
  }
  return false
}

export function useAltScreenHistory<T extends AltHistoryTerminal>(terminal: Ref<T | null>) {
  const altScreenActive = ref(false)
  // While the alternate screen is active the normal buffer cannot change, so
  // recomputing on buffer switches (and terminal swaps) is enough.
  const hasHiddenHistory = ref(false)
  let subscription: { dispose(): void } | null = null

  const refresh = () => {
    const term = terminal.value
    const active = term != null && term.buffer.active.type === "alternate"
    altScreenActive.value = active
    hasHiddenHistory.value = active && term != null && bufferHasText(term.buffer.normal)
  }

  const stopWatch = watch(
    terminal,
    (term) => {
      subscription?.dispose()
      subscription = term ? term.buffer.onBufferChange(refresh) : null
      refresh()
    },
    { immediate: true },
  )

  const readHistoryLines = (): string[] => {
    const term = terminal.value
    return term ? collapseBufferLines(term.buffer.normal) : []
  }

  const dispose = () => {
    subscription?.dispose()
    subscription = null
    stopWatch()
  }

  return { altScreenActive, hasHiddenHistory, readHistoryLines, dispose }
}
