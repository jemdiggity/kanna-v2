# Task-transfer v4 terminal-input rolling-upgrade E2E gap (2026-08-16)

The repository does not retain an executable shipped-protocol-v4
`kanna-task-transfer` sidecar fixture. Building the current source with a v4
constant would not reproduce the shipped peer: it would still contain the new
`submission_boundary` and `control_input` fields and therefore could not prove
behavior across independently upgraded executables.

A full two-binary E2E becomes feasible when the test inputs include either a
checked-in test-only shipped-v4 sidecar artifact for each supported macOS
architecture, or a hermetic source/package fixture at the shipped v4 revision
that the test can build independently of the current crate. That fixture must
be driven in both directions over the authenticated duplex and fallback LAN
transports while a real daemon holds a partial draft and queued logical input.

The narrower causal coverage meanwhile is:

- `crates/task-transfer/tests/runtime.rs` exercises current-to-shipped-v4 and
  shipped-v4-wire-to-current negotiation in both duplex and authenticated
  fallback paths, and proves rejection occurs before daemon access. It also
  verifies current-to-current duplex FIFO preserves draft, submission-boundary,
  and control classifications on the wire.
- `crates/task-transfer/tests/sidecar_control.rs` launches the current sidecar
  as a separate process and drives both rolling-upgrade directions: a v4
  registry advertisement for the outbound refusal, and the exact shipped-v4
  wire shape (the new fields omitted) for inbound refusal. It proves the
  sidecar refuses before opening the old receiver or its daemon boundary.
- `tests/remote-e2e/src/lan-layer.e2e.test.ts` remains the current-to-current
  end-to-end proof that a partial human LAN draft and simultaneous logical task
  message stay separate and FIFO, including production mobile control input.

This gap is limited to executing the historical v4 binary itself; the mixed
wire contracts and the current full-stack success path are covered.
