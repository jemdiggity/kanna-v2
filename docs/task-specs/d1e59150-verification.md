# Task d1e59150 simulator verification

Verified on 2026-09-08 with the real development app on the iPhone 17 Pro
Simulator (`C48044E2-D11B-4A50-993D-D571CA8462E7`, iOS 26.5).

## Setup and command

I built, installed, and launched the worktree app and its canonical development
stack with:

```sh
./kd mobile run --simulator
```

With the app stopped, I seeded its real AsyncStorage
`kanna.mobile.context.v1` record as signed out (`authUser: null`) with one trusted
desktop named `Loopback Dev Mac`. The record had both anonymous-push fields and
used the deliberately unreachable relay URL `ws://127.0.0.1:9`. I then relaunched
the installed `build.kanna.app.dev` app through the Metro URL started by `kd`.

## Observed result

Using Appium/XCUITest against that installed app, I opened the account sheet,
opened Machines, tapped Remove on `Loopback Dev Mac`, and confirmed the native
removal alert. The machine row disappeared and the screen rendered the
`No machines added` state without a `Couldn't remove machine` alert.

After the UI removal, the app's persisted AsyncStorage context contained
`trustedDesktops: []`. It still contained the seeded desktop, including
`ws://127.0.0.1:9`, under `pendingAnonymousPushRevocations`. That queued record
proves the unreachable remote revoke did not complete while also proving its
failure did not block durable local removal.

Post-removal screenshot:
`docs/task-specs/d1e59150-screenshots/loopback-pairing-removed.png`.
