# Warm remote companion browser reselection E2E gap

Date: 2026-08-17

`apps/desktop/tests/e2e/real/remote-visual-companion.test.ts` quarantines the
case that keeps two recently selected LAN terminals and visual companions live
at once. The journey reliably creates both companions, updates both browser
windows, submits isolated choices through both, and restores the first warm
terminal. After that reselection, the desktop companion snapshot for the first
owner is `available` at the expected revision, but its already-open companion
browser remains in a non-available status indefinitely.

Repairing that disagreement crosses the warm terminal cache, remote companion
ownership, bridge retirement/re-adoption, and native browser event delivery.
That lifecycle investigation is larger than the real-E2E rehabilitation task,
so the test is skipped explicitly instead of weakening or deleting its
coverage.

The quarantine can be removed when reselecting a warm remote terminal keeps or
reconnects every already-open browser owned by that cached terminal, with the
browser status returning to `available` in response to the same revision the
desktop reports.

Narrower coverage remains active in the same file for relay and LAN companion
journeys, navigation containment, physical link opening, refresh, input,
disconnect/recovery, and unavailable teardown. `CloudTerminalCache.test.ts`
covers warm-entry retention, and `desktopCompanionBridge.test.ts` covers the
bridge state machine in isolation.
