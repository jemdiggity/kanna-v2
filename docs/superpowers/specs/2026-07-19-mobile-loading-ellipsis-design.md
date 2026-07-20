# Mobile Loading Ellipsis Design

## Goal

Replace ambiguous or static mobile loading states with a minimal, terminal-style animated ellipsis in the three primary waits: app startup, task creation, and task terminal or agent connection.

## Scope

The change covers:

- the app shell while persisted state and the initial connection bootstrap load;
- Tasks and Activity before their first complete task snapshot arrives;
- `Creating task` and `Recovering task` overlays;
- PTY terminal `Connecting` states;
- headless agent `Connecting` states.

Existing content remains visible during background refreshes. Static interrupted, offline, error, and genuinely empty states do not animate. Existing loading treatments for file preview, repository commands, and machine pairing are outside this change.

## Loading Presentation

Add a focused `LoadingText` component to the mobile component library. It renders a stable label followed by a fixed-width monospace ellipsis that cycles through `.`, `..`, and `...` on a short interval. Reserving the width of all three dots prevents surrounding content from shifting as the animation advances.

The component exposes a stable accessibility label such as `Connecting, loading`. The changing dots are hidden from accessibility so screen readers do not announce every animation frame. The component clears its interval when it unmounts.

The presentation stays text-only: no circular `ActivityIndicator`, custom vector, skeleton pulse, or decorative motion.

## Task Workspace Behavior

`TaskScreen` uses `LoadingText` inside its existing centered terminal overlay when:

- task creation is `pending` (`Creating task`);
- task creation is `recovering` (`Recovering task`);
- a PTY terminal is `idle` or `connecting` (`Connecting`).

The same overlay remains static for `uncertain`, `closed`, and `error` states. Recovery controls and error copy retain their current behavior.

`AgentMessageView` replaces its static `Connecting...` text with `LoadingText` while the agent stream status is `connecting`. Live events, stream errors, and completed content remain unchanged.

## Startup and Task Snapshot Readiness

The app already waits for `model.initialize()` before mounting navigation. During that wait, the app shell renders centered `Starting Kanna` loading text instead of an empty dark view.

Initialization can complete before the first live cloud task publication. Add an explicit task-collection load status to mobile session state so an empty array is not treated as proof that no tasks exist:

- initial state is `loading`;
- successful polled collection loading marks it `ready`;
- the first complete, authoritative live-cloud publication marks it `ready`;
- an initial collection or subscription failure marks it `error` so the loading state does not persist forever.

Tasks and Activity receive this status. While it is `loading` and their list is empty, they show centered `Loading tasks` text. A non-empty list is always rendered immediately. Once status is `ready`, an empty list shows the existing `No tasks yet.` copy. When status is `error`, the list shows a static load-failure message while the existing error banner retains the detailed error.

Background refreshes do not return the status to `loading` when task content is already available, so users can continue reading and navigating existing tasks.

## Data Flow

1. The session store begins with task collections marked `loading`.
2. `App` shows `Starting Kanna` until model initialization finishes.
3. The navigator mounts with the current task-collection status.
4. LAN/polled bootstrap marks collections ready after repos, recent tasks, repo tasks, and search reconciliation finish.
5. Live-cloud bootstrap remains loading until the first authoritative publication is applied.
6. Tasks and Activity switch from `Loading tasks` to task cards or the genuine empty state.
7. Later refreshes update content without replacing it with a loading screen.

## Error Handling

Animation is limited to states that are actively expected to make progress. A failed app initialization continues to show the existing initialization error. Task collection failures stop the ellipsis and show static failure copy. Task creation uncertainty continues to offer recovery without animation, and terminal or agent failures continue to show their existing error text.

## Testing

Tests will verify:

- `LoadingText` advances through one, two, and three dots, reserves dot width, supplies a stable accessibility label, and clears its timer;
- app startup shows `Starting Kanna` before initialization and removes it when navigation mounts;
- pending and recovering task creation render animated loading text, while uncertainty does not;
- PTY and agent connecting states render animated loading text, while live, offline, and error states do not;
- initial task collection state is loading;
- polled loads and authoritative cloud publications mark task collections ready;
- initial collection errors mark the status as error;
- Tasks and Activity do not show `No tasks yet.` before readiness, but do show it after a successful empty snapshot;
- background refreshes preserve visible tasks without a blocking loading state.

## Non-Goals

- replacing every existing mobile loading treatment;
- adding progress percentages or timeout estimates;
- changing task creation, terminal connection, cloud subscription, or retry semantics;
- changing desktop loading states;
- changing mobile OTA runtime compatibility, because the implementation is JavaScript-only.
