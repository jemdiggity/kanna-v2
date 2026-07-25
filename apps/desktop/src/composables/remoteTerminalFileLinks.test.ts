import { describe, expect, it, vi } from "vitest"
import {
  createRemoteTerminalFileLinkProvider,
  resolveRemoteTerminalFileLinkPath,
} from "./remoteTerminalFileLinks"

function createProviderForLine(lineText: string, files: Record<string, string>) {
  let registeredProvider: {
    provideLinks(bufferLineNumber: number, callback: (links: unknown[] | undefined) => void): void
  } | null = null
  const container = document.createElement("div")
  const readFile = vi.fn(async (path: string) => files[path] ?? null)

  const term = {
    buffer: {
      active: {
        length: 1,
        getLine: vi.fn((index: number) =>
          index === 0 ? { translateToString: vi.fn(() => lineText) } : undefined,
        ),
      },
    },
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

  return { container, provider, registeredProvider, readFile }
}

async function provideLinks(lineText: string, files: Record<string, string>) {
  const { container, provider, registeredProvider, readFile } = createProviderForLine(lineText, files)
  const links = await new Promise<unknown[] | undefined>((resolve) => {
    registeredProvider.provideLinks(1, resolve)
  })
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
    await new Promise((resolve) => registeredProvider.provideLinks(1, resolve))
    await new Promise((resolve) => registeredProvider.provideLinks(1, resolve))
    expect(readFile).toHaveBeenCalledTimes(1)

    provider.clearFileCache()
    await new Promise((resolve) => registeredProvider.provideLinks(1, resolve))
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("treats a failing remote read as a missing file", async () => {
    let registeredProvider: {
      provideLinks(bufferLineNumber: number, callback: (links: unknown[] | undefined) => void): void
    } | null = null
    const term = {
      buffer: {
        active: {
          length: 1,
          getLine: vi.fn(() => ({ translateToString: vi.fn(() => "wrote src/app.ts") })),
        },
      },
      registerLinkProvider: vi.fn((provider) => {
        registeredProvider = provider
      }),
    }
    const provider = createRemoteTerminalFileLinkProvider({
      term: term as never,
      readFile: vi.fn(async () => {
        throw new Error("relay offline")
      }),
      getContainer: () => null,
    })
    provider.register()
    const links = await new Promise<unknown[] | undefined>((resolve) => {
      registeredProvider?.provideLinks(1, resolve)
    })
    expect(links).toBeUndefined()
  })
})
