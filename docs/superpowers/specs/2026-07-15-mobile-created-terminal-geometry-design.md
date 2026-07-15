# Mobile-Created Terminal Geometry Design

## Goal

Give interactive agent tasks created from the mobile app a terminal grid that is tall enough for agent TUIs on a phone while allowing larger devices such as iPads to use their additional space.

## Current Behavior and Root Cause

Kanna-server creates every interactive task PTY at `80x24`. The mobile terminal intentionally renders the daemon snapshot at its exact PTY dimensions and does not resize the shared session. As a result, a task created and viewed only from mobile remains 24 rows tall even though the mobile task-detail surface has room for substantially more rows.

Desktop-created tasks do not expose the problem in the same way because the desktop xterm sends its fitted dimensions to the daemon after attaching.

## Scope

- Apply mobile-selected initial geometry only to interactive PTY tasks created from the mobile app.
- Use `80x48` as the minimum mobile-created grid.
- Let larger mobile viewports produce larger grids without explicit phone-versus-iPad branching.
- Preserve exact daemon-grid rendering in the mobile WebView.
- Preserve the existing `80x24` server default for callers that omit initial terminal geometry.
- Leave headless agent sessions, teardown shells, existing tasks, and post-launch terminal resize ownership unchanged.

## Design

### Mobile Geometry Calculation

The app will retain the measured outer content size of the main shell. Task detail occupies that same content area after creation, so the measurement is available before the task is submitted.

A focused pure helper will convert that content size into initial terminal dimensions using the mobile terminal's existing fallback cell estimates and fullscreen composer inset:

```text
cols = max(80, floor(contentWidth / 8))
rows = max(48, floor((contentHeight - 132) / 17))
```

The minimum makes typical phones use `80x48`. An iPad-sized viewport naturally produces more columns and rows. The helper will normalize non-finite or non-positive measurements to the `80x48` fallback so task creation never depends on receiving a layout event first.

### Create-Task Contract

The mobile create-task request will add optional `terminalCols` and `terminalRows` fields. The mobile controller will always send the calculated pair for PTY task creation.

LAN, relay, cloud, and hybrid routing already forward the create-task body to the owning desktop. They will preserve the two fields while continuing to remove only the client-side `desktopId` routing field.

Kanna-server will deserialize the optional pair. When both values are present,
positive, and no larger than `320x256`, interactive PTY preparation will use
them for the daemon spawn. The upper bound keeps the headless terminal's
10,000-row scrollback budget below roughly 63 MiB while remaining well above
the grid produced by a phone or iPad. If either value is absent, zero, or over
the bound, preparation will use the existing `80x24` pair. Headless agent
sessions do not consume terminal geometry.

### Rendering and Session Ownership

The mobile WebView will continue to adopt the dimensions received in the daemon snapshot and render that exact grid. It will not send a post-launch resize. This preserves TUI row positioning and avoids turning a read-only mobile viewer into a competing resize owner when the same session is also open on desktop.

## Data Flow

```text
App shell layout
  -> mobile terminal geometry helper (minimum 80x48)
  -> mobileController.createTask
  -> CreateTaskRequest terminalCols/terminalRows
  -> LAN or remote create-task transport
  -> kanna-server task preparation
  -> daemon Spawn cols/rows
  -> terminal snapshot with the same grid
  -> mobile WebView exact-grid rendering
```

## Error Handling

- Missing or unusable mobile layout measurements fall back to `80x48`.
- Missing, partial, zero, or oversized geometry at the server falls back to
  `80x24`, preserving compatibility with existing clients and preventing
  pathological terminal allocations.
- Existing task-creation failure reporting remains responsible for transport or daemon spawn errors; terminal geometry introduces no separate user-facing error state.

## Testing

- Pure mobile geometry tests will cover phone-sized input, iPad-sized expansion, fractional dimensions, and invalid-measurement fallback.
- App/controller tests will verify that the measured geometry reaches the mobile create-task request and that the no-measurement path sends `80x48`.
- Mobile transport tests will verify that terminal geometry survives LAN and remote create-task routing.
- Kanna-server tests will verify that a prepared PTY uses requested geometry,
  that partial, zero, or oversized geometry falls back to `80x24`, that the
  `320x256` boundary is accepted, and that headless agent preparation remains
  unaffected.
- Existing mobile terminal rendering tests will continue to prove that snapshot dimensions are applied exactly.

## Success Criteria

- A task created on a typical phone starts with an `80x48` PTY instead of `80x24`.
- A task created on a larger viewport starts with more than `80x48` when the measured content area supports it.
- Tasks created by clients that do not send geometry retain the current `80x24` behavior.
- Mobile displays the created PTY grid without issuing a post-launch resize.
