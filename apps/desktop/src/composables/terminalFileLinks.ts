import { Terminal, type ILink } from "@xterm/xterm"
import { fileExistsSafe } from "../utils/invokeHelpers"
import type { TerminalOptions } from "./terminalTypes"

const FILE_PATH_RE = /(?:^|[\s"'`(<\[])(\/?[a-zA-Z0-9_.\-][\w.\-/]*\.[a-zA-Z][a-zA-Z0-9]*(?::\d+){0,2})/g
export const IMAGE_FILE_EXTENSION = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i

export interface TerminalFileLinkCandidate {
  text: string
  start: number
  path: string
  line?: number
}

export function parseTerminalFileLink(raw: string): { path: string; line?: number } {
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

export function detectTerminalFileLinkCandidates(lineText: string): TerminalFileLinkCandidate[] {
  const candidates: TerminalFileLinkCandidate[] = []
  FILE_PATH_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILE_PATH_RE.exec(lineText)) !== null) {
    const fullMatch = match[0]
    const pathMatch = match[1]
    candidates.push({
      text: pathMatch,
      start: match.index + (fullMatch.length - pathMatch.length),
      ...parseTerminalFileLink(pathMatch),
    })
  }
  return candidates
}

export interface ResolvedTerminalFileLink {
  text: string
  start: number
  checkPath: string
  previewPath: string
  line?: number
  image: boolean
  externalAbsolute: boolean
}

export interface TerminalFileLinkProvider {
  register(): void
  findLatest(): Promise<ResolvedTerminalFileLink | null>
  activateLatest(): Promise<boolean>
  watchForFirstLink(onAvailable: () => void): () => void
  clearFileExistsCache(): void
}

export function createTerminalFileLinkProvider(params: {
  term: Terminal
  options?: TerminalOptions
  getContainer: () => HTMLElement | null
}): TerminalFileLinkProvider {
  const fileExistsCache = new Map<string, boolean>()

  function resolveFileLink(
    candidate: TerminalFileLinkCandidate,
    worktreePath: string,
  ): Omit<ResolvedTerminalFileLink, "text" | "start"> | null {
    const { path, line } = candidate
    const normalizedWorktreePath = worktreePath.replace(/\/+$/, "")
    if (path.startsWith("/")) {
      if (path.split("/").includes("..")) return null
      const externalAbsolute = !path.startsWith(`${normalizedWorktreePath}/`)
      const previewPath = externalAbsolute
        ? path
        : path.slice(normalizedWorktreePath.length + 1)
      return {
        checkPath: path,
        previewPath,
        line,
        image: IMAGE_FILE_EXTENSION.test(path),
        externalAbsolute,
      }
    }
    if (path.split("/").includes("..")) return null
    const checkPath = `${normalizedWorktreePath}/${path}`
    return {
      checkPath,
      previewPath: path,
      line,
      image: IMAGE_FILE_EXTENSION.test(checkPath),
      externalAbsolute: false,
    }
  }

  function detectLineLinks(lineText: string, worktreePath: string): ResolvedTerminalFileLink[] {
    const matches: ResolvedTerminalFileLink[] = []
    for (const candidate of detectTerminalFileLinkCandidates(lineText)) {
      const resolved = resolveFileLink(candidate, worktreePath)
      if (!resolved) continue
      matches.push({
        text: candidate.text,
        start: candidate.start,
        ...resolved,
      })
    }
    return matches
  }

  async function checkFileExists(checkPath: string): Promise<boolean> {
    if (fileExistsCache.has(checkPath)) return fileExistsCache.get(checkPath)!
    const exists = await fileExistsSafe(checkPath)
    if (exists) fileExistsCache.set(checkPath, true)
    return exists
  }

  function activateResolvedLink(link: ResolvedTerminalFileLink): void {
    if (link.image) {
      params.getContainer()?.dispatchEvent(new CustomEvent("image-link-activate", {
        bubbles: true,
        detail: { url: link.checkPath },
      }))
      return
    }
    params.getContainer()?.dispatchEvent(new CustomEvent("file-link-activate", {
      bubbles: true,
      detail: {
        path: link.previewPath,
        line: link.line,
        ...(link.externalAbsolute ? { localAbsolutePath: link.checkPath } : {}),
      },
    }))
  }

  async function findLatest(): Promise<ResolvedTerminalFileLink | null> {
    const worktreePath = params.options?.worktreePath
    if (!worktreePath) return null
    const buffer = params.term.buffer.active
    for (let row = buffer.length - 1; row >= 0; row -= 1) {
      const lineText = buffer.getLine(row)?.translateToString(true)
      if (!lineText) continue
      const matches = detectLineLinks(lineText, worktreePath)
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index]
        if (match && await checkFileExists(match.checkPath)) return match
      }
    }
    return null
  }

  function register(): void {
    const worktreePath = params.options?.worktreePath
    if (!worktreePath) return

    let tooltipEl: HTMLElement | null = null

    params.term.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
        const line = params.term.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) { callback(undefined); return }
        const matches = detectLineLinks(line.translateToString(true), worktreePath)
        if (matches.length === 0) { callback(undefined); return }

        Promise.all(matches.map(async (match) => {
          if (!await checkFileExists(match.checkPath)) return null
          const link: ILink = {
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.start + match.text.length, y: bufferLineNumber },
            },
            text: match.text,
            activate(event: MouseEvent) {
              if (event.metaKey) activateResolvedLink(match)
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
          const valid = links.filter((link): link is ILink => link !== null)
          callback(valid.length > 0 ? valid : undefined)
        })
      },
    })
  }

  return {
    register,
    findLatest,
    async activateLatest() {
      const link = await findLatest()
      if (!link) return false
      activateResolvedLink(link)
      return true
    },
    watchForFirstLink(onAvailable) {
      let disposed = false
      let announced = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const parsedDisposable = params.term.onWriteParsed(() => {
        if (disposed || announced) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          void findLatest().then((link) => {
            if (disposed || announced || !link) return
            announced = true
            parsedDisposable.dispose()
            onAvailable()
          })
        }, 250)
      })
      return () => {
        if (disposed) return
        disposed = true
        if (timer) clearTimeout(timer)
        parsedDisposable.dispose()
      }
    },
    clearFileExistsCache() {
      fileExistsCache.clear()
    },
  }
}
