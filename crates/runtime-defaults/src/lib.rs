use std::path::{Path, PathBuf};

pub const DESKTOP_BUNDLE_IDENTIFIER: &str = "build.kanna";
pub const STAGING_DESKTOP_BUNDLE_IDENTIFIER: &str = "build.kanna.staging";
pub const LEGACY_DESKTOP_BUNDLE_IDENTIFIER: &str = "com.kanna.app";
pub const PRODUCT_APP_SUPPORT_DIR: &str = "Kanna";
pub const DEFAULT_DB_NAME: &str = "kanna-v2.db";
pub const PRODUCTION_RELAY_URL: &str = "wss://relay.kanna.build";
pub const STAGING_RELAY_URL: &str = "wss://relay-staging.kanna.build";
pub const PRODUCTION_FIREBASE_PROJECT_ID: &str = "kanna-build";
pub const STAGING_FIREBASE_PROJECT_ID: &str = "kanna-staging";
pub const LOCAL_FIREBASE_PROJECT_ID: &str = "kanna-local";
pub const PRODUCTION_LOCAL_SERVER_PORT: u16 = 48_120;
pub const STAGING_LOCAL_SERVER_PORT: u16 = 48_121;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopCloudEnvironment {
    Staging,
    Production,
}

impl DesktopCloudEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::Production => "production",
        }
    }

    pub fn relay_url(self) -> &'static str {
        match self {
            Self::Staging => STAGING_RELAY_URL,
            Self::Production => PRODUCTION_RELAY_URL,
        }
    }

    pub fn firebase_project_id(self) -> &'static str {
        match self {
            Self::Staging => STAGING_FIREBASE_PROJECT_ID,
            Self::Production => PRODUCTION_FIREBASE_PROJECT_ID,
        }
    }

    pub fn local_server_port(self) -> u16 {
        match self {
            Self::Staging => STAGING_LOCAL_SERVER_PORT,
            Self::Production => PRODUCTION_LOCAL_SERVER_PORT,
        }
    }

    pub fn daemon_dir_for_home(self, home: &Path) -> PathBuf {
        match self {
            Self::Staging => daemon_dir_for_bundle_identifier_for_home(
                STAGING_DESKTOP_BUNDLE_IDENTIFIER,
                false,
                home,
            ),
            Self::Production => default_daemon_dir_for_home(home),
        }
    }
}

pub fn desktop_cloud_environment_for_bundle_identifier(
    bundle_identifier: &str,
    debug_assertions: bool,
) -> Option<DesktopCloudEnvironment> {
    if debug_assertions {
        return None;
    }

    match bundle_identifier {
        STAGING_DESKTOP_BUNDLE_IDENTIFIER => Some(DesktopCloudEnvironment::Staging),
        DESKTOP_BUNDLE_IDENTIFIER => Some(DesktopCloudEnvironment::Production),
        _ => None,
    }
}

pub fn desktop_cloud_environment_from_env(value: Option<&str>) -> Option<DesktopCloudEnvironment> {
    match value?.trim().to_lowercase().as_str() {
        "staging" => Some(DesktopCloudEnvironment::Staging),
        "production" | "prod" => Some(DesktopCloudEnvironment::Production),
        _ => None,
    }
}

pub fn default_daemon_dir_for_home(home: &Path) -> PathBuf {
    macos_app_support_dir_for_home(home).join(PRODUCT_APP_SUPPORT_DIR)
}

pub fn default_daemon_dir_for_app_support_root(app_support_root: &Path) -> PathBuf {
    app_support_root.join(PRODUCT_APP_SUPPORT_DIR)
}

pub fn default_daemon_dir() -> PathBuf {
    default_daemon_dir_for_home(&home_dir())
}

pub fn daemon_dir_for_desktop_cloud_environment(environment: DesktopCloudEnvironment) -> PathBuf {
    environment.daemon_dir_for_home(&home_dir())
}

pub fn daemon_dir_for_bundle_identifier_for_home(
    bundle_identifier: &str,
    debug_assertions: bool,
    home: &Path,
) -> PathBuf {
    daemon_dir_for_bundle_identifier_for_app_support_root(
        bundle_identifier,
        debug_assertions,
        &macos_app_support_dir_for_home(home),
    )
}

pub fn daemon_dir_for_bundle_identifier_for_app_support_root(
    bundle_identifier: &str,
    debug_assertions: bool,
    app_support_root: &Path,
) -> PathBuf {
    match desktop_cloud_environment_for_bundle_identifier(bundle_identifier, debug_assertions) {
        Some(DesktopCloudEnvironment::Staging) => app_support_root
            .join(STAGING_DESKTOP_BUNDLE_IDENTIFIER)
            .join(PRODUCT_APP_SUPPORT_DIR),
        Some(DesktopCloudEnvironment::Production) | None => {
            default_daemon_dir_for_app_support_root(app_support_root)
        }
    }
}

