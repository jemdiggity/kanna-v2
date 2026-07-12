# Mobile Server-Owned Task Input Design

## Problem

The mobile PTY composer currently converts every submitted value into terminal
control bytes before handing it to a transport. For Claude, submitting `1`
produces bracketed-paste markers around the digit followed by a Kitty Enter:

```text
ESC[200~1ESC[201~ESC[13u
```

Claude's `/model` picker treats a raw digit as an immediate menu accelerator.
A digit inside bracketed paste is not an accelerator, so the appended Enter
confirms whichever row the cursor already highlights.

The same client-side encoding also has inconsistent transport semantics. The
cloud relay path forwards the encoded bytes directly through KSP `term_input`,
while the LAN path posts them to `/v1/tasks/{id}/input`, whose server handler
then appends another discrete Enter.

## Goals

- Make numeric selection in Claude's `/model` menu honor the submitted digit.
- Preserve ordinary one-character and multiline composer submissions.
- Give LAN and cloud relay submissions identical behavior.
- Keep task-input submission policy at the existing `kanna-server` boundary.

## Non-goals

- Making the mobile terminal WebView a fully interactive terminal keyboard.
- Adding provider-specific model parsing or a native model picker for PTY tasks.
- Removing the raw KSP `term_input` protocol, which remains the correct channel
  for future terminal-keyboard input.

## Architecture

The mobile task composer represents a complete logical submission, not raw
terminal keystrokes. It will therefore pass plain text to `KannaClient` without
bracketed-paste or Enter control sequences.

Both LAN and cloud task input will use `POST /v1/tasks/{id}/input`. For cloud
tasks, `createRemoteTransport` will resolve the cloud task to its owning desktop
and local task id, then invoke that route through the relay. The mobile-only
shortcut that sends composer text directly as KSP `term_input` will be removed.

`kanna-server` remains the single source of truth for logical submission. Its
existing handler writes the submitted text to the PTY, waits 150 ms, and writes
a discrete carriage return. This avoids the CLI's bulk-write submission issue
while exposing the raw digit to an interactive picker before Enter is sent.

The exact sequence was checked against Claude Code 2.1.205: after moving the
picker cursor away from model 3, writing raw `3` selected model 3 immediately;
the later carriage return had no effect at the restored prompt.

## Data Flow

```text
TaskScreen composer
  -> mobileController.sendTaskInput(plain text)
  -> KannaClient.sendTaskInput
  -> LAN POST or relay owner-desktop invoke
  -> POST /v1/tasks/{localTaskId}/input
  -> kanna-server writes text
  -> 150 ms delay
  -> kanna-server writes carriage return
  -> daemon forwards both writes unchanged to the PTY
```

## Code Changes

- `apps/mobile/src/state/mobileController.ts`
  - Send trimmed PTY composer text unchanged.
  - Remove `encodeSubmittedTaskInput`.
- `apps/mobile/src/lib/transports/remoteTransport.ts`
  - Remove the raw `RemoteTaskInputSender` dependency.
  - Route every task submission through `requestTask` and `/input`.
- `apps/mobile/src/lib/transports/relayClient.ts`
  - Remove the mobile composer-specific `sendTaskInput` raw-terminal method.
- `apps/mobile/src/appModel.ts`
  - Stop wiring the relay raw-terminal sender into the remote transport.
- Associated tests and relay-client mocks will follow the narrowed interfaces.

No native dependency or configuration changes are involved, so the mobile OTA
runtime version does not change.

## Error Handling

Existing transport behavior remains intact. LAN HTTP failures and relay invoke
failures reject `sendTaskInput`; `mobileController` reports them through the
existing store error path and does not introduce retries or fallback writes.

## Testing

- Update the controller regression test to require plain `1` and plain normal
  message text, proving no terminal controls are added client-side.
- Update remote transport tests to require an owner-routed `/input` invoke with
  `{ input: "1" }` and to reject the old raw sender dependency.
- Keep LAN transport coverage proving the plain input body is posted unchanged.
- Update relay-client and app-model tests for the removed raw submission method.
- Run the full mobile unit suite and TypeScript typecheck.
- The existing mobile relay Appium lane already crosses UI, relay,
  `kanna-server`, daemon, and PTY input. Run it when the simulator/Appium stack
  is available; no physical-device automation is required or permitted.
