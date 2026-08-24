import { describe, expect, it, vi } from "vitest"
import {
  createRemoteTerminalFileLinkProvider,
  resolveRemoteTerminalFileLinkPath,
} from "./remoteTerminalFileLinks"

function createProviderWithReadFile(
  lineText: string,
  readFile: (path: string) => Promise<string | null>,
) {
  let registeredProvider: {
    provideLinks(bufferLineNumber: number, callback: (links: unknown[] | undefined) => void): void
  } | null = null
  const container = document.createElement("div")

  const buffer = {
    length: 1,
    getLine: vi.fn((index: number) =>
      index === 0 ? { translateToString: vi.fn(() => lineText) } : undefined,
    ),
  }
  const term = {
    buffer: { active: buffer, normal: buffer },
    registerLinkProvider: vi.fn((provider) => {
      registeredProvider = provider
    }),
  }

  const provider = createRemoteTerminalFileLinkProvider({
    term: term as never,
    readFile,
    getContainer: () => container,
  })
  provider.register()

  if (!registeredProvider) {
    throw new Error("expected terminal link provider to be registered")
  }

  return { container, provider, registeredProvider }
}

function createProviderForLine(lineText: string, files: Record<string, string>) {
  const readFile = vi.fn(async (path: string) => files[path] ?? null)
  return { ...createProviderWithReadFile(lineText, readFile), readFile }
}

function probeLinks(registeredProvider: {
  provideLinks(bufferLineNumber: number, callback: (links: unknown[] | undefined) => void): void
}): Promise<unknown[] | undefined> {
  return new Promise((resolve) => {
    registeredProvider.provideLinks(1, resolve)
  })
}

async function provideLinks(lineText: string, files: Record<string, string>) {
  const { container, provider, registeredProvider, readFile } = createProviderForLine(lineText, files)
  const links = await probeLinks(registeredProvider)
  return { container, provider, links, readFile }
}

function waitForFileLinkActivation(container: HTMLElement): Promise<{
  path: string
  line?: number
  remoteContent?: string
}> {
  return new Promise((resolve) => {
    container.addEventListener("file-link-activate", (event) => {
      resolve((event as CustomEvent).detail)
    }, { once: true })
  })
}

describe("resolveRemoteTerminalFileLinkPath", () => {
  it("keeps relative paths and strips remote worktree roots from absolute paths", () => {
    expect(resolveRemoteTerminalFileLinkPath("src/main.ts")).toBe("src/main.ts")
    expect(
      resolveRemoteTerminalFileLinkPath("/Users/peer/repo/.kanna-worktrees/task-1/src/main.ts"),
    ).toBe("src/main.ts")
  })

  it("rejects absolute paths outside a Kanna worktree, traversal, and images", () => {
    expect(resolveRemoteTerminalFileLinkPath("/etc/passwd.conf")).toBeNull()
    expect(resolveRemoteTerminalFileLinkPath("../secrets.env")).toBeNull()
    expect(
      resolveRemoteTerminalFileLinkPath("/Users/peer/repo/.kanna-worktrees/task-1/../../x.ts"),
    ).toBeNull()
    expect(resolveRemoteTerminalFileLinkPath("docs/screenshot.png")).toBeNull()
  })
})

