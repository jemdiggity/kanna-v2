# Desktop Window Layout Resume Design

## Goal

Restore every open desktop window at its last saved position and size when Kanna relaunches, while keeping a window reachable if its former display is no longer available.

## Context and root cause

Kanna already persists the durable open-window set in the `window_workspace_v1` setting. Each row records a stable window ID, selection, sidebar state, and display order. On launch, the primary window restores the additional saved window IDs, but both the primary and secondary windows use the fixed `1200 × 800` defaults from Tauri configuration or `spawnWindow`. No component currently captures or restores per-window native geometry.

Kanna previously used `tauri-plugin-window-state` as process-global native state. That integration was deliberately removed after stale state could restore the main window below Kanna's minimum usable size. This change will not reintroduce that plugin or its separate `.window-state.json` source of truth.

## Architecture

The existing `window_workspace_v1` snapshot remains the single source of truth for the restorable desktop workspace. Each `WorkspaceWindowState` gains an optional `geometry` value containing the native outer-window position and size. Optional geometry keeps existing persisted snapshots backward compatible: a window without saved geometry opens at the current `1200 × 800` default.

The frontend owns native geometry observation because it already owns creation and restoration of dynamic webview windows. The server continues to serialize concurrent workspace updates through its existing atomic setting mutation endpoint. A new `updateGeometry` mutation changes only the matching durable window row and never recreates a window whose membership has already been removed.

## Geometry capture

After a window has initialized its workspace membership, it registers Tauri move and resize listeners on the current native window. A shared debounce coalesces the burst of events produced while dragging or resizing. When the debounce fires, the controller reads the current outer position and outer size together and sends one `updateGeometry` mutation.

The geometry update uses the controller's existing per-window mutation queue. This preserves ordering with selection/sidebar updates and lets `forgetCurrentWindow` wait for pending geometry persistence before it captures and removes the durable row. Listener registration and timer cleanup belong to the app lifecycle and run during unmount.

Geometry is not inferred during application shutdown. Persisting during user interaction ensures the last stable bounds are already durable even when macOS terminates the process without giving asynchronous frontend cleanup time.

## Geometry restoration

Secondary windows receive their saved geometry in `WebviewWindow` creation options. The main window already exists before the frontend can read the server snapshot, so its controller applies saved geometry after initialization through the current Tauri window API.

Before applying geometry, the frontend compares the saved rectangle with the available monitors. A saved rectangle is accepted when it intersects a monitor's work area. If it is fully off-screen, Kanna keeps the saved size, clamps it to the selected monitor's usable dimensions and Kanna's minimum size, and positions it within an available monitor. The current monitor is preferred when available, followed by the primary monitor. Invalid, non-finite, non-positive, or undersized persisted values fall back to the current default geometry rather than being applied.

The restore path must not immediately overwrite saved geometry with transient creation bounds. Native observation begins only after the initial saved geometry has been applied.

## Data contract

The window state shape adds:

```ts
interface WorkspaceWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WorkspaceWindowState extends WindowBootstrap {
  sidebarHidden: boolean;
  sidebarWidth: number;
  order: number;
  geometry: WorkspaceWindowGeometry | null;
}
```

The mutation contract adds:

```ts
{
  operation: "updateGeometry";
  windowId: string;
  geometry: WorkspaceWindowGeometry;
}
```

Rust uses the matching optional serializable structure. Normalization validates geometry independently of sidebar and order normalization. Legacy rows that omit `geometry` deserialize to `None`/`null`.

## Error handling

Failure to inspect monitors or apply saved bounds is non-fatal. Kanna logs the error and retains the native default window bounds. Failure to persist a move or resize is logged by the lifecycle listener and does not block window use.

An explicit Close Window action keeps its current semantics: it removes the window from the restorable workspace. A normal app quit keeps all membership rows and their last durably observed geometry.

## Testing

- TypeScript unit tests verify geometry parsing/normalization, legacy snapshot compatibility, mutation behavior, and creation options for restored secondary windows.
- Tauri-facing unit tests verify that the current window's saved geometry is applied before observation begins and that native move/resize events coalesce into a durable update.
- Rust server tests verify `updateGeometry`, missing-window behavior, validation, and preservation through unrelated mutations.
- A desktop E2E test moves and resizes multiple windows, relaunches the app through the supported test harness, and checks that each stable window ID returns near its saved rectangle.
- An E2E or focused integration case simulates an unavailable display and verifies the restored window remains reachable. If the current WebDriver surface cannot change monitor topology, this behavior will be covered by pure rectangle/monitor tests and documented in a dated E2E gap note.

## Scope

This change restores normal position and size only. It does not persist minimized, maximized, fullscreen, focus, or z-order state, and it does not change the durable open-window membership model.
