# Mobile Activity dismissal swipe E2E execution note

The mobile Appium smoke journey now creates a real unread activity revision for
the PTY fixture, opens Activity, swipes its native row, activates Dismiss, and
waits for the owner `kanna-server` to report `idle`. The same assertion also
proves the underlying task remains in `/v1/tasks/recent`. It then creates a new
activity revision and waits for the same row to reappear, covering the
notification-generation boundary rather than only a transient UI removal.

This task did not execute the physical gesture journey because its scope
forbids device installation. The smoke requires an already built and installed
Expo development client plus Appium/XCUITest and a live PTY fixture;
`pnpm --filter @kanna/mobile test:e2e:smoke` can install or launch those
external artifacts during normal setup.

The narrower automated coverage run in this task covers:

- horizontal intent, vertical-scroll rejection, reveal, and the visible
  non-swipe Dismiss action;
- pending and accessible inline error feedback;
- Activity-only unread projection, empty state, and badge derivation;
- controller acknowledgement of the exact rendered activity revision;
- preservation across stale refreshes and reappearance at a later revision;
- LAN, relay, hybrid owner routing, and Firestore revision projection;
- server task-summary exposure of the activity revision and the existing HTTP
  revision-fence behavior through SQLite.

The physical journey can be run once the standard `KANNA_E2E_*` PTY fixture,
installed development client, and Appium environment are available. No new
harness work is required.
