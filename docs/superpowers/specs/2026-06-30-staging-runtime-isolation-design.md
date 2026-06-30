# Staging Desktop Runtime Isolation Design

## Goal

`Kanna Staging.app` must run as an installed staging desktop app without sharing local runtime state with production `Kanna.app`. The staging bundle already gets its own Tauri app data directory and SQLite database via bundle id `build.kanna.staging`; the same bundle identity must also drive daemon and local `kanna-server` defaults.

## Runtime Defaults

Bundle-aware defaults live in `crates/runtime-defaults` as the shared source of truth.

- Production bundle `build.kanna` keeps the existing daemon directory: `~/Library/Application Support/Kanna`.
- Staging bundle `build.kanna.staging` uses `~/Library/Application Support/build.kanna.staging/Kanna` for daemon sockets, pid files, recovery files, and journals.
- Production keeps local `kanna-server` port `48120`.
- Staging uses local `kanna-server` port `48121`.
- Explicit environment overrides still win: `KANNA_DAEMON_DIR` and `KANNA_MOBILE_SERVER_PORT` remain authoritative when set.

## Desktop Integration

Installed desktop startup should derive the daemon directory from the app bundle identifier when `KANNA_DAEMON_DIR` is unset. `MobileServerManager` should derive its default local server port from the same bundled cloud environment when `KANNA_MOBILE_SERVER_PORT` is unset.

The desktop-started `kanna-server` config should then contain the isolated daemon dir and staging port for staging builds, while retaining staging relay and Firebase defaults from the existing cloud environment logic.

## Testing

Focused Rust tests should cover:

- staging bundle daemon dir resolves under `build.kanna.staging/Kanna`;
- production bundle preserves `Kanna`;
- staging local server port defaults to `48121`;
- production local server port remains `48120`;
- explicit env overrides preserve current behavior;
- staging server config writes the staging daemon dir and `lan_port = 48121`.
