# Mobile Send Quick Replies

**Date:** 2026-07-16  
**Status:** Approved design

## Goal

Let a mobile user quickly approve an agent's proposal without adding persistent UI to the task screen. A normal press of **Send** keeps its current behavior. Pressing and holding **Send** opens a native list of canned replies; the first reply is `SGTM. Proceed.`

## Scope

This change is limited to the React Native task composer in `apps/mobile`.

- It applies to both structured-agent and PTY task screens because they share `TaskScreen` and its `onSendInput` callback.
- It reuses the existing input-routing path for LAN, cloud, structured-agent, and PTY sessions.
- It adds no server endpoint, transport frame, controller method, dependency, native configuration, or database state.
- It is a JavaScript-only mobile change, so the OTA `runtimeVersion` does not change.

## Interaction

### Normal press

A normal press of **Send** continues to trim and send the current draft. With an empty or whitespace-only draft, it does nothing.

### Long press

Pressing and holding **Send** while the composer is available opens a native menu titled **Quick Replies**. The initial menu contains:

1. `SGTM. Proceed.`
2. `Cancel`

The long press remains available when the draft is empty. Selecting `Cancel` or dismissing the menu leaves the draft unchanged and sends nothing.

Selecting `SGTM. Proceed.` immediately sends a message constructed as follows:

- Empty or whitespace-only draft: `SGTM. Proceed.`
- Non-empty draft: `SGTM. Proceed.`, two newline characters, then the trimmed draft

For example, a draft of `Also add regression tests` produces:

```text
SGTM. Proceed.

Also add regression tests
```

After selection, the composer clears immediately, matching the existing normal-send behavior. React Native's `Pressable` suppresses the normal `onPress` callback after `onLongPress`, so releasing the long press must not also send the draft separately.

### Availability and accessibility

The **Send** pressable preserves the existing task-specific composer availability rules: a structured-agent composer is unavailable while connecting or in an error state, while a PTY composer is unavailable unless its terminal is live. An empty draft no longer disables the pressable because its long-press action is still valid; its normal press remains a no-op.

The control exposes an accessibility label and hint that describe both behaviors: activate to send the draft and press and hold for quick replies. When the composer is genuinely unavailable, its disabled accessibility state matches its disabled interaction state.

## Architecture

### Quick-reply model

A focused `taskQuickReplies.ts` module owns:

- the ordered quick-reply catalog;
- each option's stable identifier, menu label, and message prefix; and
- a pure function that combines a selected prefix with an optional draft.

The catalog initially contains only `SGTM. Proceed.`. Future shortcuts extend the catalog without changing the composer data flow or menu-selection logic.

The pure composition function trims the draft, adds the two-newline separator only when the trimmed draft is non-empty, and always returns a non-empty shortcut message.

### Platform presentation

`TaskScreen` presents the catalog using platform-native React Native APIs:

- iOS uses `ActionSheetIOS.showActionSheetWithOptions` with the cancel button index derived from the catalog length.
- Other platforms use `Alert.alert` with one action per catalog item plus a cancel action.

No custom modal or persistent quick-reply state is introduced. The menu callback selects a catalog item by its derived index or action closure and delegates message construction to the pure quick-reply module.

### Submission data flow

`TaskScreen` keeps ownership of `draftInput`. Both normal and shortcut submissions call the existing `onSendInput(input)` prop and then clear the local draft:

```text
normal Send ────────────────┐
                            ├─> TaskScreen onSendInput
long press -> native menu   │        -> mobileController.sendTaskInput
           -> quick reply ──┘        -> existing agent/PTY transport route
```

The mobile controller, API client, agent subscription, and server are unchanged.

## Error Handling

- Dismissing or canceling the native menu is a no-op.
- An invalid action-sheet index is ignored rather than sending a fallback message.
- A disabled composer cannot open the menu or submit input.
- Submission errors continue through the controller's existing error handling. The composer clears immediately on dispatch, as it already does for normal sends; this feature does not introduce a second retry or draft-restoration policy.

## Testing

Focused unit coverage verifies:

- the quick-reply catalog contains the exact initial label and prefix;
- empty and whitespace-only drafts produce exactly `SGTM. Proceed.`;
- a populated draft is trimmed and separated from the prefix by exactly two newlines;
- a normal press sends only the trimmed draft;
- a long press opens the iOS native menu with the shortcut and cancel entries;
- selecting the shortcut sends the composed text and clears the draft;
- selecting cancel or returning an invalid index sends nothing and preserves the draft;
- the non-iOS fallback exposes equivalent shortcut and cancel actions;
- long press remains available with an empty draft when the composer is healthy; and
- both normal and long-press interactions are disabled when the composer is unavailable.

Verification commands:

```bash
pnpm --dir apps/mobile test -- --runInBand
pnpm --dir apps/mobile run typecheck
```

## Out of Scope

- Persisting, editing, reordering, or synchronizing quick replies
- Adding more canned replies in this change
- Showing a separate quick-reply button, reaction control, or inline chip
- Haptic feedback
- Analytics for shortcut use
- Changing task-input routing or delivery guarantees

## Success Criteria

- A normal press of **Send** remains behaviorally unchanged for non-empty drafts.
- A long press opens a native quick-reply menu on every supported platform.
- The menu works with an empty draft.
- Choosing `SGTM. Proceed.` immediately sends it, followed by any trimmed draft with a blank-line separator.
- Canceling or dismissing the menu sends nothing and preserves the draft.
- No server, protocol, native-identity, dependency, or OTA runtime change is required.
