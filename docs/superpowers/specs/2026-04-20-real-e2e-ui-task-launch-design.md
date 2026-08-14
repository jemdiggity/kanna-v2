# Real E2E UI Task Launch Design

## Goal

Move the default real PTY desktop E2E specs from direct Vue method submission to the actual shortcut-driven new-task UI flow.

## Problem

The current real PTY specs create tasks by calling `handleNewTaskSubmit` through the dev E2E bridge. That still exercises the app's real task-creation workflow, but it skips part of the user-visible flow:

- opening the modal with `Shift+Cmd+N`
- focus and modal lifecycle
- prompt entry through the textarea
- submission through the modal keyboard shortcut

For default real E2E coverage, that shortcut path is the more correct source of truth. Right now, when a run stalls or behaves unexpectedly, it is too easy to wonder whether the issue is in the app or in the test shortcut.

## Design Principles

### 1. Use the same user-facing launch path the product advertises

The app already exposes a keyboard shortcut for new task creation. The real E2E suite should use that path rather than bypassing the modal.

### 2. Keep UI-driving logic in a helper, not duplicated across specs

Both real PTY specs need the same flow:

- open the modal
- fill the prompt
- submit with the modal's submit shortcut

That behavior should live in one E2E helper so the suite stays consistent.

### 3. Preserve existing backend assertions

This change should only replace how the task is launched. It should not rewrite the existing task-created polling, trust-prompt nudge, or diff assertions unless needed for correctness.

## Recommended Approach

Add a helper under `apps/desktop/tests/e2e/helpers/` that drives the visible new-task flow through DOM events and WebDriver element interaction:

1. dispatch `Shift+Cmd+N`
2. wait for the new task modal
3. find the prompt textarea
4. enter the prompt text
5. dispatch `Cmd+Enter`
6. wait for the modal to disappear

The real PTY specs should call this helper instead of `callVueMethod(client, "handleNewTaskSubmit", prompt)`.

## Scope

This change applies to both default real PTY specs:

- `apps/desktop/tests/e2e/real/pty-session.test.ts`
- `apps/desktop/tests/e2e/real/diff-after-agent-run.test.ts`

The intent is to keep the default real suite internally consistent. If one PTY spec uses the real shortcut path, they both should.

## Helper Boundary

### New helper

Suggested file:

- `apps/desktop/tests/e2e/helpers/newTaskFlow.ts`

Responsibility:

- expose a focused `submitTaskFromUi(...)` helper for real E2E
- own the keyboard dispatch and modal DOM interaction
- hide selector details from the specs

Suggested client interface:

- `executeSync(...)`
- `waitForElement(...)`
- `waitForNoElement(...)`
- `sendKeys(...)`

That keeps the helper compatible with the existing WebDriver client without pulling in broader app state assumptions.

### Existing specs

Responsibility:

- choose the prompt
- wait for the task record to appear
- continue with trust-prompt handling and result assertions

The specs should stop knowing how the modal is opened or submitted.

## UI Contract

The helper should rely on the current visible modal structure:

- the new task modal appears as a `.modal-overlay`
- the prompt field is the modal `textarea`
- submit uses `Cmd+Enter`, matching the modal's own keyboard handling

The helper should wait for the modal to disappear after submission so later task-created polling starts from a clean state.

## Testing Strategy

### Helper-level test

Add a focused unit-style E2E helper test that verifies:

- `Shift+Cmd+N` is dispatched
- the modal is awaited
- the prompt is entered into the textarea
- `Cmd+Enter` is dispatched
- the helper waits for the modal to close

This should be done with a fake client, similar to the existing startup-overlay and trust-prompt helper tests.

### Real spec updates

Update both real PTY specs to call the helper and keep the rest of their flow intact.

Verification should confirm:

- the renamed `pty-session` spec still passes
- the diff spec now launches through the visible shortcut path
- any remaining failure is about actual runtime behavior, not direct method submission

## Alternatives Considered

### 1. Inline DOM-driving code in each real spec

Pros:

- no new helper file

Cons:

- duplicated logic
- brittle selectors spread across the suite
- inconsistent future maintenance

### 2. Keep `handleNewTaskSubmit` but add more comments

Pros:

- smallest change

Cons:

- does not improve correctness
- keeps doubt about whether the on-screen task-launch path is covered

### 3. Recommended: helper-backed UI launch for both PTY specs

Pros:

- more correct than direct method submission
- reusable
- consistent across the real suite

Cons:

- slightly slower than direct method invocation
- one more helper to maintain

## Non-Goals

This change does not:

- replace all dev-E2E state helpers with DOM-only automation
- remove the `window.__KANNA_E2E__` bridge from the suite
- change how repos are imported in these tests
- fix the remaining diff-behavior bug by itself

## Risks

### Risk: modal selectors are too generic

If the helper relies on a selector that matches multiple modals, the wrong UI could be targeted.

Mitigation:

- target the prompt textarea inside the visible modal overlay
- keep helper tests explicit about the selector contract

### Risk: keyboard event dispatch differs from WebDriver key input

The app-level shortcut uses a `keydown` listener, while text entry should still happen through the textarea element.

Mitigation:

- use script-dispatched `KeyboardEvent` only for the global shortcuts
- use WebDriver `sendKeys` for the textarea content

### Risk: the helper makes a real failure look like a UI launch problem

If the task still fails after moving to the shortcut path, it could be tempting to keep tweaking launch mechanics.

Mitigation:

- treat task-launch correctness separately from agent-runtime debugging
- keep post-launch assertions unchanged in the first pass

## Acceptance Criteria

The design is satisfied when:

- the default real PTY specs launch tasks via the visible keyboard shortcut and modal flow
- the new-task UI-driving logic lives in one helper
- both real PTY specs use the same launch path
- the suite continues to use existing polling and trust-prompt handling after submission
