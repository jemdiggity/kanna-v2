import { getAppErrorMessage } from "../appError"
import { isTauri } from "../tauri-mock"
import type { TerminalOptions } from "./terminalTypes"

const NATIVE_DROP_DEDUPE_WINDOW_MS = 100

interface NativeDropPosition {
  x?: number
  y?: number
  toLogical?: (scaleFactor: number) => { x: number; y: number }
}

export interface TerminalDropBridge {
  registerContainerDropHandlers(): (() => void) | null
  isDropWithinContainer(dropPosition: NativeDropPosition): boolean
  shouldHandleNativeDrop(paths: string[]): boolean
  resetNativeDropDedupe(): void
}

export function createTerminalDropBridge(params: {
  sessionId: string
  instanceId: string
  options?: TerminalOptions
  getContainer: () => HTMLElement | null
  isDisposed: () => boolean
  sendDroppedPaths: (paths: string[]) => void
  onNativeDropCleanupReady: (cleanup: () => void) => void
}): TerminalDropBridge {
  let lastNativeDropSignature: string | null = null
  let lastNativeDropAt = 0

  function shouldHandleNativeDrop(paths: string[]) {
    const signature = paths.join("\u0000")
    const now = Date.now()
    if (
      lastNativeDropSignature === signature &&
      now - lastNativeDropAt <= NATIVE_DROP_DEDUPE_WINDOW_MS
    ) {
      return false
    }
    lastNativeDropSignature = signature
    lastNativeDropAt = now
    return true
  }

  function isDropWithinContainer(dropPosition: NativeDropPosition) {
    const container = params.getContainer()
    if (!container) return false
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false

    const candidates = [
      typeof dropPosition.x === "number" && typeof dropPosition.y === "number"
        ? { x: dropPosition.x, y: dropPosition.y }
        : null,
      typeof dropPosition.toLogical === "function"
        ? dropPosition.toLogical(window.devicePixelRatio || 1)
        : null,
      typeof dropPosition.x === "number" && typeof dropPosition.y === "number"
        ? {
            x: dropPosition.x / (window.devicePixelRatio || 1),
            y: dropPosition.y / (window.devicePixelRatio || 1),
          }
        : null,
    ].filter((position): position is { x: number; y: number } => position !== null)

    return candidates.some((position) => {
      return (
        position.x >= rect.left &&
        position.x <= rect.right &&
        position.y >= rect.top &&
        position.y <= rect.bottom
      )
    })
  }

  function registerContainerDropHandlers(): (() => void) | null {
    if (!params.options?.agentTerminal) {
      return null
    }

    const container = params.getContainer()
    if (!container) {
      return null
    }

    const suppressDragNavigation = (event: DragEvent) => {
      if ((event.dataTransfer?.files?.length ?? 0) === 0) return
      event.preventDefault()
      event.stopPropagation()
    }

    const handleDrop = (event: DragEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (isTauri) {
        return
      }

      const files = Array.from(event.dataTransfer?.files ?? [])
      const paths = files
        .map((file) => (file as File & { path?: string }).path ?? "")
        .filter((path): path is string => path.length > 0)

      params.sendDroppedPaths(paths)
    }

    container.addEventListener("dragenter", suppressDragNavigation)
    container.addEventListener("dragover", suppressDragNavigation)
    container.addEventListener("drop", handleDrop)

    if (isTauri) {
      void Promise.all([
        import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
          return getCurrentWindow().onDragDropEvent((event) => {
            if (event.payload.type !== "drop") return
            if (!isDropWithinContainer(event.payload.position)) return
            if (!shouldHandleNativeDrop(event.payload.paths)) return
            params.sendDroppedPaths(event.payload.paths)
          })
        }),
        import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
          return getCurrentWebview().onDragDropEvent((event) => {
            if (event.payload.type !== "drop") return
            if (!isDropWithinContainer(event.payload.position)) return
            if (!shouldHandleNativeDrop(event.payload.paths)) return
            params.sendDroppedPaths(event.payload.paths)
          })
        }),
      ]).then((unlisteners) => {
        const cleanup = () => {
          for (const unlisten of unlisteners) {
            unlisten()
          }
        }

        if (params.isDisposed()) {
          cleanup()
          return
        }
        params.onNativeDropCleanupReady(cleanup)
      }).catch((error) => {
        console.warn("[terminal][drop] failed to register native drag-drop listener", {
          sessionId: params.sessionId,
          instanceId: params.instanceId,
          error: getAppErrorMessage(error),
        })
      })
    }

    return () => {
      params.getContainer()?.removeEventListener("dragenter", suppressDragNavigation)
      params.getContainer()?.removeEventListener("dragover", suppressDragNavigation)
      params.getContainer()?.removeEventListener("drop", handleDrop)
    }
  }

  return {
    registerContainerDropHandlers,
    isDropWithinContainer,
    shouldHandleNativeDrop,
    resetNativeDropDedupe() {
      lastNativeDropSignature = null
      lastNativeDropAt = 0
    },
  }
}
