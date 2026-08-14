# React Native Mobile Client Design

Date: 2026-04-17
Status: Proposed
Scope: Kanna iPhone-first React Native client for remote control of desktop-hosted agent workflows

## Summary

Kanna's mobile app should be rebuilt as an iPhone-first React Native client.
The mobile app is not a local execution environment: coding agent CLIs will continue to run on a desktop-hosted system and, later, potentially on cloud-hosted infrastructure.

The first React Native version should target a companion-client use case with light control:

- Browse repos and tasks
- View a pan-repo recent task feed
- Search tasks across repos
- Open a task and stream terminal output
- Send terminal input
- Run a small set of task actions such as close task and run merge agent

The mobile app should support both free local-network access and paid remote access. Both modes should expose the same logical Kanna API and resource model.

## Goals

- Replace the current mobile prototype with a React Native app that can feel native on iPhone
- Preserve a single logical mobile API across LAN and Remote connection modes
- Support multiple desktop connections from the first release
- Keep the desktop-hosted system as the initial source of truth
- Avoid coupling the mobile client to desktop Tauri commands or UI internals
- Create a clean service boundary that can support a future hosted relay/service layer

## Non-Goals

- Running agent CLIs directly on the phone
- Full parity with the desktop app in the first mobile release
- Rebuilding all desktop workflows, modals, and power-user features for mobile
- Requiring a Kanna account for free local-network pairing
- Turning the first remote implementation into a full cloud execution backend

## Product Model

The mobile app is a remote client for manipulating desktop-hosted work.

The desktop environment remains responsible for:

- Git worktrees
- Agent session lifecycle
- Task state and persistence
- PTY session management
- Task actions that mutate repo or session state

The mobile app remains responsible for:

- Connection and pairing UX
- Desktop selection and switching UX
- Browsing and searching tasks
- Realtime viewing of session output
- Sending limited operator input and actions
- Presenting clear connectivity and availability states

## Architecture Overview

The mobile architecture should center on a desktop-side Kanna API service.
The React Native app must not talk directly to the desktop UI process and must not talk directly to the raw PTY daemon protocol.

The initial system boundary should be:

- React Native client
- Kanna API service on the desktop side
- Local database, task logic, and PTY daemon behind that service

The desktop-side Kanna API service can be the existing `kanna-server` layer or an evolved successor. It is the mobile-facing contract boundary.

### Logical Topology

LAN mode:

`React Native app -> desktop-side Kanna API -> DB/task logic/PTY daemon`

Remote mode:

`React Native app -> Kanna hosted service/relay -> desktop-side Kanna API -> DB/task logic/PTY daemon`

In both cases, the mobile client should interact with the same typed API and the same resource model.

## Backend Boundary

The desktop-side Kanna API service should own:

- Repo and task listing
- Recent activity queries
- Search queries
- Session attach and detach
- Terminal input forwarding
- Task actions exposed to mobile
- Pairing and trusted-device validation
- Presence and desktop availability reporting
- Remote auth/session validation for paid access

The PTY daemon remains an internal subsystem used by the desktop-side Kanna API service for session attachment and output streaming. It should not become a public mobile protocol.

The desktop UI is not the mobile contract boundary. It may embed, launch, or coexist with the Kanna API service, but mobile should not depend on desktop view/store internals.

## Connection Modes

The mobile product should support two connection modes from the start:

- `LAN`: free local-network access without cloud infrastructure
- `Remote`: paid internet access mediated by Kanna infrastructure

Both modes should present the same product surface to the mobile app. The difference is transport and identity, not endpoint shape.
The app must support connecting to multiple desktops from the start, across both LAN and Remote modes.

### LAN

- No Kanna account required
- Direct connection from phone to desktop-side Kanna API on the local network
- Primary pairing flow is QR-based
- Manual host entry exists as a fallback
- Pairing establishes a revocable trusted-device relationship with that desktop
- The phone may pair with multiple LAN desktops and choose between them

### Remote

- Requires a Kanna account
- Desktop signs into the same account and maintains an outbound persistent connection to Kanna's hosted service
- Mobile connects to Kanna's hosted service and is routed to the paired desktop through that outbound connection
- No user port-forwarding or direct machine exposure
- Hosted infrastructure is responsible for auth, presence, routing, and relay/tunnel behavior, not task execution
- A signed-in user may have multiple registered remote desktops available in the same account

## Identity and Pairing

Identity should differ by mode:

- `LAN`: anonymous/local pairing is allowed
- `Remote`: sign-in is required

This separation preserves the free local-companion story and avoids forcing cloud identity into the offline/local path.

### LAN Pairing Flow

1. User opens pairing in the desktop app
2. Desktop generates a short-lived pairing token and encodes connection metadata into a QR code
3. Phone scans the QR code and establishes trust with the desktop-side Kanna API
4. Desktop stores the device relationship and can later revoke it
5. Phone can reconnect without rescanning until revoked or expired

Manual host entry should be available when QR is impractical.
The mobile app should maintain a list of paired desktops rather than assuming a single active desktop.

## API Design

The mobile contract should be product-oriented, not desktop-command-oriented.
Even if the initial implementation reuses existing internal commands, the external API should be modeled around stable resources and actions.

### Core Resources

- Desktops
- Repos
- Tasks
- Sessions
- Terminal streams
- Pairings
- Auth/presence state

### v1 Capabilities

- List available desktops and their availability state
- Select an active desktop
- List repos
- List tasks by repo
- Build a pan-repo recent-task feed
- Search tasks across repos
- Get task detail for the task screen
- Attach to a session stream
- Detach from a session stream
- Send terminal input
- Run a small action set, initially `close task` and `run merge agent`