pub fn local_server_port_for_bundle_identifier(
    bundle_identifier: &str,
    debug_assertions: bool,
) -> u16 {
    desktop_cloud_environment_for_bundle_identifier(bundle_identifier, debug_assertions)
        .map(DesktopCloudEnvironment::local_server_port)
        .unwrap_or(PRODUCTION_LOCAL_SERVER_PORT)
}

pub fn daemon_dir_for_runtime(
    explicit_daemon_dir: Option<&Path>,
    current_exe: &Path,
    current_dir: &Path,
    home: &Path,
) -> PathBuf {
    daemon_dir_for_runtime_with_bundle_identifier(
        explicit_daemon_dir,
        current_exe,
        current_dir,
        home,
        None,
        cfg!(debug_assertions),
    )
}

pub fn daemon_dir_for_runtime_with_bundle_identifier(
    explicit_daemon_dir: Option<&Path>,
    current_exe: &Path,
    current_dir: &Path,
    home: &Path,
    bundle_identifier: Option<&str>,
    debug_assertions: bool,
) -> PathBuf {
    let worktree_root =
        worktree_root_for_path(current_exe).or_else(|| worktree_root_for_path(current_dir));
    if let Some(dir) = explicit_daemon_dir {
        let production_dir = default_daemon_dir_for_home(home);
        let staging_dir = daemon_dir_for_bundle_identifier_for_home(
            STAGING_DESKTOP_BUNDLE_IDENTIFIER,
            false,
            home,
        );
        if worktree_root.is_none() || (dir != production_dir && dir != staging_dir) {
            return dir.to_path_buf();
        }
    }

    if let Some(worktree_root) = worktree_root {
        return worktree_root.join(".kanna-daemon");
    }

    bundle_identifier
        .map(|identifier| {
            daemon_dir_for_bundle_identifier_for_home(identifier, debug_assertions, home)
        })
        .unwrap_or_else(|| default_daemon_dir_for_home(home))
}

pub fn daemon_dir_for_current_runtime() -> PathBuf {
    daemon_dir_for_current_runtime_with_bundle_identifier(None, cfg!(debug_assertions))
}

pub fn daemon_dir_for_current_runtime_with_bundle_identifier(
    bundle_identifier: Option<&str>,
    debug_assertions: bool,
) -> PathBuf {
    let explicit = std::env::var_os("KANNA_DAEMON_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::new());
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::new());
    daemon_dir_for_runtime_with_bundle_identifier(
        explicit.as_deref(),
        &current_exe,
        &current_dir,
        &home_dir(),
        bundle_identifier,
        debug_assertions,
    )
}

pub fn worktree_root_for_path(path: &Path) -> Option<PathBuf> {
    for candidate in path.ancestors() {
        if candidate.parent().is_some_and(|parent| {
            parent
                .file_name()
                .is_some_and(|name| name == ".kanna-worktrees")
        }) {
            return Some(candidate.to_path_buf());
        }
    }
    None
}

pub fn canonical_desktop_app_data_dir_for_home(home: &Path) -> PathBuf {
    macos_app_support_dir_for_home(home).join(DESKTOP_BUNDLE_IDENTIFIER)
}

pub fn canonical_desktop_app_data_dir_for_app_support_root(app_support_root: &Path) -> PathBuf {
    app_support_root.join(DESKTOP_BUNDLE_IDENTIFIER)
}

pub fn canonical_desktop_app_data_dir() -> PathBuf {
    canonical_desktop_app_data_dir_for_home(&home_dir())
}

pub fn canonical_desktop_db_path_for_home(home: &Path) -> PathBuf {
    canonical_desktop_app_data_dir_for_home(home).join(DEFAULT_DB_NAME)
}

pub fn canonical_desktop_db_path_for_app_support_root(app_support_root: &Path) -> PathBuf {
    canonical_desktop_app_data_dir_for_app_support_root(app_support_root).join(DEFAULT_DB_NAME)
}

pub fn canonical_desktop_db_path() -> PathBuf {
    canonical_desktop_db_path_for_home(&home_dir())
}

pub fn legacy_desktop_db_path_for_home(home: &Path) -> PathBuf {
    macos_app_support_dir_for_home(home)
        .join(LEGACY_DESKTOP_BUNDLE_IDENTIFIER)
        .join(DEFAULT_DB_NAME)
}

pub fn legacy_desktop_db_path_for_app_support_root(app_support_root: &Path) -> PathBuf {
    app_support_root
        .join(LEGACY_DESKTOP_BUNDLE_IDENTIFIER)
        .join(DEFAULT_DB_NAME)
}

