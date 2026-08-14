# App Update Design

Date: 2026-04-15
Status: Approved for planning

## Summary

Kanna should support packaged-app self-updates on macOS using Tauri's official updater flow. The app will check for updates shortly after startup and continue checking in the background while it runs. When a newer version is available, Kanna will show a dismissible update prompt with the release version and notes. The user can either dismiss the prompt or choose to update.

If the user chooses to update, Kanna will download and install the signed updater bundle, show progress in the prompt UI, and then offer a restart action after installation completes. Kanna will not restart automatically.

The release workflow must also publish updater artifacts in addition to the existing DMG assets. `ship.sh` will generate the signed updater bundle and a static `latest.json` metadata file that the packaged app can query via the official Tauri updater plugin.

## Problem

The desktop app already reserves a plugin slot for updates via the local `tauri-plugin-delta-updater` crate, but that crate is only a placeholder and does not provide any update behavior. The current product also has no runtime update UI, no updater configuration in `tauri.conf.json`, and no release metadata published for the app to consume.

Without a supported updater flow:

- packaged users do not learn about new Kanna releases inside the app
- there is no signed in-app installation path for new versions
- release automation only ships installer DMGs, not updater bundles
- the placeholder custom updater path adds architectural noise without providing value

## Goals

- Add in-app update detection for packaged macOS builds.
- Check for updates both after app startup and periodically in the background.
- Notify the user when an update is available and allow them to either dismiss it or install it.
- Download and install updates only after explicit user action.
- Reuse Tauri's official updater contract instead of building a bespoke updater protocol.
- Extend `ship.sh` so releases publish the signed updater artifacts and static metadata needed by the packaged app.

## Non-Goals

- Adding update support to dev builds or worktree runs.
- Adding a manual `Check for Updates` command, shortcut, or preferences control.
- Implementing rollout channels, staged rollouts, or beta/stable switching.
- Preserving the custom `tauri-plugin-delta-updater` runtime path.
- Building a bespoke update server.

## Chosen Approach

Use Tauri's official updater plugin with a static `latest.json` file hosted alongside GitHub Release assets.

At runtime:

- packaged builds will start an app-level updater controller from `App.vue`
- the controller will call the updater plugin after a short startup delay
- the controller will repeat that check on a fixed background interval
- when a newer version is found, the controller will surface a dedicated update prompt
- if the user clicks `Update`, the controller will download and install the signed updater bundle
- once installation completes, the prompt will switch to a restart-ready state with `Restart Now` and `Later`

At release time:

- Tauri bundling will generate updater artifacts for macOS
- `ship.sh` will collect the generated `.app.tar.gz` bundles and `.sig` files
- `ship.sh` will upload those assets with the normal DMGs
- `ship.sh` will also generate and upload a `latest.json` file containing version, release notes, publication date, platform URLs, and inline signatures

This approach matches the existing architecture better than a custom updater because the runtime logic stays in the app shell, the security contract is handled by Tauri's signed updater artifacts, and the operational footprint stays limited to GitHub Releases.

## Runtime Behavior

### Build Gating

Updater checks will run only when all of the following are true:

- the app is running on desktop
- the build is not a dev build
- the app is not running from a Kanna worktree dev environment

Dev builds and worktree instances must remain inert so local development does not trigger release checks or install flows.

### Check Cadence

The updater controller will:

1. wait 15 seconds after `App.vue` mount before the first check
2. perform a check immediately after that delay
3. repeat checks every 6 hours while the app remains open
4. ensure only one check is in flight at a time

If a check is already running when the interval fires, the next interval tick is skipped rather than queued.

### Availability Prompt

When a newer version is returned by the updater API, Kanna will show a dedicated update prompt component. This is not a toast. The prompt needs to support:

- version display
- release notes text
- actionable buttons
- download progress
- install errors
- restart-ready state

The prompt actions in the availability state are:

- `Update`
- `Dismiss`

Choosing `Dismiss` suppresses prompts for that exact version for the remainder of the current app session. A later version found during the same session may still be shown.

### Install Flow

If the user clicks `Update`, Kanna will call the updater plugin's download-and-install path and stream progress into the prompt UI.

