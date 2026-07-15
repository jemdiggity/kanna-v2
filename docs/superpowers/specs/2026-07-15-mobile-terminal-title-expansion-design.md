# Mobile Terminal Title Expansion

## Goal

Let a mobile user reveal the complete current task title from the agent terminal screen when the compact one-line title no longer provides enough context.

## Interaction Contract

The task-detail title chip remains collapsed to one rendered line by default. Tapping the chip expands it in place so the current title can wrap across as many lines as its content requires. The expanded text is the existing current task title, including a user-renamed title; it does not substitute the original task-creation prompt.

The expanded title collapses when the user taps the title chip again or taps outside it. Selecting another task starts with the title collapsed. Expansion changes only the floating title chrome and must not alter terminal output, agent state, task metadata, or the reply draft.

## Mobile Presentation

`TaskScreen` owns the transient expanded-title state because the behavior is local to the visible task workspace. The existing title chip becomes a `Pressable`. Its collapsed state preserves the current styling and `numberOfLines={1}` behavior. Its expanded state removes that line limit, aligns the chip content for multiline text, and keeps the stage label alongside the title.

While the title is expanded, `TaskScreen` renders a transparent full-screen dismissal layer above the terminal and reply controls but below the title chrome. Pressing that layer collapses the title without forwarding the same press to the terminal or composer. The title chip stays above the layer so a second title tap also collapses it. Navigating back still leaves the task screen normally.

The title control exposes a button role, an expanded accessibility state, and a concise expand/collapse hint. The existing title test identifier and task-activity accessibility value remain available for automation.

## Data Boundaries

No API, database, Firebase, relay, or native project change is required. `TaskSummary.title` already represents the current display title across LAN and cloud sources and already reaches `TaskScreen` without programmatic truncation. The current visual shortening comes only from the React Native one-line text constraint.

Because this is a JavaScript-only presentation change with no native dependency or configuration impact, the mobile OTA `runtimeVersion` remains unchanged.

## Error and Edge-Case Behavior

The feature has no asynchronous operation or new failure mode. Empty-title fallback behavior remains owned by the existing server/task model. Multiline, Unicode, and long renamed titles are rendered verbatim by React Native rather than copied or normalized locally.

Expanded state is associated with the visible task id so it cannot leak when task selection changes without unmounting `TaskScreen`. Outside dismissal intentionally consumes the first press; the user can interact with the terminal or composer after the title has collapsed.

## Testing

Focused `TaskScreen` regression tests will verify:

- the title starts as a one-line, collapsed pressable;
- pressing the title requests expansion;
- the expanded title removes the one-line constraint while preserving the renamed title and activity value;
- pressing the expanded title requests collapse;
- pressing the outside dismissal layer requests collapse; and
- expanded state from one task is not presented for another task id.

After the focused test passes, run the mobile TypeScript typecheck and the practical affected mobile test suite. The live development check uses the canonical `kd` mobile workflow rather than starting Expo directly.

## Out of Scope

- Displaying the original task-creation prompt when it differs from the current renamed title.
- Editing or copying the title from the expanded view.
- Persisting expansion across navigation or app restarts.
- Changing task-list card title presentation.