### Explicitly Out of Scope for v1

- New task creation from mobile
- Full stage-promotion flows unless the server-side workflow is already exposed cleanly
- Full PR review and merge workflows
- Broad DB-query passthrough as a permanent product API
- Recreating desktop-only modal workflows

### Realtime Model

Realtime should be subscription-based.

The mobile client needs push-style updates for:

- Terminal output
- Session exit events
- Task activity/status changes
- Desktop presence changes

Polling may exist as a fallback, but it should not be the primary interaction model.

## React Native Client Structure

The React Native app should be organized around product surfaces and a typed Kanna client.

### Screens

- `Desktops`: paired and available desktops, grouped by connection mode where useful
- `Tasks`: repo-grouped task list
- `Recent`: pan-repo feed sorted by most recent updates
- `Search`: global task jump/search
- `Task`: terminal-first task detail with lightweight actions
- `Connection`: pairing, signed-in desktops, reconnect, and availability flows

### Internal Layers

- `transport`: LAN direct and Remote relay implementations behind a shared interface
- `api client`: typed Kanna endpoints and realtime subscriptions
- `product UI`: iPhone-first screens and flows

### State Model

- `session state`: auth, paired desktops, selected desktop, active transport mode
- `query state`: repos, tasks, recent items, search results
- `realtime state`: terminal buffers, live task updates, presence
- `ui state`: active tab, selected task, sheets, input composer visibility

The selected desktop is an explicit part of application state. The app should not assume a single global desktop forever; users must be able to switch desktops intentionally and see which desktop their current data is coming from.

The RN UI should never speak directly in terms of Tauri invokes or desktop stores. It should only consume the typed Kanna client.

## UX Scope for the First Release

The first React Native release should be treated as iPhone-first.
Android parity is not required for the first milestone.

The first release should be a useful companion client rather than a full desktop replacement.

Required v1 user flows:

- Connect locally to a desktop
- Sign in and connect remotely to a desktop
- Pair or register more than one desktop
- Switch between desktops
- Browse tasks grouped by repo
- View a recent feed across repos
- Search tasks
- Open a task
- Stream terminal output
- Send terminal input
- Invoke a small action set

Not required in v1:

- Full mobile task authoring
- Advanced review flows
- Full parity with desktop command palette behavior
- Full workflow/stage management UI

## Reliability Model

This is a remote-control system, so connectivity failures are first-class product states.

The mobile UI should explicitly represent:

- Not signed in
- Not paired
- No desktops available
- Selected desktop offline
- Desktop offline
- LAN unreachable
- Remote relay unavailable
- Session ended
- Action failed

Terminal attachment must support reattach semantics after:

- App backgrounding
- Mobile network changes
- Desktop restarts
- Temporary transport interruption

Task and search data can refetch on reconnect. Session streams should resume through explicit reattachment, not optimistic local buffering that assumes uninterrupted connectivity.

## Security Model

- The phone should not receive raw daemon credentials
- The phone should not gain arbitrary machine access
- All permissions should flow through the desktop-side Kanna API
- LAN trusted devices must be revocable per desktop
- Remote access must require account identity and desktop registration
- Desktop identity must be explicit so a user can distinguish and revoke individual paired machines
- The hosted service should relay and authorize access, not execute task logic directly in v1

## Migration Plan

The current mobile Tauri app should be treated as a prototype.
The React Native client should be built in parallel against the desktop-side Kanna API.

### Phase 1: Stabilize the Kanna API

- Define typed endpoints and subscriptions for the v1 mobile surface
- Move away from ad hoc mobile-facing desktop internals
- Ensure the API is the same logical contract for LAN and Remote

### Phase 2: Build the iPhone-First React Native Client

- Connection and pairing
- Tasks
- Recent
- Search
- Task terminal
- Basic task actions

### Phase 3: Desktop Alignment

- Decide whether desktop should gradually consume more of the same service boundary
- Do not block the RN app on a full desktop architectural rewrite

## Testing Strategy

Testing should align with the service boundary.

### API Contract Tests

Add coverage for:

- Desktop listing and selection
- Repo listing
- Task listing
- Recent feed queries
- Search
- Session attach/detach
- Terminal input
- Task actions

### Transport Tests

Run the same client-behavior suite against:

- LAN transport
- Remote transport

This ensures connection mode does not leak into product behavior.

### React Native Product Tests

Focus first on:

- Connection flows
- Multi-desktop selection flows
- Pairing flows
- Task navigation
- Terminal streaming states
- Reconnect behavior
- Failure-state rendering

### Manual iPhone-First Testing

Cover:

- Switching between multiple paired desktops
- Foreground/background transitions
- Wi-Fi to cellular transitions
- Desktop sleep/wake
- Desktop restart while app is open
- Session reattach after interruption

## Key Decisions

- Use React Native for the next mobile app
- Mobile is always a remote client
- Desktop-side Kanna API is the mobile contract boundary
- Desktop remains the first source of truth
- Support both LAN and Remote
- Support multiple desktops from day one
- LAN is free and does not require an account
- Remote is paid and requires Kanna infrastructure plus desktop outbound connection
- One logical API across both connection modes
- QR pairing first, manual host entry as fallback
- iPhone-first scope for the first RN milestone
- v1 mobile scope is browse/search/terminal/light-control, not full desktop parity

## Open Questions Deferred

- Whether desktop should eventually use the same Kanna API boundary internally
- Exact hosted-service protocol for remote relay and presence
- Final action surface beyond `close task` and `run merge agent`
- When task creation and stage promotion move into mobile scope
