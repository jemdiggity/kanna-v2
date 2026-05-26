use std::path::{Path, PathBuf};

pub const DESKTOP_BUNDLE_IDENTIFIER: &str = "build.kanna";
pub const LEGACY_DESKTOP_BUNDLE_IDENTIFIER: &str = "com.kanna.app";
pub const PRODUCT_APP_SUPPORT_DIR: &str = "Kanna";
pub const DEFAULT_DB_NAME: &str = "kanna-v2.db";

pub fn default_daemon_dir_for_home(home: &Path) -> PathBuf {
    macos_app_support_dir_for_home(home).join(PRODUCT_APP_SUPPORT_DIR)
}

pub fn default_daemon_dir_for_app_support_root(app_support_root: &Path) -> PathBuf {
    app_support_root.join(PRODUCT_APP_SUPPORT_DIR)
}

pub fn default_daemon_dir() -> PathBuf {
    default_daemon_dir_for_home(&home_dir())
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
}
