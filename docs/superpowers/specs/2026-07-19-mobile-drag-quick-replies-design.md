# Mobile Drag Quick Replies

**Date:** 2026-07-19
**Status:** Approved design

## Goal

Make mobile quick replies feel immediate: hold **Send**, drag through an animated reply rail, and release over a reply to send it. Let the user maintain a device-local ordered list of one to five replies.

## Scope

This is a React Native mobile change in `apps/mobile`.

- It applies to structured-agent and PTY task screens through their shared `TaskScreen` composer.
- It preserves the existing task-input path for LAN, cloud, structured-agent, and PTY sessions.
- Custom replies are global to the mobile installation, not scoped to an account, desktop, repository, or task, and are not synchronized between devices.
- It uses React Native responder, animation, accessibility, and AsyncStorage APIs already in the app.
- It adds no server endpoint, protocol field, native dependency, or database state.
- It is JavaScript-only, so the OTA `runtimeVersion` does not change.

## Interaction

### Normal send

A short tap of **Send** keeps the current behavior. It trims and sends the current draft, or does nothing for an empty or whitespace-only draft.

### Hold, drag, and release

Holding **Send** for 400 ms opens an animated vertical reply rail above the button. Up to five reply cards rise upward from the button. Entry 1 is closest to **Send**, entry 2 is above it, and so on, so the user's ordering determines gesture distance.

The finger begins outside the rail with no reply selected. While the finger remains down:

- dragging over a card brightens and enlarges that card;
- crossing into a different card moves the highlight immediately;
- moving outside every card clears the highlight; and
- releasing over the highlighted card selects it, while releasing without a highlighted card cancels.

A release after selection immediately sends the reply. The reply is combined with the current draft using the existing behavior:

- empty or whitespace-only draft: the complete reply text;
- non-empty draft: the reply text, two newline characters, then the trimmed draft.

The successful send clears the draft, resets the composer height, and dismisses the keyboard exactly like normal Send. Cancellation preserves the draft. The rail closes if the responder is terminated, the selected task changes, or the composer becomes unavailable.

The cards are right-aligned above **Send**, up to 260 points wide, 48 points tall, and separated by 8 points. Their hit region includes the complete card width and extends 8 points around each visible edge. Cards display at most two ellipsized lines so the five-item rail remains reachable. Selection sends the complete stored reply, not the truncated display text. The rail enters over 140 ms with opacity, upward translation, and scale; highlight changes use a short scale and color transition without delaying selection.

### Touch state before activation

The gesture control distinguishes a tap from a hold without relying on the native action sheet:

- releasing within tap tolerance before the long-press threshold performs normal Send;
- moving more than 10 points from touch-down before activation cancels instead of sending; and
- after activation, releasing is exclusively a quick-reply selection or cancellation and never triggers normal Send.

### Accessibility

The control remains one accessible **Send reply** button. Its normal activate action sends the draft. A named **Show quick replies** accessibility action opens a conventional modal picker containing the same ordered replies and a Cancel control. This provides an operable alternative to the continuous hold-and-drag gesture for VoiceOver, TalkBack, switch control, and other assistive input.

When the composer is unavailable, both touch and accessibility actions are disabled. Accessibility hints describe the normal send and the available quick-reply action.

## Customization

The account sheet gains a **Quick Replies** row. Selecting it closes the account sheet and opens a dedicated editor modal.

The editor works on a draft copy of the saved list and supports:

- editing reply text;
- adding a reply until the list contains five;
- deleting a reply while at least two remain; and
- moving a reply up or down with explicit controls.

The editor always contains one to five replies. Add is disabled at five. Delete is disabled when one remains. **Cancel** discards the draft copy. **Done** validates and persists the entire ordered list atomically before changing the live quick-reply rail.

Each reply is trimmed on save, must contain between 1 and 200 characters after trimming, and must be unique under case-insensitive comparison. Internal whitespace and line breaks are preserved. Validation is shown inline and focus stays in the editor.

The first launch default is the existing reply:

```text
SGTM. Proceed.
```

## Architecture

### Reply domain

`taskQuickReplies.ts` remains the focused domain module. A reply has a stable local ID and complete message text. The module owns:

- the first-launch default;
- reply-list limits;
- normalization and validation;
- immutable add, delete, edit, and reorder operations; and
- composition of a selected reply with the current draft.

Stable IDs keep rendered rows and active gesture selections tied to the same logical reply when the order changes. Reply text is the only user-authored field; display labels are derived from it.

### Gesture control and geometry

A new `QuickReplySendControl` replaces the current Send `Pressable` and native quick-reply action sheet. It uses React Native's responder system so one component retains ownership from touch-down through long-press activation, drag, and release.

