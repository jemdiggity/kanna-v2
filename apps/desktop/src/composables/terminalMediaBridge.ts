export interface ClipboardImagePayload {
  mimeType: "image/png"
  pngBase64: string
  width: number
  height: number
}

export interface KittyClipboardReadRequest {
  mimeTypes: string[]
}

export interface KittyClipboardParseResult {
  requests: KittyClipboardReadRequest[]
  remainder: string
}

const OSC_PREFIX = "\u001b]5522;"
const BEL_TERMINATOR = "\u0007"
const ST_TERMINATOR = "\u001b\\"
const BRACKETED_PASTE_ENABLE = "\u001b[?2004h"
const BRACKETED_PASTE_DISABLE = "\u001b[?2004l"

export function formatDroppedPathsForPaste(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ")
}

export function encodeTerminalPasteBytes(text: string, bracketed: boolean): Uint8Array {
  const payload = bracketed ? `\u001b[200~${text}\u001b[201~` : text
  return new TextEncoder().encode(payload)
}

export function updateBracketedPasteMode(current: boolean, chunkText: string): boolean {
  let next = current
  if (chunkText.includes(BRACKETED_PASTE_ENABLE)) next = true
  if (chunkText.includes(BRACKETED_PASTE_DISABLE)) next = false
  return next
}

export function collectKittyClipboardRequests(buffer: string): KittyClipboardParseResult {
  const requests: KittyClipboardReadRequest[] = []
  let cursor = 0

  while (cursor < buffer.length) {
    const start = buffer.indexOf(OSC_PREFIX, cursor)
    if (start < 0) {
      return { requests, remainder: "" }
    }

    const belEnd = buffer.indexOf(BEL_TERMINATOR, start + OSC_PREFIX.length)
    const stEnd = buffer.indexOf(ST_TERMINATOR, start + OSC_PREFIX.length)
    const endCandidates = [belEnd, stEnd].filter((value) => value >= 0)
    if (endCandidates.length === 0) {
      return { requests, remainder: buffer.slice(start) }
    }

    const end = Math.min(...endCandidates)
    const terminatorLength = end === stEnd ? ST_TERMINATOR.length : BEL_TERMINATOR.length
    const body = buffer.slice(start + OSC_PREFIX.length, end)
    const request = parseKittyClipboardReadRequest(body)
    if (request) {
      requests.push(request)
    }
    cursor = end + terminatorLength
  }

  return { requests, remainder: "" }
}

export function buildKittyClipboardResponse(payload: ClipboardImagePayload): string {
  const encodedMime = btoa(payload.mimeType)
  return [
    `${OSC_PREFIX}type=read:status=OK${BEL_TERMINATOR}`,
    `${OSC_PREFIX}type=read:status=DATA:mime=${encodedMime};${payload.pngBase64}${BEL_TERMINATOR}`,
    `${OSC_PREFIX}type=read:status=DONE${BEL_TERMINATOR}`,
  ].join("")
}

function parseKittyClipboardReadRequest(body: string): KittyClipboardReadRequest | null {
  const separator = body.indexOf(";")
  const metadata = separator >= 0 ? body.slice(0, separator) : body
  const payload = separator >= 0 ? body.slice(separator + 1) : ""

  if (!metadata.includes("type=read")) {
    return null
  }
  if (!payload) {
    return { mimeTypes: [] }
  }

  try {
    const decoded = atob(payload)
    const mimeTypes = decoded
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    return { mimeTypes }
  } catch (error) {
    console.debug("[terminal-media] failed to decode clipboard MIME payload:", error)
    return null
  }
}

function shellEscapePath(path: string): string {
  return `'${path.replaceAll("'", `'\"'\"'`)}'`
}
