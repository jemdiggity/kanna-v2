import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearTerminalFileLinkRegistryForTests,
  openLatestTerminalFileLink,
  registerTerminalFileLinkProvider,
} from "./terminalFileLinkRegistry"

afterEach(clearTerminalFileLinkRegistryForTests)

describe("terminalFileLinkRegistry", () => {
  it("opens through the provider registered for a session", async () => {
    const activateLatest = vi.fn(async () => true)
    registerTerminalFileLinkProvider("task-1", { activateLatest })

    await expect(openLatestTerminalFileLink("task-1")).resolves.toBe(true)
    expect(activateLatest).toHaveBeenCalledOnce()
  })

  it("does not let stale cleanup remove a replacement provider", async () => {
    const cleanup = registerTerminalFileLinkProvider("task-1", {
      activateLatest: vi.fn(async () => false),
    })
    const replacement = vi.fn(async () => true)
    registerTerminalFileLinkProvider("task-1", { activateLatest: replacement })

    cleanup()

    await expect(openLatestTerminalFileLink("task-1")).resolves.toBe(true)
    expect(replacement).toHaveBeenCalledOnce()
  })

  it("returns false without a registered provider", async () => {
    await expect(openLatestTerminalFileLink("missing")).resolves.toBe(false)
  })
})
