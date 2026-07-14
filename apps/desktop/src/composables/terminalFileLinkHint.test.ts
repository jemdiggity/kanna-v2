import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  FILE_LINK_HINT_STORAGE_KEY,
  showTerminalFileLinkHintOnce,
} from "./terminalFileLinkHint"

beforeEach(() => localStorage.clear())

describe("terminalFileLinkHint", () => {
  it("stores the version before showing the discovery toast", () => {
    const info = vi.fn(() => {
      expect(localStorage.getItem(FILE_LINK_HINT_STORAGE_KEY)).toBe("1")
    })

    expect(showTerminalFileLinkHintOnce(localStorage, info, "hint")).toBe(true)
    expect(info).toHaveBeenCalledWith("hint")
  })

  it("suppresses later discovery events", () => {
    const info = vi.fn()

    showTerminalFileLinkHintOnce(localStorage, info, "hint")

    expect(showTerminalFileLinkHintOnce(localStorage, info, "hint")).toBe(false)
    expect(info).toHaveBeenCalledTimes(1)
  })
})