The prompt states are:

- `available`
- `downloading`
- `readyToRestart`
- `error`

While downloading:

- the `Update` action is disabled
- the prompt shows byte progress when available from updater events
- the prompt does not offer `Dismiss` or `Cancel`

This design intentionally omits cancellation because the official updater API is centered on download-and-install rather than a cancellable transfer contract. The safer default is to keep the prompt in-progress until completion or failure.

### Restart Behavior

After installation completes, Kanna will not restart automatically. Instead the prompt will present:

- `Restart Now`
- `Later`

`Restart Now` relaunches the app using the Tauri-supported restart path.

`Later` closes the prompt. The newly installed version is then applied the next time the user restarts the app manually. The session does not need to keep re-prompting after the install has already succeeded.

### Failure Handling

- Background check failures are silent to the user and should only be logged for diagnostics.
- Failures after the user clicks `Update` switch the prompt to an explicit error state with a retry action.
- Invalid or incomplete update metadata is treated as a failed check and should not surface a broken partial prompt.
- If a version has already been dismissed in the current session, repeated checks returning that same version do nothing.

## Frontend Architecture

### New App-Level Update Controller

Add a small app-shell updater module or composable owned by `App.vue`. It should not live in `stores/kanna.ts` because updates are app lifecycle concerns, not repository or task state.

Responsibilities:

- decide whether updater checks are enabled for the current runtime
- manage startup delay and background interval
- call the Tauri updater `check()` API
- suppress duplicate prompts for the same dismissed version
- expose current update state to the UI
- run `downloadAndInstall()` when the user chooses to update
- expose progress, completion, and error state transitions
- trigger restart when the user chooses `Restart Now`

Suggested state shape:

- `status`: `idle | checking | available | downloading | readyToRestart | error`
- `updateVersion`: string or `null`
- `releaseNotes`: string or `null`
- `publishedAt`: string or `null`
- `dismissedVersion`: string or `null`
- `downloadedBytes`: number
- `contentLength`: number or `null`
- `errorMessage`: string or `null`

### UI Component

Add a focused update prompt component rather than trying to extend the existing toast system.

Reasons:

- toasts currently support only warning and error messages
- toasts have no action buttons beyond dismiss
- the update flow needs multiline notes and progress rendering
- update state should persist visibly while downloading or waiting for restart

The prompt may be implemented as a compact modal or anchored floating panel. It should visually read as a global app notification, not as a task-specific modal.

### Internationalization

Add dedicated i18n strings for:

- update available title
- current version / new version labels
- release notes label
- update action
- dismiss action
- downloading text
- restart now
- later
- installation failed
- retry

## Tauri And Dependency Changes

### Plugin Configuration

Replace the placeholder custom updater runtime path with the official updater plugin configuration in `apps/desktop/src-tauri/tauri.conf.json`.

Required config:

- `bundle.createUpdaterArtifacts: true`
- `plugins.updater.pubkey`
- `plugins.updater.endpoints`

The endpoint will point to the static `latest.json` file published with GitHub Releases.

### JavaScript Dependencies

Add the official Tauri updater JavaScript package and the official Tauri process plugin package to the desktop app dependencies.

The frontend will use the process plugin relaunch API for `Restart Now`. The Rust runtime must register the matching process plugin so restart behavior follows the official Tauri path instead of introducing a custom restart command.

### Rust Runtime

Register the official updater plugin in the Tauri builder. The local `tauri-plugin-delta-updater` crate should no longer be used for runtime update behavior once the official plugin is wired in.

The local crate may be removed outright or left only if it serves another non-runtime purpose later. For this feature, the runtime must stop depending on it.

## Release Workflow Changes

### Updater Artifacts

Enable updater artifact generation in the packaged build so macOS releases produce:

- the standard `.app`
- the updater bundle `.app.tar.gz`
- the updater signature `.app.tar.gz.sig`

These artifacts must be produced for both supported macOS architectures.

### Signing Keys

The release process must have access to the Tauri updater signing private key and optional password via environment variables or equivalent secret injection. The corresponding public key must be embedded in the packaged app configuration.

