# Staging Mobile Port System Test Note

This branch does not add a true installed-app E2E for the staging desktop bundle. A faithful packaged-app test would need an installed staging `.app` with the `build.kanna.staging` bundle identifier, signed sidecars in the app resources, a controlled app data directory, and ownership of the fixed local ports `48120` and `48121`. The current Rust test harness can build and run sidecars, but it does not launch a packaged Tauri app with an isolated macOS app container or control other installed Kanna instances that may already own those ports on a developer machine.

The automated coverage added here uses the strongest available narrower system path:

- `staging_release_bundle_start_uses_48121_without_claiming_production_48120` constructs `MobileServerManager` with the staging release bundle identifier in release mode.
- It leaves a production-port owner on `48120` in place, using either a test-owned status server or the already-running local Kanna production server.
- When `48121` is free, it starts the real staged `kanna-server` sidecar through `MobileServerManager::start()`, writes the runtime config, polls `/v1/status`, and verifies the server targets `48121`.
- When another Kanna server already owns `48121`, it verifies the staging manager targets `48121`, refuses to claim the other owner, and still leaves `48120` available.

A true packaged-app E2E becomes feasible once CI or a local harness can install and launch signed production and staging desktop bundles in isolated app data roots while reserving the fixed server ports for the test duration.
