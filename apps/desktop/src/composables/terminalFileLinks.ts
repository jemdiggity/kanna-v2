import { Terminal, type ILink } from "@xterm/xterm"
import { invoke } from "../invoke"
import type { TerminalOptions } from "./terminalTypes"

// --- File link provider ---
const FILE_PATH_RE = /(?:^|[\s"'`(<\[])(\/?[a-zA-Z0-9_.\-][\w.\-/]*\.[a-zA-Z][a-zA-Z0-9]*(?::\d+){0,2})/g
const IMAGE_FILE_EXTENSION = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i

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
    const parts = raw.split(":")
    const suffixes: number[] = []
    while (parts.length > 1) {
      const maybeNumber = parts[parts.length - 1]
      if (!maybeNumber || !/^\d+$/.test(maybeNumber)) break
      suffixes.unshift(parseInt(maybeNumber, 10))
      parts.pop()
    }
    return { path: parts.join(":"), line: suffixes[0] }
  }

  function resolveFileLink(raw: string): { checkPath: string; previewPath: string; line?: number } | null {
    const worktreePath = params.options?.worktreePath
    if (!worktreePath) return null
    const { path, line } = parseFileLink(raw)
    const normalizedWorktreePath = worktreePath.replace(/\/+$/, "")
    if (path.startsWith("/")) {
      if (!path.startsWith(`${normalizedWorktreePath}/`)) return null
      return {
        checkPath: path,
        previewPath: path.slice(normalizedWorktreePath.length + 1),
        line,
      }
    }
    return {
      checkPath: `${normalizedWorktreePath}/${path}`,
      previewPath: path,
      line,
    }
  }

  function isImageFilePath(path: string): boolean {
    return IMAGE_FILE_EXTENSION.test(path)
  }

  async function checkFileExists(checkPath: string): Promise<boolean> {
    if (fileExistsCache.has(checkPath)) return fileExistsCache.get(checkPath)!
    try {
      const exists = await invoke<boolean>("file_exists", { path: checkPath })
      fileExistsCache.set(checkPath, exists)
      return exists
    } catch {
      fileExistsCache.set(checkPath, false)
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

        const matches: {
          text: string
          start: number
          checkPath: string
          previewPath: string
          line?: number
        }[] = []
        FILE_PATH_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = FILE_PATH_RE.exec(lineText)) !== null) {
          const fullMatch = m[0]
          const pathMatch = m[1]
          const startOffset = m.index + (fullMatch.length - pathMatch.length)
          const resolved = resolveFileLink(pathMatch)
          if (!resolved) continue
          matches.push({ text: pathMatch, start: startOffset, ...resolved })
        }

        if (matches.length === 0) { callback(undefined); return }

        Promise.all(matches.map(async (match) => {
          const exists = await checkFileExists(match.checkPath)
          if (!exists) return null
          const link: ILink = {
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.start + match.text.length + 1, y: bufferLineNumber },
            },
            text: match.text,
            activate(event: MouseEvent) {
              if (!event.metaKey) return
              if (isImageFilePath(match.checkPath)) {
                params.getContainer()?.dispatchEvent(new CustomEvent("image-link-activate", {
                  bubbles: true,
                  detail: { url: match.checkPath },
                }))
                return
              }
              params.getContainer()?.dispatchEvent(new CustomEvent("file-link-activate", {
                bubbles: true,
                detail: { path: match.previewPath, line: match.line },
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