describe("remoteTerminalFileLinks", () => {
  it("lists workspace matches and marks out-of-workspace mentions unavailable", async () => {
    const { provider } = createProviderForLine(
      "See src/app.ts and /tmp/kanna-verification.txt",
      { "src/app.ts": "content" },
    )

    await expect(provider.listMentions()).resolves.toMatchObject({
      mentions: [
        {
          path: "/tmp/kanna-verification.txt",
          available: false,
          unavailableReason: "Outside the remote task workspace",
        },
        { path: "src/app.ts", available: true },
      ],
      overflow: false,
    })
  })

  it("links only paths that are readable on the remote task", async () => {
    const { links } = await provideLinks(
      "edited src/app.ts and missing.ts",
      { "src/app.ts": "content" },
    )
    expect(links?.map((link) => (link as { text: string }).text)).toEqual(["src/app.ts"])
  })

  it("returns no links when nothing on the line resolves", async () => {
    const { links } = await provideLinks("no file mentions here", {})
    expect(links).toBeUndefined()
  })

  it("activates on cmd+click with the freshly fetched remote content", async () => {
    const { container, links, readFile } = await provideLinks(
      "wrote src/app.ts:42",
      { "src/app.ts": "remote file body" },
    )
    const activation = waitForFileLinkActivation(container)
    ;(links?.[0] as { activate(event: MouseEvent): void }).activate(
      new MouseEvent("click", { metaKey: true }),
    )
    await expect(activation).resolves.toEqual({
      path: "src/app.ts",
      line: 42,
      remoteContent: "remote file body",
    })
    // once for the existence check, once refreshed on activation
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("ignores plain clicks without the meta key", async () => {
    const { container, links, readFile } = await provideLinks(
      "wrote src/app.ts",
      { "src/app.ts": "content" },
    )
    const listener = vi.fn()
    container.addEventListener("file-link-activate", listener)
    ;(links?.[0] as { activate(event: MouseEvent): void }).activate(new MouseEvent("click"))
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it("caches existence checks per path until the cache is cleared", async () => {
    const { provider, registeredProvider, readFile } = createProviderForLine(
      "wrote src/app.ts",
      { "src/app.ts": "content" },
    )
    await probeLinks(registeredProvider)
    await probeLinks(registeredProvider)
    expect(readFile).toHaveBeenCalledTimes(1)

    provider.clearFileCache()
    await probeLinks(registeredProvider)
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("shares one in-flight read across concurrent probes of the same path", async () => {
    const readFile = vi.fn(async () => "content")
    const { registeredProvider } = createProviderWithReadFile("wrote src/app.ts", readFile)

    const [first, second] = await Promise.all([
      probeLinks(registeredProvider),
      probeLinks(registeredProvider),
    ])

    expect(readFile).toHaveBeenCalledTimes(1)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })

  it("retries a path that was missing during an earlier probe", async () => {
    // A path the agent has not written yet must not be pinned as unresolvable:
    // the next probe has to retry so the link appears once the file lands.
    const readFile = vi.fn<(path: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("content that landed later")
    const { registeredProvider } = createProviderWithReadFile("wrote src/app.ts", readFile)

    await expect(probeLinks(registeredProvider)).resolves.toBeUndefined()
    expect(await probeLinks(registeredProvider)).toHaveLength(1)
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("retries a path whose earlier read failed on the transport", async () => {
    // A relay/LAN read that failed must not pin the path either — the next
    // probe retries once the connection recovers.
    const readFile = vi.fn<(path: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("relay offline"))
      .mockResolvedValueOnce("content after recovery")
    const { registeredProvider } = createProviderWithReadFile("wrote src/app.ts", readFile)

    await expect(probeLinks(registeredProvider)).resolves.toBeUndefined()
    expect(await probeLinks(registeredProvider)).toHaveLength(1)
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("activates a recovered path without needing the cache cleared", async () => {
    const readFile = vi.fn<(path: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("relay offline"))
      .mockResolvedValue("recovered body")
    const { container, registeredProvider } = createProviderWithReadFile(
      "wrote src/app.ts:7",
      readFile,
    )

    await expect(probeLinks(registeredProvider)).resolves.toBeUndefined()
    const links = await probeLinks(registeredProvider)

    const activation = waitForFileLinkActivation(container)
    ;(links?.[0] as { activate(event: MouseEvent): void }).activate(
      new MouseEvent("click", { metaKey: true }),
    )
    await expect(activation).resolves.toEqual({
      path: "src/app.ts",
      line: 7,
      remoteContent: "recovered body",
    })
  })

  it("treats a failing remote read as a missing file", async () => {
    const { registeredProvider } = createProviderWithReadFile("wrote src/app.ts", async () => {
      throw new Error("relay offline")
    })

    await expect(probeLinks(registeredProvider)).resolves.toBeUndefined()
  })
})
