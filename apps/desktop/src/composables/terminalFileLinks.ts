import { Terminal, type ILink } from "@xterm/xterm"
import { invoke } from "../invoke"
import type { TerminalOptions } from "./terminalTypes"

// --- File link provider ---
const FILE_PATH_RE = /(?:^|[\s"'`(])([a-zA-Z0-9_.\-][\w.\-/]*\/[\w.\-/]*\.[a-zA-Z0-9]+(?::\d+)?)/g

export interface TerminalFileLinkProvider {
  register(): void
  clearFileExistsCache(): void
}

export function createTerminalFileLinkProvider(params: {
  term: Terminal
  options?: TerminalOptions
  getContainer: () => HTMLElement | null
}): TerminalFileLinkProvider {
  const fileExistsCache = new Map<string, boolean>()

  function parseFileLink(raw: string): { path: string; line?: number } {
    const colonIdx = raw.lastIndexOf(":")
    if (colonIdx > 0) {
      const maybeLine = raw.slice(colonIdx + 1)
      if (/^\d+$/.test(maybeLine)) {
        return { path: raw.slice(0, colonIdx), line: parseInt(maybeLine, 10) }
      }
    }
    return { path: raw }
  }

  async function checkFileExists(relativePath: string): Promise<boolean> {
    const worktreePath = params.options?.worktreePath
    if (!worktreePath) return false
    if (fileExistsCache.has(relativePath)) return fileExistsCache.get(relativePath)!
    try {
      const exists = await invoke<boolean>("file_exists", { path: `${worktreePath}/${relativePath}` })
      fileExistsCache.set(relativePath, exists)
      return exists
    } catch {
      fileExistsCache.set(relativePath, false)
      return false
    }
  }

  function register(): void {
    if (!params.options?.worktreePath) {
      return
    }

    let tooltipEl: HTMLElement | null = null

    params.term.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
        const line = params.term.buffer.active.getLine(bufferLineNumber)
        if (!line) { callback(undefined); return }
        const lineText = line.translateToString(true)

        const matches: { text: string; start: number; path: string }[] = []
        FILE_PATH_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = FILE_PATH_RE.exec(lineText)) !== null) {
          const fullMatch = m[0]
          const pathMatch = m[1]
          const startOffset = m.index + (fullMatch.length - pathMatch.length)
          const { path } = parseFileLink(pathMatch)
          matches.push({ text: pathMatch, start: startOffset, path })
        }

        if (matches.length === 0) { callback(undefined); return }

        Promise.all(matches.map(async (match) => {
          const exists = await checkFileExists(match.path)
          if (!exists) return null
          const link: ILink = {
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.start + match.text.length + 1, y: bufferLineNumber },
            },
            text: match.text,
            activate(event: MouseEvent) {
              if (!event.metaKey) return
              const { path, line: lineNum } = parseFileLink(match.text)
              params.getContainer()?.dispatchEvent(new CustomEvent("file-link-activate", {
                bubbles: true,
                detail: { path, line: lineNum },
              }))
            },
            hover(event: MouseEvent) {
              if (!params.term.element) return
              tooltipEl = document.createElement("div")
              tooltipEl.className = "xterm-hover"
              tooltipEl.textContent = "Open preview (\u2318+click)"
              tooltipEl.style.cssText = `
                position: fixed;
                left: ${event.clientX + 8}px;
                top: ${event.clientY - 28}px;
                background: var(--kn-bg-panel);
                color: var(--kn-text-secondary);
                font-size: 11px;
                padding: 2px 6px;
                border-radius: 3px;
                border: 1px solid var(--kn-border-strong);
                pointer-events: none;
                z-index: 10000;
                font-family: "SF Mono", Menlo, monospace;
              `
              params.term.element.appendChild(tooltipEl)
            },
            leave() {
              tooltipEl?.remove()
              tooltipEl = null
            },
          }
          return link
        })).then((links) => {
          const valid = links.filter((l): l is ILink => l !== null)
          callback(valid.length > 0 ? valid : undefined)
        })
      },
    })
  }

  return {
    register,
    clearFileExistsCache() {
      fileExistsCache.clear()
    },
  }
}
