# Mobile Task Creation Provisioning Design

## Goal

Replace the mobile create button's text-only submitting state with a focused,
technical provisioning experience that reassures users while Kanna creates the
worktree, performs workspace setup, and starts the selected agent.

## Scope

This change is mobile-only and uses the existing synchronous create-task API.
It does not add backend progress events, background task creation, request
cancellation, or new dependencies.

## User Experience

After the user taps **Create**, the open create-task sheet switches from the
editable composer to a blocking provisioning panel. The panel shows:

- a terminal activity tile containing `>_` and a native indeterminate
  activity indicator;
- the heading `Provisioning task`;
- the selected route in the form `<repo> → <machine> · <agent>`; and
- the status copy `Creating worktree and starting <agent>…`.

The treatment is indeterminate. It must not present timed steps as confirmed
server progress because the current API sends no intermediate creation events.
The animation communicates continued activity without claiming a percentage or
specific completed phase.

While provisioning, the prompt, options, and action buttons are replaced. The
backdrop and platform modal-close gesture do not dismiss the sheet because the
request cannot be cancelled safely once the desktop may have created durable
task state. Repeated submissions are impossible.

When creation succeeds, the existing controller closes the composer and opens
the created task. When creation fails, the composer returns with the original
prompt and selections intact and displays the existing inline error.

## Component Design

`CreateTaskComposer` remains the owner of the presentation. It derives its
provisioning copy from the existing repo, desktop, agent, and `isSubmitting`
props. No new global state or controller phase enum is needed because the
server exposes only one observable pending phase.

The normal composer and provisioning panel are mutually exclusive branches.
Keeping both states in the same modal avoids a second overlay, preserves the
sheet transition, and lets the existing controller success and failure paths
remain authoritative.

The provisioning activity tile uses React Native's built-in `ActivityIndicator`
and view primitives, with a static `>_` prompt as its technical motif. It
follows the existing dark navy sheet, pale blue text, and blue border palette.
The status copy remains the primary signal, so the experience still works when
animation is unavailable. The panel receives the stable test id
`mobile.create-task.provisioning` through the shared mobile E2E id catalog.

## Data Flow

1. The user submits a valid prompt from `CreateTaskComposer`.
2. `mobileController.createTask()` sets `isComposerSubmitting` to `true` before
   awaiting `client.createTask()`.
3. `App` passes that state to `CreateTaskComposer`, which renders the blocking
   provisioning branch with the already-selected repo, machine, and agent.
4. On success, the controller adds the task to local collections, saves the
   repo creation profile, closes the composer, and opens the new task.
5. On failure, the controller stores the composer-local error and clears the
   submitting state. The normal composer reappears with the preserved input.

## Dismissal and Accessibility

The modal's `onRequestClose` and backdrop press are ignored while submitting.
Before submission and after failure, dismissal works exactly as it does today.

The provisioning container exposes an accessibility label that includes the
operation and destination, and uses a live-region announcement where supported.
The decorative prompt and indicator are hidden from accessibility. The UI does
not rely on motion, color, or an unlabeled spinner to communicate status.

## Error Handling

Creation errors retain the existing controller behavior: the failure message
appears inside the restored composer. The prompt, repo, machine, and agent are
not cleared on failure, so the user can retry without reconstructing the task.
The overlay does not add a cancel action because cancellation is not supported
by the create-task API and may leave ambiguous server-side state.

## Testing

Focused component tests will verify that:

- submitting replaces editable controls with the provisioning panel;
- the panel identifies the selected repo, machine, and agent;
- submit, backdrop, and modal-close paths cannot fire again or dismiss while
  submitting;
- non-submitting dismissal remains unchanged; and
- a cleared submitting state restores the normal composer and inline error.

Existing controller tests continue to verify that the submitting state spans
the pending request and clears on completion. Mobile typechecking and the
focused composer/controller test suites provide final verification.

## Alternatives Considered

### Button spinner only

Adding a spinner beside `Creating…` is small but leaves a long-running,
multi-second provisioning operation looking like an ordinary form submit. It
also leaves unrelated editable controls visible during an irreversible request.

### Background creation

Dismissing the sheet and showing a provisional task card would keep the app
navigable, but requires durable pending-task state, failure recovery outside the
composer, and clearer server idempotency semantics. That complexity is not
justified for this focused feedback improvement.

### Server-driven progress phases

Real events for worktree creation, setup, and agent spawn would provide the most
precise feedback. The current synchronous endpoint exposes none of those
events, so adding them would expand this task across the server protocol,
transports, and mobile state. The proposed indeterminate panel is truthful with
the API that exists today and leaves room for real phases later.
