# kd environment profile physical-device E2E gap (2026-08-21)

The `dev` mobile build → installed staging desktop owner → staging cloud profile crosses kd, tmux/Metro, Expo CNG, iOS installation, the installed staging `kanna-server`, Firebase, and the staging relay. A stable automated E2E cannot run in repository CI because it requires an attached, trusted, provisioned physical iPhone on the Mac's LAN plus a running signed `/Applications/Kanna Staging.app` authenticated to live staging infrastructure. Running it against mocks would no longer prove the hardware/signing/network boundary.

The narrower automated coverage verifies CLI parsing; centralized profile resolution and rejection before commands run; staging Firebase/relay environment propagation while retaining `KANNA_APP_ENV=dev`; an installed-owner status and relay preflight before tmux/prebuild/install; a mobile-only process plan; dev bundle prebuild/install/launch selection; and profile/endpoint diagnostics. Existing device smoke remains the manual hardware lane.

This gap can close when CI has a dedicated macOS hardware runner with a permanently enrolled iPhone, isolated staging credentials/desktop identity, and a reliable way to launch and reset the signed installed staging desktop without sharing its state with operator machines.
