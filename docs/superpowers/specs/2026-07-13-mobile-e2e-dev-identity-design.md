# Mobile E2E Dev Identity Design

## Goal

Local mobile E2E and preflight commands must target the development native app by default. Staging and production identities remain available only when callers select them explicitly.

## Root Cause

`resolveRequiredMobileE2eEnv` currently falls back to `prod` when `KANNA_APP_ENV` is unset. The relay runner starts Metro with the development environment later, after Appium has already resolved and checked the production bundle ID. This splits the native app identity from the JavaScript environment and makes a normal simulator run look for `build.kanna.app` instead of `build.kanna.app.dev`.

## Design

The shared E2E environment resolver will default `KANNA_APP_ENV` to `dev`. It remains the single source of truth used by both preflight and the Appium runner.

Identity precedence remains:

1. An explicit `KANNA_IOS_BUNDLE_ID` selects the Appium bundle directly.
2. Otherwise, an explicit `KANNA_APP_ENV` selects the matching native identity.
3. Otherwise, E2E uses the development identity.

This produces `build.kanna.app.dev` and `build.kanna.app.dev.webdriveragentrunner` for ordinary local runs. Explicit `staging` and `prod` environments keep their existing identities. Hybrid mode remains simulator-only and continues forcing the development environment.

The resolver will also expose the environment's configured app scheme. Simulator automation must use that scheme when opening the Expo development-client URL instead of the shared generated `exp+kanna-mobile` scheme. For a normal local run, Appium will launch `build.kanna.app.dev` and the runner will open:

```text
kanna-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<workspace-port>&disableOnboarding=1
```

This routes the workspace Metro URL to the same environment-specific app identity without rebuilding the native client for every worktree port. The installed binary's baked Metro port remains only a fallback.

Relay and hybrid runs also require an exact Metro environment match. Their
Firebase and relay endpoints are allocated per harness run, so reusing an
otherwise valid dev-client Metro without verifying those variables can connect
the correct native app to stale backend ports.

## Testing

Update the environment resolver tests first so the unset case expects `appEnv: "dev"`, `appScheme: "kanna-dev"`, `bundleId: "build.kanna.app.dev"`, and the matching WDA bundle ID. Add a simulator URL test requiring the selected scheme, encoded workspace Metro URL, and onboarding suppression. Verify both tests fail against the current production default and shared scheme, then change the resolver and simulator launcher and rerun the focused E2E configuration tests, mobile typecheck, and the broader mobile test suite.

The native Appium relay path should then pass its installed-app check when the development build is present and request the assigned workspace Metro URL. This is test-harness-only TypeScript and does not require a mobile OTA runtime-version change.
