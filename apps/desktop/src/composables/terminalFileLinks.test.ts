import { afterEach, describe, expect, it, vi } from "vitest"
import { createTerminalFileLinkProvider } from "./terminalFileLinks"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}))

function createProviderForLines(lineTexts: string[]) {
  let registeredProvider: {
    provideLinks(bufferLineNumber: number, callback: (links: unknown[] | undefined) => void): void
  } | null = null
  const container = document.createElement("div")
  let writeParsedHandler: (() => void) | null = null

  const buffer = {
    length: lineTexts.length,
    getLine: vi.fn((index: number) => {
      const lineText = lineTexts[index]
      return lineText === undefined ? undefined : {
        translateToString: vi.fn(() => lineText),
      }
    }),
  }
  const term = {
    buffer: { active: buffer, normal: buffer },
    registerLinkProvider: vi.fn((provider) => {
      registeredProvider = provider
    }),
    onWriteParsed: vi.fn((handler: () => void) => {
      writeParsedHandler = handler
      return { dispose: () => { writeParsedHandler = null } }
    }),
  }

  const provider = createTerminalFileLinkProvider({
    term: term as never,
    options: { worktreePath: "/worktree" },
    getContainer: () => container,
  })
  provider.register()

  if (!registeredProvider) {
    throw new Error("expected terminal link provider to be registered")
  }

  return {
    container,
    provider,
    registeredProvider,
    fireWriteParsed: () => writeParsedHandler?.(),
  }
}

function createProviderForLine(lineText: string) {
  return createProviderForLines([lineText])
}

async function provideLinks(lineText: string): Promise<{
  container: HTMLElement
  links: unknown[] | undefined
}> {
  const { container, registeredProvider } = createProviderForLine(lineText)
  const links = await new Promise<unknown[] | undefined>((resolve) => {
    registeredProvider.provideLinks(1, resolve)
  })
  return { container, links }
}

function activateLink(link: unknown, event: MouseEvent = new MouseEvent("click", { metaKey: true })) {
  ;(link as { activate(event: MouseEvent): void }).activate(event)
}

async function provideLinkTexts(lineText: string): Promise<string[]> {
  const { links } = await provideLinks(lineText)
  return links?.map((link) => (link as { text: string }).text) ?? []
}

async function provideFirstLink(lineText: string): Promise<{
  container: HTMLElement
  link: unknown
}> {
  const { container, links } = await provideLinks(lineText)
  if (!links?.[0]) {
    throw new Error("expected at least one terminal link")
  }
  return { container, link: links[0] }
}

function waitForFileLinkActivation(container: HTMLElement): Promise<{ path: string; line?: number }> {
  return new Promise((resolve) => {
    container.addEventListener("file-link-activate", (event) => {
      resolve((event as CustomEvent).detail)
    }, { once: true })
  })
}

function waitForImageLinkActivation(container: HTMLElement): Promise<{ url: string }> {
  return new Promise((resolve) => {
    container.addEventListener("image-link-activate", (event) => {
      resolve((event as CustomEvent).detail)
    }, { once: true })
  })
}

