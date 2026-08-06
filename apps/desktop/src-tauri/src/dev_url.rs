//! Guards against a dev binary that was compiled for a different dev server.
//!
//! `tauri dev` merges `tauri.conf.local.json` into the `TAURI_CONFIG` env var and
//! `tauri::generate_context!()` expands it at rustc time, so `build.devUrl` is *compiled
//! into* the binary. The dev server port, though, is per-instance runtime data: the E2E
//! harness gives every app instance its own port, and two instances of the same build run
//! side by side during transfer tests.
//!
//! A binary built for another port does not merely load the wrong page — the compiled-in
//! URL is also what Tauri's capability ACL means by "local", so:
//!
//! * if that port is dead, the first navigation is refused and the window sits at
//!   `about:blank` forever; and
//! * if a leaked dev server still holds it, the page loads but every ACL-scoped command is
//!   denied (`event.listen not allowed on window "main" … allowed on: [… URL: local]`) and
//!   the app renders "Kanna couldn't start safely".
//!
//! `build.rs` pins the config fingerprint so cargo cannot hand back a crate compiled with
//! a stale `TAURI_CONFIG`. This module is the tripwire for the day that stops working:
//! `KANNA_DEV_PORT` is what the instance was actually launched for, so a mismatch is
//! reported by name instead of surfacing as an unexplained blank window.

use tauri::Url;

pub(crate) const DEV_PORT_ENV: &str = "KANNA_DEV_PORT";

/// Returns the URL this instance was launched for when it differs from the compiled-in
/// one, or `None` when they agree (or there is no dev server at all).
pub(crate) fn mismatched_dev_url(
    config_dev_url: Option<&Url>,
    dev_port: Option<&str>,
) -> Option<Url> {
    let config_dev_url = config_dev_url?;
    let port: u16 = dev_port?.trim().parse().ok()?;
    if config_dev_url.port() == Some(port) {
        return None;
    }
    let mut expected = config_dev_url.clone();
    expected.set_port(Some(port)).ok()?;
    Some(expected)
}

/// Reports a compiled-in dev server URL that does not belong to this instance. Prints to
/// stderr, which lands in the `desktop` tmux pane the E2E harness captures on failure.
pub(crate) fn warn_on_stale_dev_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let dev_port = std::env::var(DEV_PORT_ENV).ok();
    let config_dev_url = app.config().build.dev_url.clone();
    let Some(expected) = mismatched_dev_url(config_dev_url.as_ref(), dev_port.as_deref()) else {
        return;
    };
    eprintln!(
        "[dev] this binary was compiled for {} but {} says {} — the build is stale, so the \
         window will not load and ACL-scoped commands will be denied (config fingerprint {})",
        config_dev_url
            .map(|url| url.to_string())
            .unwrap_or_else(|| "<none>".to_string()),
        DEV_PORT_ENV,
        expected,
        crate::TAURI_CONFIG_FINGERPRINT,
    );
}

#[cfg(test)]
mod tests {
    use super::mismatched_dev_url;
    use tauri::Url;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("valid test url")
    }

    #[test]
    fn reports_the_url_this_instance_was_launched_for() {
        let expected = mismatched_dev_url(Some(&url("http://localhost:53068/")), Some("53957"));
        assert_eq!(
            expected.map(|value| value.to_string()),
            Some("http://localhost:53957/".to_string())
        );
    }

    #[test]
    fn stays_quiet_when_the_ports_agree() {
        assert!(mismatched_dev_url(Some(&url("http://localhost:1420/")), Some("1420")).is_none());
    }

    #[test]
    fn ignores_surrounding_whitespace_in_the_env_value() {
        let expected = mismatched_dev_url(Some(&url("http://localhost:1420/")), Some(" 4200\n"));
        assert_eq!(
            expected.map(|value| value.to_string()),
            Some("http://localhost:4200/".to_string())
        );
    }

    #[test]
    fn keeps_the_configured_scheme_and_host() {
        let expected = mismatched_dev_url(Some(&url("http://127.0.0.1:1420/")), Some("4200"));
        assert_eq!(
            expected.map(|value| value.to_string()),
            Some("http://127.0.0.1:4200/".to_string())
        );
    }

    #[test]
    fn stays_quiet_without_a_dev_server() {
        assert!(mismatched_dev_url(None, Some("4200")).is_none());
    }

    #[test]
    fn stays_quiet_without_the_env_var() {
        assert!(mismatched_dev_url(Some(&url("http://localhost:1420/")), None).is_none());
    }

    #[test]
    fn stays_quiet_for_an_unparsable_env_value() {
        assert!(
            mismatched_dev_url(Some(&url("http://localhost:1420/")), Some("not-a-port")).is_none()
        );
    }
}