The design assumes long-term key continuity. Rotating the updater key is outside the scope of this feature.

### `latest.json`

`ship.sh` will generate a static `latest.json` file with this shape:

```json
{
  "version": "0.0.39",
  "notes": "Release notes body",
  "pub_date": "2026-04-15T12:34:56Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of sig file>",
      "url": "https://github.com/jemdiggity/kanna/releases/download/v0.0.39/Kanna.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<contents of sig file>",
      "url": "https://github.com/jemdiggity/kanna/releases/download/v0.0.39/Kanna-x86_64.app.tar.gz"
    }
  }
}
```

The exact updater bundle filenames must match the real build outputs. The implementation should derive them from the build artifacts rather than hardcoding guessed names.

`notes` should come from the GitHub release notes body already assembled for the release. If `ship.sh` does not currently materialize release notes in one place, the implementation should choose a single source and use it both for the GitHub release body and `latest.json`.

### GitHub Release Publishing

The GitHub release for each version must upload:

- arm64 DMG
- x86_64 DMG
- arm64 updater bundle
- arm64 updater signature
- x86_64 updater bundle
- x86_64 updater signature
- `latest.json`

Because the runtime will always query the static `latest.json` endpoint, the release workflow must ensure that file is updated atomically with the release assets for a given version.

## Security And Validation

- TLS-backed updater endpoints are required in production.
- The packaged app validates downloaded updater artifacts using the configured public key.
- `latest.json` must include complete platform data for all supported macOS targets because Tauri validates the whole file before version comparison.
- Release automation must fail if updater artifacts or signatures are missing instead of silently publishing an incomplete release.

## Testing Strategy

### Frontend Tests

- controller test: startup delay triggers initial check
- controller test: periodic background checks continue on the configured interval
- controller test: repeated results for a dismissed version do not reopen the prompt
- controller test: a newer version than the dismissed one does reopen the prompt
- controller test: install progress updates controller state
- controller test: successful install transitions to `readyToRestart`
- controller test: install failure transitions to `error`

### Component Tests

- prompt renders available-version state with `Update` and `Dismiss`
- prompt renders progress state while downloading
- prompt renders restart-ready state with `Restart Now` and `Later`
- prompt renders retry state after install failure

### Release Tests

- `ship.sh` test coverage for updater artifact discovery and release asset naming
- `ship.sh` test coverage for `latest.json` generation
- validation that missing updater artifacts fail the release instead of producing partial output

### Manual Verification

1. Build a packaged app with updater configuration enabled.
2. Publish a test release with valid updater artifacts and `latest.json`.
3. Launch the older packaged app and wait for the background check.
4. Confirm the update prompt appears with the expected version and notes.
5. Dismiss it and confirm the same version does not reappear in that session.
6. Relaunch the app and confirm the prompt appears again for the still-available version.
7. Choose `Update` and confirm download/install completes successfully.
8. Choose `Later` and confirm the current process stays open.
9. Restart the app manually and confirm the new version is running.

## Risks

- GitHub Release asset naming for updater bundles may differ from installer asset naming; the implementation must inspect actual build outputs instead of guessing filenames.
- Incomplete `latest.json` metadata breaks the entire updater check because Tauri validates the full file before comparing versions.
- Restart behavior may require either the process plugin or a dedicated Rust path; that decision must be resolved cleanly during implementation and not split across both layers.
- Background checks can become noisy if duplicate-version suppression is not handled carefully.
- Release automation becomes more sensitive to missing signing secrets; failures must be explicit and early.

## Acceptance Criteria

- Packaged Kanna builds check for updates 15 seconds after startup and every 6 hours thereafter.
- Dev builds and worktree instances do not run updater checks.
- When a new version is available, the app shows a dismissible update prompt with release notes.
- Dismissing a version suppresses that version for the current app session only.
- Choosing `Update` downloads and installs the signed updater bundle.
- After installation, the app offers `Restart Now` and `Later` instead of restarting automatically.
- `ship.sh` publishes signed updater artifacts and a valid `latest.json` file alongside the existing release DMGs.
- The packaged app uses Tauri's official updater configuration rather than the placeholder custom updater runtime path.