describe("terminalFileLinks", () => {
  it("maps xterm's one-based provider rows to zero-based buffer lines", async () => {
    let registeredProvider: {
      provideLinks(bufferLineNumber: number, callback: (links: unknown[] | undefined) => void): void
    } | null = null
    const getLine = vi.fn((lineNumber: number) =>
      lineNumber === 0
        ? { translateToString: vi.fn(() => "README.md") }
        : null,
    )
    const term = {
      buffer: { active: { getLine } },
      registerLinkProvider: vi.fn((provider) => {
        registeredProvider = provider
      }),
    }
    invokeMock.mockResolvedValue(true)

    createTerminalFileLinkProvider({
      term: term as never,
      options: { worktreePath: "/worktree" },
      getContainer: () => document.createElement("div"),
    }).register()

    const links = await new Promise<unknown[] | undefined>((resolve) => {
      registeredProvider?.provideLinks(1, resolve)
    })

    expect(getLine).toHaveBeenCalledWith(0)
    expect(links).toHaveLength(1)
  })

  afterEach(() => vi.useRealTimers())

  it("announces only the first parsed valid link", async () => {
    vi.useFakeTimers()
    invokeMock.mockResolvedValue(true)
    const { provider, fireWriteParsed } = createProviderForLines(["See result.ts"])
    const onAvailable = vi.fn()
    const cleanup = provider.watchForFirstLink(onAvailable)

    fireWriteParsed()
    await vi.runAllTimersAsync()
    expect(onAvailable).toHaveBeenCalledOnce()

    fireWriteParsed()
    await vi.runAllTimersAsync()
    expect(onAvailable).toHaveBeenCalledOnce()

    cleanup()
  })

  it("activates the rightmost valid file on the newest matching buffer row", async () => {
    invokeMock.mockImplementation(async (_command: string, args: { path: string }) =>
      ["/worktree/older.ts", "/worktree/newer.ts"].includes(args.path)
    )
    const { container, provider } = createProviderForLines([
      "Changed older.ts",
      "Summary: missing.ts then newer.ts:41:7",
    ])
    const activation = waitForFileLinkActivation(container)

    await expect(provider.activateLatest()).resolves.toBe(true)
    await expect(activation).resolves.toEqual({ path: "newer.ts", line: 41 })
  })

  it("skips nonexistent recent candidates and rejects worktree traversal", async () => {
    invokeMock.mockImplementation(async (_command: string, args: { path: string }) =>
      args.path === "/worktree/safe.ts"
    )
    const { provider } = createProviderForLines([
      "Use safe.ts",
      "Ignore missing.ts, ../outside.ts, and /worktree/../outside.ts",
    ])

    await expect(provider.findLatest()).resolves.toMatchObject({
      previewPath: "safe.ts",
      checkPath: "/worktree/safe.ts",
    })
    expect(invokeMock).not.toHaveBeenCalledWith("file_exists", {
      path: "/worktree/../outside.ts",
    })
  })

  it("activates the latest image through the existing image event", async () => {
    invokeMock.mockResolvedValue(true)
    const { container, provider } = createProviderForLines(["See result.png"])
    const activation = waitForImageLinkActivation(container)

    await expect(provider.activateLatest()).resolves.toBe(true)
    await expect(activation).resolves.toEqual({ url: "/worktree/result.png" })
  })

  it("returns false when no worktree-backed link exists", async () => {
    const { provider } = createProviderForLines(["No links here"])

    await expect(provider.activateLatest()).resolves.toBe(false)
  })

  it("rechecks a path that did not exist during an earlier scan", async () => {
    invokeMock.mockReset()
    invokeMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const { provider } = createProviderForLines(["Created later.ts"])

    await expect(provider.findLatest()).resolves.toBeNull()
    await expect(provider.findLatest()).resolves.toMatchObject({
      previewPath: "later.ts",
    })
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it("links Copilot-style bare filenames and nested file paths", async () => {
    invokeMock.mockImplementation(async (command: string, args: { path: string }) => {
      return command === "file_exists" && (
        args.path === "/worktree/README.md" ||
        args.path === "/worktree/apps/desktop/src/App.vue"
      )
    })

    const { links } = await provideLinks("Updated README.md and apps/desktop/src/App.vue:31.")

    expect(links).toHaveLength(2)
    expect(links?.map((link) => (link as { text: string }).text)).toEqual([
      "README.md",
      "apps/desktop/src/App.vue:31",
    ])
  })

  it("links Codex-style absolute worktree paths and opens them as relative previews", async () => {
    invokeMock.mockImplementation(async (command: string, args: { path: string }) => {
      return command === "file_exists" && args.path === "/worktree/apps/desktop/src/App.vue"
    })

    const { container, link } = await provideFirstLink("See /worktree/apps/desktop/src/App.vue:31:7")
    const activation = waitForFileLinkActivation(container)

    activateLink(link)

    await expect(activation).resolves.toEqual({ path: "apps/desktop/src/App.vue", line: 31 })
    expect(await provideLinkTexts("See /worktree/apps/desktop/src/App.vue:31:7")).toEqual([
      "/worktree/apps/desktop/src/App.vue:31:7",
    ])
  })

  it("opens local image file links in the image preview instead of the text file preview", async () => {
    invokeMock.mockImplementation(async (command: string, args: { path: string }) => {
      return command === "file_exists" && args.path === "/worktree/simple-paper-boat.png"
    })

    const { container, link } = await provideFirstLink("Image: /worktree/simple-paper-boat.png")
    const imageActivation = waitForImageLinkActivation(container)
    let filePreviewActivated = false
    container.addEventListener("file-link-activate", () => {
      filePreviewActivated = true
    })

    activateLink(link)

    await expect(imageActivation).resolves.toEqual({ url: "/worktree/simple-paper-boat.png" })
    expect(filePreviewActivated).toBe(false)
  })
})