pub fn preferred_desktop_db_path_for_home(home: &Path) -> PathBuf {
    preferred_desktop_db_path_for_candidates(
        canonical_desktop_db_path_for_home(home),
        legacy_desktop_db_path_for_home(home),
    )
}

pub fn preferred_desktop_db_path_for_app_support_root(app_support_root: &Path) -> PathBuf {
    preferred_desktop_db_path_for_candidates(
        canonical_desktop_db_path_for_app_support_root(app_support_root),
        legacy_desktop_db_path_for_app_support_root(app_support_root),
    )
}

pub fn preferred_desktop_db_path() -> PathBuf {
    preferred_desktop_db_path_for_home(&home_dir())
}

pub fn preferred_desktop_db_path_for_candidates(canonical: PathBuf, legacy: PathBuf) -> PathBuf {
    if canonical.exists() {
        return canonical;
    }

    if legacy.exists() {
        return legacy;
    }

    canonical
}

pub fn default_transfer_root_for_home(home: &Path) -> PathBuf {
    canonical_desktop_app_data_dir_for_home(home).join("transfer")
}

pub fn default_transfer_root() -> PathBuf {
    default_transfer_root_for_home(&home_dir())
}

pub fn default_transfer_registry_dir_for_home(home: &Path) -> PathBuf {
    default_transfer_root_for_home(home).join("registry")
}

pub fn default_transfer_registry_dir() -> PathBuf {
    default_transfer_registry_dir_for_home(&home_dir())
}

