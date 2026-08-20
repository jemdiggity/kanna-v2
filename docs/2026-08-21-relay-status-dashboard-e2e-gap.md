# Relay status dashboard: no real-browser E2E yet

**Date:** 2026-08-21 · **Task:** 533d9aac

## What is not covered

`GET /dashboard` serves a page whose value only exists in a browser: it polls
`/stats` every four seconds, renders the live connection list and the aggregate
panels, and reports a refused token in its own banner. Nothing in the repo drives
a real browser against a relay, so none of that is exercised end to end. The
desktop tier has `tauri-plugin-webdriver`, but it drives the Tauri WKWebView
against the desktop app, not an arbitrary URL against a Node service; there is no
Playwright/Chromium tier that a relay test could reach for.

Specifically untested against a real engine: the page's CSS at real viewport
sizes, `fetch` with the `Authorization` header the page builds, the four-second
`setInterval` cadence, and the browser's own handling of `no-store` /
`no-referrer` on a URL that carries a credential.

## What is covered meanwhile

- `services/relay/test/statusDashboard.test.ts` — a spawned relay process: the
  auth gate on `/stats` and `/dashboard` (401 without a credential, 200 with the
  operator token, header and `?token=` both accepted), the served page's
  content type and cache headers, that the page references no external host, and
  that `/health` is unchanged.
- `services/relay/src/statusDashboardPage.test.ts` — the page's own script run in
  a `node:vm` sandbox with a minimal DOM stub, against a payload built by
  `buildRelayStatsPayload`. This holds the contract that actually breaks in
  practice: the page reads the field names `/stats` writes, and an identity
  string is escaped rather than pasted into the document.
- `services/relay/src/relayStatus.test.ts` — the two-credential visibility split,
  token resolution and comparison, and the bounded close-rollup ring.

## What would make it testable

A headless-Chromium test tier that can be pointed at an arbitrary local URL —
Playwright is already a desktop-tier dependency, so the missing piece is a relay
test that starts the process, opens the dashboard with a token, and asserts the
rendered table. That is worth doing when a second relay-served page exists;
one page does not justify standing up a browser tier on the relay's side.
