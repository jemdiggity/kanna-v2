# Delayed Close/Create Selection Ownership Design

## Goal

Keep a task created and auto-selected while another task's close response is pending selected after that older close completes, including after reload.

## Architecture

`selectionIntentVersion` remains the close action's ownership token. Existing UI navigation continues to record user intent in `useAppTaskNavigation`; `createItem` records intent at its store boundary when it auto-selects its creating slot. Snapshot reconciliation, selection restoration, and close fallback do not record intent because they are synchronization or completion work rather than newer user choices.

The store owns the increment operation through a shared `recordSelectionIntent(state)` helper used by both the public navigation recorder and task creation. Generic `selectRepo` and `selectItem` calls remain neutral because they are also used for internal normalization; their user-driven UI callers already record intent before invoking them.

## Data Flow

1. Closing the selected task captures the current `selectionIntentVersion` and waits for the server response.
2. Creating another task inserts its `create:*` UI slot.
3. Auto-selection records a newer intent before updating the selected repository and slot.
4. The older close response resolves, observes a different version, and skips replacement selection.
5. Creation acknowledgement and snapshot reload preserve and persist the stable selected slot/task.

## Error Handling

Task creation keeps its existing rollback behavior. Recording intent before optimistic selection is intentional even if creation later fails: the user initiated a newer selection operation, so an older close completion must not reclaim selection after that operation's own fallback has run.

## Testing

- A focused deferred close/create test proves `createItem` auto-selection invalidates older close ownership without manually mutating the version.
- The mock lifecycle E2E test holds an old close response, creates and auto-selects a task in another repository, releases the close response, and checks the new repository/task selection before and after reload.
