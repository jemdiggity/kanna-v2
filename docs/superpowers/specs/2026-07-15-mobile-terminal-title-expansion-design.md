# Mobile Terminal Prompt Expansion

## Goal

Let a mobile user tap the compact terminal header title to recover the canonical task prompt, even when the visible task title has been renamed to a shorter display name.

## Data Contract

`TaskSummary.title` remains the current display title used by collapsed task chrome and task lists. `TaskSummary.prompt` carries the task-creation prompt separately.

The LAN server maps `pipeline_item.display_name` (falling back to the prompt or task id) into `title` and maps the unmodified `pipeline_item.prompt` into `prompt`. Cloud documents retain their existing privacy-bounded `promptSnippet`; the mobile Firestore mapper must preserve it as `TaskSummary.prompt` instead of discarding it. When LAN and cloud copies of the same task merge, the live LAN prompt wins when present, just as live LAN title and stage data do. Legacy records without a prompt fall back to their display title in the screen.

No database migration, relay publication schema change, native project change, or OTA runtime-version bump is required.

## Interaction Contract

The header starts collapsed and displays the current `title` on one line. Tapping the title chip expands it and displays `prompt ?? title`, preserving newlines and the end of the available prompt. Tapping the chip again or tapping the transparent outside layer collapses it. Selecting another task starts collapsed.

Expansion changes only transient `TaskScreen` state. It does not alter terminal output, task metadata, agent state, or the reply draft.

## Bounded Presentation and Accessibility

The expanded prompt is rendered in a vertical `ScrollView` with a maximum height derived from the current window height and capped at a comfortable tablet height. Arbitrarily long prompts therefore remain reachable without growing the floating header beyond the viewport. The top chrome aligns controls to its top edge, so expansion never moves the Back button.

The title chip is one accessible `Pressable` with button role and expanded state. Its accessibility label changes from the collapsed display title to the expanded prompt. Descendant stage/title/prompt text and the outside-dismiss layer are not separate VoiceOver stops. The Back control remains a separate accessible action above the dismissal layer.

The existing display-title test id remains on collapsed title text. Dedicated ids identify the toggle, expanded prompt text, and outside-dismiss layer for Appium without creating extra actionable accessibility elements.

## Error and Compatibility Behavior

Older LAN or cloud task objects that omit `prompt` continue to work because `TaskScreen` falls back to `title`. An absent cloud `promptSnippet` likewise produces the title fallback. Empty strings are treated as absent at the presentation boundary.

Cloud prompt content remains subject to the existing 500-character publication contract. LAN content is the full database prompt. This feature does not broaden cloud publication of user text; it ensures the available canonical prompt is no longer discarded on mobile.

## Testing

Tests use a short renamed title and a distinct multiline prompt ending in an explicit sentinel. Coverage verifies:

- LAN server list/recent/search summaries serialize title and prompt separately through the prompt end;
- the cloud mapper carries `promptSnippet` through to `TaskSummary.prompt`;
- cloud/LAN merging prefers the LAN prompt;
- `TaskScreen` displays the title while collapsed and the distinct prompt through its sentinel while expanded;
- the expanded container is height-bounded and scrollable;
- exactly one title/prompt toggle is accessible, Back remains independent, and task switches reset expansion;
- selector contracts include the toggle, prompt, and dismissal ids; and
- the simulator Appium smoke opens the known seeded task, expands the prompt, checks the end sentinel, collapses it via the outside layer, and then uses Back.

Verification uses the focused mobile tests, mobile typecheck, `cargo test -p kanna-server`, the repository test suite, and the canonical `./kd dev up --mobile` simulator/Appium workflow. Physical-device Appium is outside this task.

## Out of Scope

- Editing or copying the prompt from the expanded view.
- Persisting expansion across navigation or app restarts.
- Changing task-list card title presentation.
- Changing cloud prompt publication limits or privacy policy.
