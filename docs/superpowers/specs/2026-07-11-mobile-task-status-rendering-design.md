# Mobile Task Status Rendering Design

## Goal

Match the desktop task-title typography in every mobile task list: unread tasks are bold, working tasks are italic at normal weight, and idle tasks are normal.

## Scope

This change affects only mobile task-title rendering and the mobile data propagation required for that rendering. It does not add status labels, icons, badges, ordering changes, mark-read behavior, task-detail typography, or desktop cloud-publication behavior.

## Data Model and Flow

Mobile will define task activity as `"idle" | "working" | "unread"`. `TaskSummary.activity` remains optional and nullable so mobile can safely consume older cloud documents or responses that omit the field.

The LAN and relay task APIs already include activity, so those transports continue passing task summaries through unchanged. The mobile Firestore task mapper will retain valid activity values from desktop cloud snapshots. Missing or unrecognized values will behave as idle for rendering.

Mobile repo and recent task collections suppress identical refreshes to preserve UI state. Activity must participate in that equality check so an activity-only LAN poll or cloud snapshot update publishes new state and rerenders the card. Search results already publish every refresh.

## Rendering

`TaskCard` will apply activity styling only to the task title:

- `unread`: bold, non-italic
- `working`: normal weight, italic
- `idle`, missing, or unrecognized: normal weight, non-italic

Repo labels, scope labels, stage pills, previews, card layout, and task ordering remain unchanged. Because repo, recent, and search results all reuse `TaskCard`, they receive the same behavior automatically.

## Compatibility and Error Handling

No server or database migration is required. The Kanna server and desktop cloud snapshot format already emit activity. Legacy or malformed cloud values degrade to normal title typography rather than preventing task rendering.

## Testing

Automated coverage will verify:

1. The cloud task mapper preserves a working activity value and handles absent values.
2. The session store publishes when the only changed task field is activity while still suppressing truly identical refreshes.
3. `TaskCard` renders unread, working, and idle-or-missing title styles with desktop-equivalent weight and italics.
4. The focused tests, TypeScript typecheck, and full mobile suite pass.