The visual rail is a focused presentation component. It renders from the ordered reply list, active reply ID, and activation state, using React Native `Animated` values for entrance and highlight transitions. It does not send messages or own persistence.

Selection geometry lives in a pure helper. Given gesture displacement and reply count, it returns a reply index or no selection. Its constants match the rendered card height, gap, horizontal band, and offset above **Send**. Keeping the geometry independent of React state makes card boundaries and cancellation behavior deterministic and testable.

### Accessible picker

A focused modal picker presents the same reply array as conventional accessible buttons. It returns a reply ID to the same selection callback as the gesture control, so touch and assistive paths share stale-task checks, composition, and submission.

### Preference persistence

Quick replies use a separate versioned AsyncStorage key and envelope rather than expanding session/navigation persistence. A small repository accepts a storage adapter so load/save behavior is testable.

On load, the repository validates the envelope version, IDs, reply texts, duplicates, ordering, and list length. It preserves valid ordered entries up to the five-item cap. Missing, unsupported, corrupt, or empty data falls back to the built-in reply.

The app hydrates this preference during bootstrap and owns the live array. Normal Send remains available while hydration runs; quick-reply activation waits until hydration completes so an old default cannot be sent before a custom list loads. The array is passed through navigation to `TaskScreen` and to the editor.

### Submission data flow

```text
tap Send ---------------------------------------------------┐
                                                            |
hold -> drag rail -> release reply ID --┐                   |
accessible action -> picker -> reply ID -+-> current task --+-> existing onSendInput
                                             + current draft |       -> controller/transport
                                             + availability -┘
```

The gesture and picker return only a stable reply ID. At selection time, `TaskScreen` reads the current composer snapshot, confirms the task has not changed and the composer is still available, finds the current reply by ID, composes it with the current draft, and calls the existing submission function. No gesture component captures transport or task state.

## Failure Handling

- Releasing outside all cards, responder termination, or pre-activation movement outside tap tolerance cancels without sending.
- A reply ID that no longer exists is ignored.
- A task change or unavailable composer between activation and selection cancels the operation.
- A storage read failure uses the built-in default and does not affect session hydration.
- A storage write failure leaves the live list unchanged, keeps the editor and its draft open, and shows a retryable inline error.
- Invalid persisted fields are not allowed into render or submission paths.
- Submission errors continue through the controller's existing handling; this feature does not add draft restoration or retry semantics.

## Testing

### Unit coverage

- default reply and list limits;
- trimming, length, case-insensitive duplicate detection, and preservation of internal whitespace;
- add, edit, delete, and reorder operations without mutation;
- reply-plus-draft composition;
- versioned persistence round-trip, valid-entry normalization, cap enforcement, and fallback for missing or corrupt data; and
- selection geometry for every card, exact boundaries, horizontal exits, movement between cards, and no-selection release.

### Component coverage

- short tap sends only the trimmed draft;
- long press opens the rail without sending;
- movement updates the highlighted reply;
- release over a reply sends exactly once and clears the composer;
- release outside and responder termination preserve the draft;
- disabled and pre-hydration states block quick-reply activation;
- the accessibility action opens the picker and picker selection uses the same submission path;
- account-sheet navigation opens the editor;
- editor add, edit, delete, reorder, one-item minimum, five-item maximum, validation, Cancel, successful save, and failed save; and
- a saved list is global across task and repository changes and returns after hydration.

### Relay journey

The existing Appium relay quick-reply journey changes from native action-sheet selection to a real hold-drag-release action. It resolves the Send button center, holds until the rail card is visible, moves to the target card center, and releases. The relay harness continues to assert that the exact composed reply crosses the existing transport once and that the native composer clears.

### Verification commands

```bash
pnpm --dir apps/mobile test -- --runInBand
pnpm --dir apps/mobile run typecheck
```

The explicit relay E2E remains a process-heavy verification run requiring the configured mobile environment.

## Out of Scope

- Account or cloud synchronization of replies
- Per-desktop, per-repository, or per-task reply lists
- More than five replies
- Usage-based automatic reordering
- Haptic feedback or a new native gesture dependency
- Changing task-input routing or delivery guarantees

## Success Criteria

- A short tap on **Send** behaves exactly as it did before.
- Holding **Send**, dragging to any configured reply, and releasing sends that reply exactly once.
- Releasing without a selected reply cancels and preserves the draft.
- The visual highlight follows the finger and the five-entry rail remains reachable from the Send button.
- Assistive-technology users can choose the same replies without performing the drag gesture.
- Users can persist an ordered device-local list of one to five valid replies from the account sheet.
- Custom replies work across tasks and repositories and survive an app restart.
- No server, protocol, native dependency, or OTA runtime change is introduced.
