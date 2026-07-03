use kanna_runtime_defaults::DesktopCloudEnvironment;

#[cfg(test)]
pub(super) fn relay_url() -> String {
    relay_url_for_bundled_cloud_env(None)
}

#[cfg(test)]
fn relay_url_for_mode(debug_assertions: bool) -> String {
    if !debug_assertions {
        return kanna_runtime_defaults::PRODUCTION_RELAY_URL.to_string();
    }
    relay_url_for_bundled_cloud_env(None)
}

pub(super) fn relay_url_for_bundled_cloud_env(
    cloud_env: Option<DesktopCloudEnvironment>,
) -> String {
    if let Ok(url) = std::env::var("KANNA_RELAY_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(port) = std::env::var("KANNA_RELAY_PORT") {
        let trimmed = port.trim();
        if !trimmed.is_empty() {
            return format!("ws://127.0.0.1:{}", trimmed);
        }
    }
    if let Some(cloud_env) = effective_cloud_env(cloud_env) {
        return cloud_env.relay_url().to_string();
    }
    String::new()
}

pub(super) fn firebase_project_id(cloud_env: Option<DesktopCloudEnvironment>) -> String {
    if let Ok(project_id) = std::env::var("KANNA_FIREBASE_PROJECT_ID") {
        let trimmed = project_id.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    effective_cloud_env(cloud_env)
        .map(|env| env.firebase_project_id().to_string())
        .unwrap_or_else(|| kanna_runtime_defaults::LOCAL_FIREBASE_PROJECT_ID.to_string())
}

pub(super) fn effective_cloud_env(
    bundled_cloud_env: Option<DesktopCloudEnvironment>,
) -> Option<DesktopCloudEnvironment> {
    match std::env::var("KANNA_CLOUD_ENV") {
        Ok(value) => kanna_runtime_defaults::desktop_cloud_environment_from_env(Some(&value)),
        Err(_) => bundled_cloud_env,
    }
}

pub(super) fn firebase_auth_emulator_url() -> Option<String> {
    if let Ok(host) = std::env::var("FIREBASE_AUTH_EMULATOR_HOST") {
        let trimmed = host.trim();
        if !trimmed.is_empty() {
            return Some(format!(
                "http://{}",
                trimmed
                    .trim_start_matches("http://")
                    .trim_start_matches("https://")
            ));
        }
    }
    if let Ok(port) = std::env::var("KANNA_FIREBASE_AUTH_PORT") {
        let trimmed = port.trim();
        if !trimmed.is_empty() {
            return Some(format!("http://127.0.0.1:{trimmed}"));
        }
    }
    None
}

pub(super) fn firebase_firestore_emulator_host() -> Option<String> {
    if let Ok(host) = std::env::var("FIRESTORE_EMULATOR_HOST") {
        let trimmed = host.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Ok(port) = std::env::var("KANNA_FIREBASE_FIRESTORE_PORT") {
        let trimmed = port.trim();
        if !trimmed.is_empty() {
            return Some(format!("127.0.0.1:{trimmed}"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mobile::tests::{env_lock, set_env_var, unset_env_var};

    #[test]
    fn relay_url_prefers_explicit_url() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_RELAY_URL", "ws://relay.local:19080");
            set_env_var("KANNA_RELAY_PORT", "19083");
        }

        assert_eq!(relay_url(), "ws://relay.local:19080");

        unsafe {
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
        }
    }

    #[test]
    fn relay_url_defaults_to_production_relay_for_release_builds() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
        }

        assert_eq!(super::relay_url_for_mode(false), "wss://relay.kanna.build");
    }
}
