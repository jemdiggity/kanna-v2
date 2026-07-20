# Kanna Server Status Build Metadata Design

## Goal

Make `GET /v1/status` identify the active installed Kanna build unambiguously. Production and staging instances running side by side must report distinct environments, and staging must report its complete prerelease version such as `0.0.69-staging.1`.

## API Contract

The status response will replace the optional `serverVersion` field with two required camel-case fields:

```json
{
  "state": "running",
  "desktopId": "desktop-123",
  "desktopName": "Studio Mac",
  "version": "0.0.69-staging.1",
  "environment": "staging",
  "lanHost": "0.0.0.0",
  "lanPort": 48121,
  "pairingCode": null
}
```

`environment` has exactly three values:

- `production` for the installed production app;
- `staging` for the installed staging app;
- `development` when no installed release environment applies.

This is an intentional pre-1.0 breaking API change. All in-repository producers and consumers will move to the new required fields together; `serverVersion` will not remain as an alias.

## Metadata Ownership and Flow

The desktop app owns the identity of the active installed build. A single reusable `kanna-server` sidecar can be packaged in multiple app variants, so the sidecar binary's Cargo package version is not authoritative for the installed app.

The release pipeline will continue resolving the complete release version before invoking Bazel. For staging, that resolved value includes the prerelease sequence and is temporarily synchronized into the build's version inputs before the build starts. The built desktop therefore receives the same complete version used by its bundle, updater manifest, and release assets.

At runtime, the desktop will construct server metadata from:

- its build-time `KANNA_VERSION`; and
- the desktop cloud environment selected from the app's bundle identifier, with an absent release environment mapping to `development`.

The desktop will write required `version` and `environment` keys into the instance-specific `server.toml`. Production and staging already use separate app-data roots and ports; their generated configurations will now also carry explicit identities.

`kanna-server` will deserialize both fields as required configuration and return them unchanged from `GET /v1/status`, including tunneled status requests. It will not infer environment from a port or infer version from a prerelease suffix.

## Lifecycle and Stale-Server Detection

The desktop's stopped status snapshot will expose the same canonical version and environment as a running server response.

When adopting an existing server process, the desktop will require the response's desktop identity, version, and environment to match the active app. Generated-config freshness checks will likewise require both metadata lines. A mismatch causes the existing replacement flow to stop the stale process and launch the packaged sidecar with fresh configuration.

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
4. `kanna-server` status tests verify exact production and staging response payloads, including `0.0.69-staging.1` for staging.
5. Existing transport and remote harness fixtures are updated to demonstrate that direct and tunneled `/v1/status` paths preserve the same contract.

## Out of Scope

- Changing the production or staging port assignments.
- Giving the reusable sidecar binary its own release identity.
- Supporting legacy `serverVersion` clients after this coordinated pre-1.0 API change.
- Changing mobile application versioning or OTA runtime versions.
