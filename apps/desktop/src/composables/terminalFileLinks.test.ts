import { describe, expect, it, vi } from "vitest"
import { createTerminalFileLinkProvider } from "./terminalFileLinks"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}))

function createProviderForLine(lineText: string) {
  let registeredProvider: {
    provideLinks(bufferLineNumber: number, callback: (links: unknown[] | undefined) => void): void
  } | null = null
  const container = document.createElement("div")

  const term = {
    buffer: {
      active: {
        getLine: vi.fn(() => ({
          translateToString: vi.fn(() => lineText),
        })),
      },
    },
    registerLinkProvider: vi.fn((provider) => {
      registeredProvider = provider
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

  return { container, registeredProvider }
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

describe("terminalFileLinks", () => {
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
})
