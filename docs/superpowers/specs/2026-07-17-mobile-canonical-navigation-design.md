# Mobile Canonical Navigation Design

## Goal

Replace the mobile app's hand-rolled view switching with canonical React Navigation stack and tab navigators. Opening task detail must push a route, and Back must return to the exact screen that opened it, including Activity and Search.

## Current Problem

`App.tsx` renders screens by switching on `SessionState.activeView`. `mobileController.openTask()` also unconditionally changes `activeView` to `tasks`. Selecting a task from Activity therefore destroys the originating route before task detail appears, so Back reveals Tasks.

The same state currently represents tab selection, stack history, task-detail visibility, and persisted restoration. Adding a return-view exception would repair the reported symptom while preserving that coupling.

## Navigation Architecture

Use React Navigation as the only runtime source of route and tab state:

```text
NavigationContainer
└── NativeStack
    ├── MainTabs
    │   ├── Tasks
    │   ├── Activity
    │   └── More
    ├── TaskDetail
    ├── TaskMore
    ├── Search
    └── Desktops
```

`MainTabs` uses `@react-navigation/bottom-tabs`. The root stack uses `@react-navigation/native-stack`, added as a mobile dependency. The app already includes React Navigation core, bottom tabs, `react-native-screens`, and safe-area support.

The current floating toolbar appearance may remain through the documented custom `tabBar` boundary, but its active route and navigation callbacks must come from the bottom-tab navigator. It must no longer calculate or mutate an independent active tab.

Search and Desktops are pushed utility screens. The task screen's `+` action pushes `TaskMore`, which reuses the task-aware More content without changing tabs or losing the terminal route beneath it. The More tab remains the global More destination.

## State Ownership

React Navigation owns:

- the selected tab;
- route history;
- task-detail visibility; and
- native Back, Android system Back, and iOS back-gesture behavior.

The mobile controller and session store continue to own:

- selected task identity and task summaries;
- terminal or headless-agent subscriptions and buffers;
- task activity/read reconciliation;
- connection, repository, composer, and account state; and
- persistence of business context.

Controller operations must stop selecting screens. `openTask()` prepares the selected task and its session but does not change a view. The route layer performs the corresponding push after the controller operation succeeds. Task-creation and task-action methods return the task identity needed by the route layer instead of routing indirectly through `openTask()`.

`activeView` is removed as a runtime rendering input. During migration it may remain as a persisted projection used to reconstruct the initial navigator state, but screen rendering and Back behavior must never read it as competing navigation state.

## Route Lifecycle

Opening a task from Tasks, Activity, Search, or a task-producing action pushes `TaskDetail` over the current route. The task route uses the route task id as its stable identity and tells the controller which task session to attach.

The task-detail route owns terminal visibility. Read-dwell behavior is active only while task detail is focused. Covering it with `TaskMore` pauses visibility-based read timing without removing the task route or tearing down the terminal session.

Removing `TaskDetail` performs task-view cleanup exactly once: stop the active subscription, clear transient terminal/agent buffers, and clear the route's selected task context. A cancelled native back gesture does not remove the route and therefore does not clean up.

The visible Back button calls the navigator's `goBack()`. Native gestures and Android system Back use the same stack operation and lifecycle cleanup.

## Persistence and Restoration

Initialization waits for the existing session context hydration before mounting the navigation container. The app then constructs initial navigation state from the persisted projection:

- the saved Tasks, Activity, or More destination selects that tab;
- saved Search or Desktops state restores the corresponding pushed utility route; and
- a valid saved task selection restores `TaskDetail` above its originating destination.

Navigation changes update the persisted projection for the next cold start. The projection is compatibility and restoration data, not a second live navigator.

If a restored task no longer exists after task collections reconcile, the task route is removed and the user remains on its originating screen. Existing unresolved-selection shell behavior remains available while connection data is still loading.

## Error Handling

Navigation occurs only after the associated controller action has produced a usable task identity. Failed task creation, stage advancement, merge-agent startup, or task lookup remains on the source route and uses the existing error surface.

Repeated presses must not create duplicate detail routes for the same active task. Route removal and controller cleanup must be idempotent so programmatic Back, gestures, and reconciliation cannot double-close subscriptions.

## Testing

Test-driven coverage will include:

- Tasks -> TaskDetail -> Back returns to Tasks;
- Activity -> TaskDetail -> Back returns to Activity;
- Search -> TaskDetail -> Back returns to the same Search route and results;
- TaskDetail -> TaskMore -> Back returns to the live task detail;
- task-producing actions route only after returning a usable task identity;
- native route removal cleans task state once while temporary route blur does not;
- controller task operations no longer rewrite navigation state;
- persisted navigation projection reconstructs the expected initial stack; and
- invalid restored task detail falls back to its source route.

The existing mobile Appium list/detail/back flow gains an Activity-origin regression. Focused mobile unit tests and typecheck run before the wider repository checks.

## Compatibility

This change preserves task, terminal, relay, cloud, and API contracts. It adds a JavaScript navigation package but no new native module; the app already ships the native `react-native-screens` dependency used by native stack. No mobile OTA runtime-version bump is required.

## Out of Scope

- Redesigning the toolbar, task terminal, task cards, or More command palette.
- Changing task activity semantics beyond deriving visibility from route focus.
- Adding deep links or URL routing.
- Persisting arbitrary historical stack depth beyond the current destination and selected task restoration contract.
