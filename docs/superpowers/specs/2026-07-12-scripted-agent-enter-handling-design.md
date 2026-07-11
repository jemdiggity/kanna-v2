# Scripted Agent Enter Handling Design

## Problem

The remote E2E scripted agent enables noncanonical terminal input but leaves
`icrnl` enabled. The PTY therefore translates Enter from carriage return to
newline. Shell command substitution then strips that newline, so the harness
never observes a submit keystroke and terminal-flow tests time out.

## Design

Configure the scripted agent terminal with `-icrnl` alongside its existing
noncanonical and no-echo settings. This preserves Enter as a carriage-return
byte and accurately models the discrete Enter sent by the server after task
input text.

Keep the change scoped to the test harness. Do not alter the production input
transport or server delay because isolated PTY evidence shows that the harness,
not the production path, loses Enter.

## Testing

First strengthen the scripted-agent source test to require `-icrnl` and confirm
that it fails against the current script. Then add the terminal setting, rerun
the focused unit test, and run the remote E2E suite that previously timed out.
Finally run the complete monorepo test suite before declaring the branch ready.
