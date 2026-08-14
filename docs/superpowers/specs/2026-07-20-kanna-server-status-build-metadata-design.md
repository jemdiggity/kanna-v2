# Kanna Server Status Build Metadata Design

## Goal

Make `GET /v1/status` identify the active installed Kanna build unambiguously. Production and staging instances running side by side must report distinct environments, and staging must report its complete prerelease version such as `0.0.69-staging.1`.

## API Contract

The status response adds two required canonical camel-case fields while retaining the existing optional `serverVersion` field as a deprecated compatibility alias:

```json
{
  "state": "running",
  "desktopId": "desktop-123",
  "desktopName": "Studio Mac",
  "version": "0.0.69-staging.1",
  "environment": "staging",
  "serverVersion": "0.0.69-staging.1",
  "lanHost": "0.0.0.0",
  "lanPort": 48121,
  "pairingCode": null
}
```

`environment` has exactly three values:

- `production` for the installed production app;
- `staging` for the installed staging app;
- `development` when no installed release environment applies.

New consumers use `version` and `environment`. `serverVersion` remains present so existing consumers continue to decode status responses; it always equals `version` and carries no independent identity. The Rust server and desktop models keep it optional for compatibility with older responses, but every response produced by the current build populates it.

## Metadata Ownership and Flow

The desktop app owns the identity of the active installed build. A single reusable `kanna-server` sidecar can be packaged in multiple app variants, so the sidecar binary's Cargo package version is not authoritative for the installed app.

The release workflow will continue resolving the complete release version before invoking Bazel. For staging, that resolved value includes the prerelease sequence and is temporarily synchronized into the build's version inputs before the build starts. The built desktop therefore receives the same complete version used by its bundle, updater manifest, and release assets.

At runtime, the desktop will construct server metadata from:

- its build-time `KANNA_VERSION`; and
- the desktop cloud environment selected from the app's bundle identifier, with an absent release environment mapping to `development`.

The desktop will write required `version` and `environment` keys into the instance-specific `server.toml`. Production and staging already use separate app-data roots and ports; their generated configurations will now also carry explicit identities.

`kanna-server` will deserialize both canonical fields as required configuration and return them unchanged from `GET /v1/status`, including tunneled status requests. It copies `version` into the deprecated `serverVersion` response alias. It will not infer environment from a port or infer version from a prerelease suffix.

## Lifecycle and Stale-Server Detection

The desktop's stopped status snapshot will expose the same canonical version, environment, and compatibility alias as a running server response.

When adopting an existing server process, the desktop will require the response's desktop identity, canonical version, and environment to match the active app. `serverVersion` is not an authority for stale-process detection. Generated-config freshness checks will likewise require both canonical metadata lines. A mismatch causes the existing replacement flow to stop the stale process and launch the packaged sidecar with fresh configuration.

Because the new fields are required, configuration fixtures and test harnesses that launch `kanna-server` must supply both. This deliberately prevents a server from presenting ambiguous build identity.

## Components

- `tools/kd/src/runtime/release.ts` remains the source of the resolved production or full staging release version before build invocation.
- `apps/desktop/src-tauri/src/commands/mobile/` derives the runtime environment, writes canonical metadata, decodes status, and detects stale instances.
- `crates/kanna-server/src/config.rs` requires canonical build metadata from `server.toml`.
- `crates/kanna-server/src/mobile_api.rs` exposes canonical metadata in the status payload.
- Mobile, desktop, kd, and test clients update their status types and fixtures to the new contract where they model these fields.

## Error Handling

Missing or invalid server metadata is a configuration error. `kanna-server` will fail configuration loading rather than return an ambiguous status payload. The desktop manager will treat a status response with absent or mismatched metadata as non-current and use its existing replacement/startup error path.

No fallback will derive production or staging from port numbers, bundle names, or version text.

## Regression Coverage

Tests will prove the metadata flow at the relevant boundaries:

1. Release tests verify that the resolved full staging prerelease is present during the Bazel build and that production uses its resolved release version.
2. Desktop configuration tests verify production, staging, and development environment values alongside the active desktop version.
3. Desktop status/stale-process tests verify that both version and environment must match.
4. A Rust integration test launches two actual compiled `kanna-server` child processes with separate production and staging TOML configurations and loopback ports, then asserts exact HTTP JSON. The staging assertion includes `0.0.69-staging.1`; both responses include the matching `serverVersion` alias.
5. The tunneled dispatcher test asserts the exact status body, proving that direct and tunneled routes preserve the same contract.
6. Existing desktop and remote harness fixtures include all three response fields.

A full release-installed-app E2E is not part of the regular test suite because it would require building and signing both production and staging macOS bundles, installing them side by side into an isolated host, controlling their fixed instance ports and app-data roots, and launching GUI application processes. A dedicated macOS release QA runner that provisions signing identities, installs both generated bundles, and reserves the production/staging ports would make that test feasible. Until that exists, the child-process integration test substitutes at the relevant boundary: it runs the real `kanna-server` executable, loads distinct runtime configurations, binds distinct TCP ports, and crosses the HTTP serialization boundary.

## Out of Scope

- Changing the production or staging port assignments.
- Giving the reusable sidecar binary its own release identity.
- Changing mobile application versioning or OTA runtime versions.
