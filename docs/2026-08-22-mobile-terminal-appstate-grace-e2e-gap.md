# Mobile terminal AppState grace E2E gap (2026-08-22)

## Gap

The iOS app-switcher peek gesture (`active` → `inactive` → `active` without selecting another app) is not covered by the mobile Appium suite. XCUITest can background, activate, and terminate an app, but it does not expose a reliable automation primitive for opening the system app switcher and returning without backgrounding Kanna. Simulator shortcuts do not reproduce the physical-device AppState sequence consistently enough to serve as an executable contract.

## What would close it

A reliable Appium/XCUITest command that drives the switcher gesture on both simulator and attached devices while reporting the intermediate React Native AppState values would allow an E2E assertion that the terminal WebView buffer, output epoch, and attachment remain unchanged.

## Coverage meanwhile

`apps/mobile/src/appLifecycle.test.ts` covers the AppState/timer transition matrix, including an indefinitely inactive switcher peek, a background return inside the 20-second grace, and grace expiry. `apps/mobile/src/state/mobileController.test.ts` verifies that hidden terminal events are buffered without closing the subscription, a grace refresh preserves the attachment, and expiry uses the existing reconnect path.
