# Mobile task pin swipe E2E execution note

The mobile Appium smoke journey now swipes a real task row, activates its
revealed Pin or Unpin action, verifies the owner `kanna-server` task summary
changed, and restores the fixture's original pin state in `finally`. It first
selects the fixture's repository so a persisted repo choice cannot hide the
target row.

This task did not execute that physical gesture journey because its scope
explicitly forbids device installation. The journey requires an already built
and installed Expo development client plus Appium/XCUITest and a live PTY task
fixture; `pnpm --filter @kanna/mobile test:e2e:smoke` may install or launch
those external artifacts as part of its normal setup.

The narrower automated coverage run in this task covers:

- gesture direction, activation distance, reveal threshold, and clamping;
- component reveal, visible/accessibility alternatives, pending state, and
  inline failure feedback;
- optimistic controller state, preserved selection, and failure rollback;
- LAN, relay, and hybrid owner-route transport wiring;
- the HTTP action through SQLite and back through mobile task summaries;
- cloud publication, relay validation, and Firestore projection of pin state.

The physical journey can be executed once a compatible dev client is already
installed and the standard `KANNA_E2E_*` smoke fixture environment is present;
no new harness work is required.
