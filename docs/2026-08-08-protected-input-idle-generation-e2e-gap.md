# Protected-input idle generation E2E gap (2026-08-08)

`kanna-server`'s protected-input maintenance loop has two halves. Only one of
them has real-boundary coverage.

## What is covered end to end

**A daemon that really is replaced gets the policy re-established on its
successor.** `commands::mobile::tests::manager_adopts_server_after_original_desktop_exits`
(`apps/desktop/src-tauri/src/commands/mobile/mod.rs`) runs a real
`kanna-daemon`, a real `kanna-server`, and a real desktop-side adoption, then
starts a *second* real daemon so the first hands off and exits. It waits for
the surviving server's `protected-input policy established on successor daemon
pid <pid>` lifecycle line naming the replacement daemon's exact pid, then
proves inherited PTYs accept input under the re-established policy.

That test exercises the wake-up this change rewrote: the maintenance loop now
learns a generation ended by holding the negotiated connection and reading it
to EOF, rather than by polling `daemon.pid` for a successor.

## What is not covered end to end

**A daemon that is *not* replaced must cost nothing.** The regression being
fixed here — 2095 renegotiations over 9.7 hours against one unchanged daemon —
is a statement about a *quiet* interval, and the two things that would make it
observable at a real boundary are both missing:

- **Time.** The old spin's period was the `wait_for_successor` budget, ~17s.
  Distinguishing "settled" from "spinning" at a real boundary means running a
  real server against a real daemon for minutes and finding no repeats. The
  existing E2E asserts on a 15s log window, which is shorter than a single
  cycle, so extending it would not decide the question.
- **A count.** A real `kanna-daemon` does not report how many times it has been
  asked to negotiate. Asserting "exactly once" would need either a
  daemon-side counter that exists only for tests, or scraping the server log
  for absence — an assertion that passes for the wrong reason whenever log
  formatting drifts.

## Narrower executable coverage added meanwhile

`crates/kanna-server/src/runtime.rs`:

- `a_stable_daemon_is_negotiated_with_once` runs the real maintenance loop
  against a fake daemon that behaves like a live one (it answers the
  generation setup and then keeps the connection open) under a paused clock,
  and asserts that ten minutes of the loop's own time produce exactly one
  negotiation and exactly one connection. It fails against the pre-fix loop.
- `a_replaced_daemon_gets_its_successor_negotiated` retires that fake the way
  handoff retires a daemon — connection and socket dropped, successor bound
  afterwards — and asserts the loop negotiates the successor's generation.

## What would make it testable

A real-boundary assertion becomes practical if either:

1. `kanna-daemon` gains a counter the fixture can read — e.g. negotiations per
   server pid surfaced in an existing diagnostic command — so "exactly once"
   is a value rather than an absence; or
2. the desktop E2E lane grows a long-idle phase (minutes of a live server and
   daemon with no operator activity) that other steady-state regressions can
   share the cost of, at which point counting the successor-policy log line
   over that window is meaningful.
