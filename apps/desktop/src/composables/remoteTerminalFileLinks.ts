import { Terminal, type ILink } from "@xterm/xterm"
import {
  detectTerminalFileLinkCandidates,
  IMAGE_FILE_EXTENSION,
} from "./terminalFileLinks"

const WORKTREE_DIR_SEGMENT = "/.kanna-worktrees/"

export interface RemoteTerminalFileLink {
  text: string
  start: number
  previewPath: string
  line?: number
}

export interface RemoteTerminalFileLinkProvider {
  register(): void
  clearFileCache(): void
}

/**
 * Resolves a detected terminal path to a worktree-relative preview path for a
 * task running on another machine. The remote worktree root is unknown here,
 * so absolute paths are only accepted when they contain the well-known
 * `.kanna-worktrees/<branch>/` segment that every Kanna workspace uses.
 */
export function resolveRemoteTerminalFileLinkPath(path: string): string | null {
  let previewPath = path
  if (path.startsWith("/")) {
    const segmentIndex = path.indexOf(WORKTREE_DIR_SEGMENT)
    if (segmentIndex === -1) return null
    const afterRoot = path.slice(segmentIndex + WORKTREE_DIR_SEGMENT.length)
    const slashIndex = afterRoot.indexOf("/")
    if (slashIndex === -1) return null
    previewPath = afterRoot.slice(slashIndex + 1)
  }
  if (!previewPath || previewPath.split("/").includes("..")) return null
  if (IMAGE_FILE_EXTENSION.test(previewPath)) return null
  return previewPath
}

export function createRemoteTerminalFileLinkProvider(params: {
  term: Terminal
  readFile: (path: string) => Promise<string | null>
  getContainer: () => HTMLElement | null
}): RemoteTerminalFileLinkProvider {
  const fileContentCache = new Map<string, Promise<string | null>>()

  function detectLineLinks(lineText: string): RemoteTerminalFileLink[] {
    const matches: RemoteTerminalFileLink[] = []
    for (const candidate of detectTerminalFileLinkCandidates(lineText)) {
      const previewPath = resolveRemoteTerminalFileLinkPath(candidate.path)
      if (previewPath === null) continue
      matches.push({
        text: candidate.text,
        start: candidate.start,
        previewPath,
        line: candidate.line,
      })
    }
    return matches
  }

  function fetchFileContent(previewPath: string, refresh = false): Promise<string | null> {
    const cached = fileContentCache.get(previewPath)
    if (cached && !refresh) return cached
    const pending: Promise<string | null> = params.readFile(previewPath)
      .catch((error: unknown) => {
        console.debug(`[remote-file-links] failed to read remote file ${previewPath}:`, error)
        return null
      })
      .then((content) => {
        // Only successful reads stay cached, mirroring the local provider. A
        // missing file or a failed transport must not pin the path as
        // unresolvable — the next probe retries once the agent writes the file
        // or the relay/LAN connection recovers. The identity check keeps a
        // settling probe from evicting a newer refresh started over it.
        if (content === null && fileContentCache.get(previewPath) === pending) {
          fileContentCache.delete(previewPath)
        }
        return content
      })
    // Cached while in flight so concurrent provideLinks probes share one read.
    fileContentCache.set(previewPath, pending)
    return pending
  }

  async function activateLink(link: RemoteTerminalFileLink): Promise<void> {
    const content = await fetchFileContent(link.previewPath, true)
    if (content === null) return
    params.getContainer()?.dispatchEvent(new CustomEvent("file-link-activate", {
      bubbles: true,
      detail: { path: link.previewPath, line: link.line, remoteContent: content },
    }))
  }

  function register(): void {
    let tooltipEl: HTMLElement | null = null

    params.term.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
        const line = params.term.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) { callback(undefined); return }
        const matches = detectLineLinks(line.translateToString(true))
        if (matches.length === 0) { callback(undefined); return }

        Promise.all(matches.map(async (match) => {
          if (await fetchFileContent(match.previewPath) === null) return null
          const link: ILink = {
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.start + match.text.length, y: bufferLineNumber },
            },
            text: match.text,
            activate(event: MouseEvent) {
              if (event.metaKey) void activateLink(match)
            },
            hover(event: MouseEvent) {
              if (!params.term.element) return
              tooltipEl = document.createElement("div")
              tooltipEl.className = "xterm-hover"
              tooltipEl.textContent = "Open preview (⌘+click)"
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
          const valid = links.filter((link): link is ILink => link !== null)
          callback(valid.length > 0 ? valid : undefined)
        })
      },
    })
  }

  return {
    register,
    clearFileCache() {
      fileContentCache.clear()
    },
  }
}