fn macos_app_support_dir_for_home(home: &Path) -> PathBuf {
    home.join("Library").join("Application Support")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_dir_defaults_to_product_app_support_directory() {
        let home = Path::new("/Users/tester");

        assert_eq!(
            default_daemon_dir_for_home(home),
            PathBuf::from("/Users/tester/Library/Application Support/Kanna")
        );
    }

    #[test]
    fn daemon_dir_infers_worktree_from_runtime_path_when_env_is_missing() {
        let home = Path::new("/Users/tester");
        let current_exe = Path::new("/repo/.kanna-worktrees/task-1234/.build/debug/kanna-desktop");
        let current_dir = Path::new("/repo/.kanna-worktrees/task-1234/apps/desktop");

        assert_eq!(
            daemon_dir_for_runtime(None, current_exe, current_dir, home),
            PathBuf::from("/repo/.kanna-worktrees/task-1234/.kanna-daemon")
        );
    }

    #[test]
    fn daemon_dir_explicit_env_wins_inside_worktree() {
        let home = Path::new("/Users/tester");
        let current_exe = Path::new("/repo/.kanna-worktrees/task-1234/.build/debug/kanna-desktop");
        let current_dir = Path::new("/repo/.kanna-worktrees/task-1234/apps/desktop");

        assert_eq!(
            daemon_dir_for_runtime(
                Some(Path::new("/tmp/kanna-e2e-daemon")),
                current_exe,
                current_dir,
                home,
            ),
            PathBuf::from("/tmp/kanna-e2e-daemon")
        );
    }

    #[test]
    fn daemon_dir_ignores_production_env_inside_worktree() {
        let home = Path::new("/Users/tester");
        let current_exe = Path::new("/repo/.kanna-worktrees/task-1234/.build/debug/kanna-desktop");
        let current_dir = Path::new("/repo/.kanna-worktrees/task-1234/apps/desktop");

        assert_eq!(
            daemon_dir_for_runtime(
                Some(Path::new("/Users/tester/Library/Application Support/Kanna")),
                current_exe,
                current_dir,
                home,
            ),
            PathBuf::from("/repo/.kanna-worktrees/task-1234/.kanna-daemon")
        );
    }

    #[test]
    fn daemon_dir_ignores_staging_env_inside_worktree() {
        let home = Path::new("/Users/tester");
        let current_exe = Path::new("/repo/.kanna-worktrees/task-1234/.build/debug/kanna-desktop");
        let current_dir = Path::new("/repo/.kanna-worktrees/task-1234/apps/desktop");

        assert_eq!(
            daemon_dir_for_runtime_with_bundle_identifier(
                Some(Path::new(
                    "/Users/tester/Library/Application Support/build.kanna.staging/Kanna"
                )),
                current_exe,
                current_dir,
                home,
                Some(STAGING_DESKTOP_BUNDLE_IDENTIFIER),
                false,
            ),
            PathBuf::from("/repo/.kanna-worktrees/task-1234/.kanna-daemon")
        );
    }

    #[test]
    fn daemon_dir_uses_production_default_outside_worktree() {
        let home = Path::new("/Users/tester");
        let current_exe = Path::new("/Applications/Kanna.app/Contents/MacOS/kanna-desktop");
        let current_dir = Path::new("/Users/tester/.kanna/repos/kanna");

        assert_eq!(
            daemon_dir_for_runtime(None, current_exe, current_dir, home),
            PathBuf::from("/Users/tester/Library/Application Support/Kanna")
        );
    }

    #[test]
    fn daemon_dir_uses_staging_bundle_app_support_directory() {
        let home = Path::new("/Users/tester");

        assert_eq!(
            daemon_dir_for_bundle_identifier_for_home(
                STAGING_DESKTOP_BUNDLE_IDENTIFIER,
                false,
                home
            ),
            PathBuf::from("/Users/tester/Library/Application Support/build.kanna.staging/Kanna")
        );
    }

    #[test]
    fn daemon_dir_uses_product_app_support_directory_for_production_bundle() {
        let home = Path::new("/Users/tester");

        assert_eq!(
            daemon_dir_for_bundle_identifier_for_home(DESKTOP_BUNDLE_IDENTIFIER, false, home),
            PathBuf::from("/Users/tester/Library/Application Support/Kanna")
        );
    }

    #[test]
    fn desktop_db_defaults_to_canonical_bundle_directory() {
        let home = Path::new("/Users/tester");

        assert_eq!(
            canonical_desktop_db_path_for_home(home),
            PathBuf::from("/Users/tester/Library/Application Support/build.kanna/kanna-v2.db")
        );
    }

    #[test]
    fn transfer_registry_defaults_under_canonical_desktop_app_data() {
        let home = Path::new("/Users/tester");

        assert_eq!(
            default_transfer_registry_dir_for_home(home),
            PathBuf::from(
                "/Users/tester/Library/Application Support/build.kanna/transfer/registry"
            )
        );
    }

    #[test]
    fn preferred_db_path_uses_existing_legacy_only_when_canonical_is_absent() {
        let unique =
            std::env::temp_dir().join(format!("kanna-runtime-defaults-{}", std::process::id()));
        let canonical = unique.join("build.kanna").join(DEFAULT_DB_NAME);
        let legacy = unique.join("com.kanna.app").join(DEFAULT_DB_NAME);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, b"").unwrap();

        assert_eq!(
            preferred_desktop_db_path_for_candidates(canonical.clone(), legacy.clone()),
            legacy
        );

        std::fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        std::fs::write(&canonical, b"").unwrap();

        assert_eq!(
            preferred_desktop_db_path_for_candidates(canonical.clone(), legacy),
            canonical
        );

        let _ = std::fs::remove_dir_all(unique);
    }

    #[test]
    fn desktop_cloud_environment_resolves_from_release_bundle_identifier() {
        assert_eq!(
            desktop_cloud_environment_for_bundle_identifier(
                STAGING_DESKTOP_BUNDLE_IDENTIFIER,
                false
            ),
            Some(DesktopCloudEnvironment::Staging)
        );
        assert_eq!(
            desktop_cloud_environment_for_bundle_identifier(DESKTOP_BUNDLE_IDENTIFIER, false),
            Some(DesktopCloudEnvironment::Production)
        );
    }

    #[test]
    fn desktop_cloud_environment_ignores_bundle_identifier_in_debug_builds() {
        assert_eq!(
            desktop_cloud_environment_for_bundle_identifier(
                STAGING_DESKTOP_BUNDLE_IDENTIFIER,
                true
            ),
            None
        );
    }

    #[test]
    fn desktop_cloud_environment_carries_server_defaults() {
        assert_eq!(
            DesktopCloudEnvironment::Staging.relay_url(),
            "wss://relay-staging.kanna.build"
        );
        assert_eq!(
            DesktopCloudEnvironment::Staging.firebase_project_id(),
            "kanna-staging"
        );
        assert_eq!(
            DesktopCloudEnvironment::Production.relay_url(),
            "wss://relay.kanna.build"
        );
        assert_eq!(
            DesktopCloudEnvironment::Production.firebase_project_id(),
            "kanna-build"
        );
        assert_eq!(DesktopCloudEnvironment::Staging.local_server_port(), 48121);
        assert_eq!(
            DesktopCloudEnvironment::Production.local_server_port(),
            48120
        );
        assert_eq!(
            DesktopCloudEnvironment::Staging.daemon_dir_for_home(Path::new("/Users/tester")),
            PathBuf::from("/Users/tester/Library/Application Support/build.kanna.staging/Kanna")
        );
        assert_eq!(
            DesktopCloudEnvironment::Production.daemon_dir_for_home(Path::new("/Users/tester")),
            PathBuf::from("/Users/tester/Library/Application Support/Kanna")
        );
    }
}
