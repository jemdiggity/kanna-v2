import { describe, expect, it } from "vitest"
import { nextTick, ref } from "vue"
import {
  collapseBufferLines,
  useAltScreenHistory,
  type AltHistoryBuffer,
  type AltHistoryBufferLine,
  type AltHistoryTerminal,
} from "./terminalAltScreenHistory"

function line(text: string, isWrapped = false): AltHistoryBufferLine {
  return { isWrapped, translateToString: () => text }
}

function buffer(type: "normal" | "alternate", lines: AltHistoryBufferLine[]): AltHistoryBuffer {
  return { type, length: lines.length, getLine: (y) => lines[y] }
}

class FakeTerminal implements AltHistoryTerminal {
  listeners: Array<() => void> = []
  normalLines: AltHistoryBufferLine[] = []
  activeType: "normal" | "alternate" = "normal"

  get buffer() {
    return {
      active: buffer(this.activeType, this.activeType === "normal" ? this.normalLines : []),
      normal: buffer("normal", this.normalLines),
      onBufferChange: (listener: () => void) => {
        this.listeners.push(listener)
        return {
          dispose: () => {
            this.listeners = this.listeners.filter((entry) => entry !== listener)
          },
        }
      },
    }
  }

  switchTo(type: "normal" | "alternate") {
    this.activeType = type
    for (const listener of [...this.listeners]) listener()
  }
}

describe("collapseBufferLines", () => {
  it("joins wrapped rows onto their logical line and drops trailing blanks", () => {
    const lines = collapseBufferLines(
      buffer("normal", [
        line("Running startup script"),
        line("$ pnpm install --froz"),
        line("en-lockfile", true),
        line("done"),
        line(""),
        line("   "),
      ]),
    )
    expect(lines).toEqual([
      "Running startup script",
      "$ pnpm install --frozen-lockfile",
      "done",
    ])
  })

  it("returns nothing for an empty buffer", () => {
    expect(collapseBufferLines(buffer("normal", []))).toEqual([])
    expect(collapseBufferLines(buffer("normal", [line(""), line("")]))).toEqual([])
  })
})

describe("useAltScreenHistory", () => {
  it("reports hidden history only while the alternate screen hides real content", async () => {
    const fake = new FakeTerminal()
    fake.normalLines = [line("setup output")]
    const terminal = ref<FakeTerminal | null>(fake)
    const { altScreenActive, hasHiddenHistory, readHistoryLines, dispose } =
      useAltScreenHistory(terminal)

    expect(altScreenActive.value).toBe(false)
    expect(hasHiddenHistory.value).toBe(false)

    fake.switchTo("alternate")
    expect(altScreenActive.value).toBe(true)
    expect(hasHiddenHistory.value).toBe(true)
    expect(readHistoryLines()).toEqual(["setup output"])

    fake.switchTo("normal")
    expect(altScreenActive.value).toBe(false)
    expect(hasHiddenHistory.value).toBe(false)

    dispose()
    await nextTick()
    expect(fake.listeners).toEqual([])
  })

  it("offers nothing when the normal buffer is blank", () => {
    const fake = new FakeTerminal()
    fake.normalLines = [line(""), line("   ")]
    const terminal = ref<FakeTerminal | null>(fake)
    const { hasHiddenHistory, dispose } = useAltScreenHistory(terminal)

    fake.switchTo("alternate")
    expect(hasHiddenHistory.value).toBe(false)
    dispose()
  })

  it("re-subscribes when the terminal instance is swapped", async () => {
    const first = new FakeTerminal()
    const terminal = ref<FakeTerminal | null>(first)
    const { altScreenActive, dispose } = useAltScreenHistory(terminal)
    expect(first.listeners).toHaveLength(1)

    const second = new FakeTerminal()
    second.normalLines = [line("carried history")]
    terminal.value = second
    await nextTick()
    expect(first.listeners).toEqual([])
    expect(second.listeners).toHaveLength(1)

    second.switchTo("alternate")
    expect(altScreenActive.value).toBe(true)
    dispose()
  })
})
