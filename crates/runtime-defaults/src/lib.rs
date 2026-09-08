pub mod session_id;
pub mod terminal_keys;

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Version of the server/daemon contract that fences protected terminal input
/// and accepts semantic logical messages separately from raw terminal bytes.
pub const PROTECTED_INPUT_PROTOCOL_VERSION: u32 = 3;

/// How long a transfer's destination may wait for the source to answer the
/// finalization request — the one peer request whose answer waits on a person's
/// agent being asked to stop rather than on local work.
///
/// Shared because the two halves of that request are enforced in crates that do
/// not depend on each other: the transfer sidecar
/// (`crates/task-transfer/src/runtime/config.rs`) bounds the wait, and
/// `kanna-server`'s shutdown sequence
/// (`crates/kanna-server/src/transfer_engine/finalize.rs`) has to finish inside
/// it, reaching the sidecar over stdio rather than by linking it. While each side
/// restated the number, only one direction was guarded: the server's fit test
/// caught its own budget growing past the copy, and nothing caught the sidecar's
/// window shrinking under a budget that still fit that copy. One constant makes
/// either change fail the same test.
pub const TRANSFER_FINALIZATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

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
pub const PRODUCTION_MOBILE_SERVER_PORT: u16 = 48_120;
pub const STAGING_MOBILE_SERVER_PORT: u16 = 48_121;
/// Fallback for callers with no environment in hand (the sidecar reading its own
/// env, `kd`'s defaults). Equal to the production port by construction — an
/// installed app must resolve `DesktopCloudEnvironment::transfer_port` instead,
/// or staging and production contend for one listener and the loser never binds.
pub const DEFAULT_TRANSFER_PORT: u16 = 4_455;
pub const STAGING_TRANSFER_PORT: u16 = 4_456;

/// Ports an installed Kanna binds on the user's machine. The per-task port
/// allocator seeds these as occupied so a project's dev server is never handed
/// a port Kanna will take from under it (or vice versa, depending on start
/// order). Development instances are absent on purpose: their ports come from
/// `kd`/`.kanna/config.json` and vary per worktree, so they cannot be enumerated
/// here.
pub const RESERVED_INTERNAL_PORTS: [u16; 4] = [
    PRODUCTION_MOBILE_SERVER_PORT,
    STAGING_MOBILE_SERVER_PORT,
    DEFAULT_TRANSFER_PORT,
    STAGING_TRANSFER_PORT,
];

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

    pub fn mobile_server_port(self) -> u16 {
        match self {
            Self::Staging => STAGING_MOBILE_SERVER_PORT,
            Self::Production => PRODUCTION_MOBILE_SERVER_PORT,
        }
    }

    pub fn transfer_port(self) -> u16 {
        match self {
            Self::Staging => STAGING_TRANSFER_PORT,
            Self::Production => DEFAULT_TRANSFER_PORT,
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

pub fn mobile_server_port_for_bundle_identifier(
    bundle_identifier: &str,
    debug_assertions: bool,
) -> Option<u16> {
    desktop_cloud_environment_for_bundle_identifier(bundle_identifier, debug_assertions)
        .map(|env| env.mobile_server_port())
}

pub fn transfer_port_for_bundle_identifier(
    bundle_identifier: &str,
    debug_assertions: bool,
) -> Option<u16> {
    desktop_cloud_environment_for_bundle_identifier(bundle_identifier, debug_assertions)
        .map(|env| env.transfer_port())
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

pub fn socket_path(dir: &Path) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let dir = dir.to_path_buf();
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{hash:08x}.sock"))
}

pub fn human_control_socket_path(dir: &Path) -> PathBuf {
    let daemon_socket = socket_path(dir);
    let stem = daemon_socket
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("kanna");
    PathBuf::from(format!("/tmp/{stem}-human.sock"))
}

pub fn current_target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_arch = "aarch64", target_os = "linux"))]
    {
        "aarch64-unknown-linux-gnu"
    }
    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(not(all(
        any(target_os = "macos", target_os = "linux"),
        any(target_arch = "aarch64", target_arch = "x86_64")
    )))]
    {
        "unknown-target"
    }
}

pub fn sidecar_candidates(name: &str) -> Vec<PathBuf> {
    std::env::current_exe()
        .ok()
        .map(|exe| sidecar_candidates_for_exe(&exe, name))
        .unwrap_or_default()
}

pub fn sidecar_candidates_for_exe(current_exe: &Path, name: &str) -> Vec<PathBuf> {
    let Some(exe_dir) = current_exe.parent() else {
        return Vec::new();
    };

    let sidecar_name = format!("{}-{}", name, current_target_triple());
    let mut candidates = vec![exe_dir.join(name), exe_dir.join(&sidecar_name)];

    if let (Some(build_root), Some(profile_dir)) = (exe_dir.parent(), exe_dir.file_name()) {
        if build_root.file_name().is_some_and(|dir| dir == ".build")
            && matches!(profile_dir.to_str(), Some("debug" | "release"))
        {
            let triple_dir = build_root.join(current_target_triple()).join(profile_dir);
            candidates.push(triple_dir.join(name));
            candidates.push(triple_dir.join(&sidecar_name));
        }
    }

    candidates.push(exe_dir.join("../Resources").join(&sidecar_name));
    candidates.push(exe_dir.join("../Resources").join(name));
    candidates
}

pub fn resolve_binary_from_candidates<F>(
    name: &str,
    candidates: Vec<PathBuf>,
    path_lookup: F,
) -> Result<String, String>
where
    F: FnOnce(&str) -> Result<String, String>,
{
    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    path_lookup(name)
}

pub fn which_binary(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| which_binary_in_path_os(name, &path))
}

pub fn which_binary_in_path(name: &str, path: &str) -> Option<PathBuf> {
    which_binary_in_path_os(name, std::ffi::OsStr::new(path))
}

pub fn which_binary_in_path_os(name: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .filter(|entry| !entry.as_os_str().is_empty())
        .map(|entry| entry.join(name))
        .find(|candidate| is_executable_file(candidate))
}

/// Find a user-installed executable in locations commonly used by agent CLI
/// installers. These are fallback locations for long-lived app processes whose
/// PATH was captured before an installer updated the user's shell config.
pub fn find_user_binary(name: &str) -> Option<PathBuf> {
    find_user_binary_for_home(&home_dir(), name)
}

fn find_user_binary_for_home(home: &Path, name: &str) -> Option<PathBuf> {
    user_binary_candidates_for_home(home, name)
        .into_iter()
        .find(|candidate| is_executable_file(candidate))
}

fn user_binary_candidates_for_home(home: &Path, name: &str) -> Vec<PathBuf> {
    [
        home.join(".opencode").join("bin"),
        home.join(".local").join("bin"),
        home.join(".bun").join("bin"),
        home.join(".npm").join("bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ]
    .into_iter()
    .map(|directory| directory.join(name))
    .collect()
}

#[cfg(unix)]
pub fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
pub fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Strip ANSI terminal escape sequences from text for logs and usage output.
///
/// Cursor-forward (`CSI <n> C`) is rendered as spaces and cursor-down
/// (`CSI <n> B`) as newlines so fixed-position terminal output remains
/// readable after conversion to plain text. Other escape sequences are omitted.
pub fn strip_ansi_for_display(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        match bytes[i] {
            0x1b => {
                i += 1;
                if i >= len {
                    break;
                }
                match bytes[i] {
                    b'[' => {
                        i += 1;
                        let param_start = i;
                        while i < len && !bytes[i].is_ascii_alphabetic() {
                            i += 1;
                        }
                        if i < len {
                            let command = bytes[i];
                            let params = &input[param_start..i];
                            i += 1;
                            match command {
                                b'C' => {
                                    let count = params.parse::<usize>().unwrap_or(1);
                                    for _ in 0..count {
                                        result.push(' ');
                                    }
                                }
                                b'B' => {
                                    let count = params.parse::<usize>().unwrap_or(1);
                                    for _ in 0..count {
                                        result.push('\n');
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    b']' => {
                        i += 1;
                        while i < len {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'\\' {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    0x1b => {}
                    _ => {
                        i += 1;
                    }
                }
            }
            b'\r' => {
                i += 1;
            }
            _ => {
                let byte = bytes[i];
                if byte >= 0x20 || byte == b'\n' || byte == b'\t' {
                    if byte < 0x80 {
                        result.push(byte as char);
                        i += 1;
                    } else {
                        let remaining = &input[i..];
                        if let Some(ch) = remaining.chars().next() {
                            result.push(ch);
                            i += ch.len_utf8();
                        } else {
                            i += 1;
                        }
                    }
                } else {
                    i += 1;
                }
            }
        }
    }

    result
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
    fn socket_path_matches_legacy_pathbuf_hash_algorithm() {
        fn legacy_socket_path(dir: &Path) -> PathBuf {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};

            let dir = dir.to_path_buf();
            let mut hasher = DefaultHasher::new();
            dir.hash(&mut hasher);
            let hash = hasher.finish() as u32;
            PathBuf::from(format!("/tmp/kanna-{hash:08x}.sock"))
        }

        for dir in [
            Path::new("/Users/tester/Library/Application Support/Kanna"),
            Path::new("/repo/.kanna-worktrees/task-1234/.kanna-daemon"),
            Path::new("/repo/.kanna-worktrees/task-1234/.kanna-daemon/pipeline"),
            Path::new("/tmp/kanna daemon with spaces"),
        ] {
            assert_eq!(socket_path(dir), legacy_socket_path(dir));
        }
    }

    #[test]
    fn human_control_socket_path_stays_below_unix_path_limits() {
        let daemon_dir = Path::new(
            "/private/var/folders/very/long/worktree/path/that/cannot/fit/in/a/unix/domain/socket/.kanna-daemon",
        );

        let path = human_control_socket_path(daemon_dir);
        assert_eq!(path.parent(), Some(Path::new("/tmp")));
        assert!(path.as_os_str().len() < 104);
        assert_ne!(path, socket_path(daemon_dir));
    }

    #[test]
    fn current_target_triple_matches_the_rust_host_triple() {
        // Sidecar discovery names files `<binary>-<triple>` and looks in
        // `.build/<triple>/<profile>`, so this must equal the triple cargo
        // builds under. `unknown-target` here means every staged sidecar is
        // invisible to the runtime.
        #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
        assert_eq!(current_target_triple(), "aarch64-apple-darwin");
        #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
        assert_eq!(current_target_triple(), "x86_64-apple-darwin");
        #[cfg(all(target_arch = "aarch64", target_os = "linux"))]
        assert_eq!(current_target_triple(), "aarch64-unknown-linux-gnu");
        #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
        assert_eq!(current_target_triple(), "x86_64-unknown-linux-gnu");
    }

    #[test]
    fn sidecar_candidates_cover_dev_runtime_layout() {
        let current_exe = Path::new("/repo/.build/debug/kanna-desktop");
        let candidates = sidecar_candidates_for_exe(current_exe, "kanna-daemon");

        assert_eq!(candidates[0], Path::new("/repo/.build/debug/kanna-daemon"));
        assert_eq!(
            candidates[1],
            Path::new(&format!(
                "/repo/.build/debug/kanna-daemon-{}",
                current_target_triple()
            ))
        );
        assert!(candidates.contains(
            &Path::new(&format!(
                "/repo/.build/{}/debug/kanna-daemon",
                current_target_triple()
            ))
            .to_path_buf()
        ));
    }

    #[test]
    fn sidecar_candidates_cover_bundled_resource_layout() {
        let current_exe = Path::new("/Applications/Kanna.app/Contents/MacOS/kanna-desktop");
        let candidates = sidecar_candidates_for_exe(current_exe, "kanna-server");

        assert_eq!(
            candidates[0],
            Path::new("/Applications/Kanna.app/Contents/MacOS/kanna-server")
        );
        assert_eq!(
            candidates[1],
            Path::new(&format!(
                "/Applications/Kanna.app/Contents/MacOS/kanna-server-{}",
                current_target_triple()
            ))
        );
        assert!(candidates.contains(
            &Path::new(&format!(
                "/Applications/Kanna.app/Contents/MacOS/../Resources/kanna-server-{}",
                current_target_triple()
            ))
            .to_path_buf()
        ));
        assert!(candidates.contains(
            &Path::new("/Applications/Kanna.app/Contents/MacOS/../Resources/kanna-server")
                .to_path_buf()
        ));
    }

    #[test]
    fn resolve_binary_from_candidates_prefers_first_existing_candidate() {
        let resolved = resolve_binary_from_candidates(
            "kanna-cli",
            vec![Path::new("/bin/sh").to_path_buf()],
            |_| Ok("/global/kanna-cli".to_string()),
        )
        .expect("existing sidecar candidate should resolve");

        assert_eq!(resolved, "/bin/sh");
    }

    #[test]
    fn resolve_binary_from_candidates_can_fallback_to_path() {
        let resolved = resolve_binary_from_candidates("kanna-cli", Vec::new(), |_| {
            Ok("/global/kanna-cli".to_string())
        })
        .expect("PATH fallback should resolve");

        assert_eq!(resolved, "/global/kanna-cli");
    }

    #[test]
    fn which_binary_in_path_finds_executable_in_explicit_path() {
        let unique = std::env::temp_dir().join(format!(
            "kanna-runtime-defaults-path-{}",
            std::process::id()
        ));
        let first = unique.join("first");
        let second = unique.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();

        let binary = second.join("kanna-cli");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        make_executable(&binary);

        let path = format!("{}:{}", first.display(), second.display());
        assert_eq!(which_binary_in_path("kanna-cli", &path), Some(binary));

        let _ = std::fs::remove_dir_all(unique);
    }

    #[cfg(unix)]
    #[test]
    fn which_binary_in_path_rejects_non_executable_files() {
        let unique = std::env::temp_dir().join(format!(
            "kanna-runtime-defaults-path-nonexec-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&unique).unwrap();

        let binary = unique.join("kanna-cli");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();

        assert_eq!(
            which_binary_in_path("kanna-cli", unique.to_string_lossy().as_ref()),
            None
        );

        let _ = std::fs::remove_dir_all(unique);
    }

    #[cfg(unix)]
    #[test]
    fn find_user_binary_covers_opencode_installed_after_startup() {
        let unique = std::env::temp_dir().join(format!(
            "kanna-runtime-defaults-user-bin-{}",
            std::process::id()
        ));
        let binary_name = format!("kanna-opencode-refresh-test-{}", std::process::id());
        let binary = unique.join(".opencode/bin").join(&binary_name);
        let _ = std::fs::remove_dir_all(&unique);
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();

        assert_eq!(find_user_binary_for_home(&unique, &binary_name), None);

        make_executable(&binary);
        assert_eq!(
            find_user_binary_for_home(&unique, &binary_name),
            Some(binary)
        );

        let _ = std::fs::remove_dir_all(unique);
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

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

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
    }

    #[test]
    fn desktop_cloud_environment_carries_distinct_mobile_server_ports() {
        assert_eq!(
            DesktopCloudEnvironment::Production.mobile_server_port(),
            PRODUCTION_MOBILE_SERVER_PORT
        );
        assert_eq!(
            DesktopCloudEnvironment::Staging.mobile_server_port(),
            STAGING_MOBILE_SERVER_PORT
        );
        assert_ne!(
            DesktopCloudEnvironment::Production.mobile_server_port(),
            DesktopCloudEnvironment::Staging.mobile_server_port()
        );
    }

    #[test]
    fn desktop_cloud_environment_carries_distinct_transfer_ports() {
        assert_eq!(
            DesktopCloudEnvironment::Production.transfer_port(),
            DEFAULT_TRANSFER_PORT
        );
        assert_eq!(
            DesktopCloudEnvironment::Staging.transfer_port(),
            STAGING_TRANSFER_PORT
        );
        assert_ne!(
            DesktopCloudEnvironment::Production.transfer_port(),
            DesktopCloudEnvironment::Staging.transfer_port()
        );
    }

    #[test]
    fn transfer_port_resolves_from_release_bundle_identifier() {
        assert_eq!(
            transfer_port_for_bundle_identifier(STAGING_DESKTOP_BUNDLE_IDENTIFIER, false),
            Some(STAGING_TRANSFER_PORT)
        );
        assert_eq!(
            transfer_port_for_bundle_identifier(DESKTOP_BUNDLE_IDENTIFIER, false),
            Some(DEFAULT_TRANSFER_PORT)
        );
        assert_eq!(
            transfer_port_for_bundle_identifier(STAGING_DESKTOP_BUNDLE_IDENTIFIER, true),
            None
        );
    }

    #[test]
    fn reserved_internal_ports_cover_every_installed_listener() {
        for environment in [
            DesktopCloudEnvironment::Production,
            DesktopCloudEnvironment::Staging,
        ] {
            assert!(RESERVED_INTERNAL_PORTS.contains(&environment.mobile_server_port()));
            assert!(RESERVED_INTERNAL_PORTS.contains(&environment.transfer_port()));
        }

        let mut unique = RESERVED_INTERNAL_PORTS;
        unique.sort_unstable();
        let deduped = {
            let mut deduped = unique.to_vec();
            deduped.dedup();
            deduped
        };
        assert_eq!(deduped.len(), RESERVED_INTERNAL_PORTS.len());
    }

    #[test]
    fn mobile_server_port_resolves_from_release_bundle_identifier() {
        assert_eq!(
            mobile_server_port_for_bundle_identifier(STAGING_DESKTOP_BUNDLE_IDENTIFIER, false),
            Some(STAGING_MOBILE_SERVER_PORT)
        );
        assert_eq!(
            mobile_server_port_for_bundle_identifier(DESKTOP_BUNDLE_IDENTIFIER, false),
            Some(PRODUCTION_MOBILE_SERVER_PORT)
        );
        assert_eq!(
            mobile_server_port_for_bundle_identifier(STAGING_DESKTOP_BUNDLE_IDENTIFIER, true),
            None
        );
    }

    #[test]
    fn strip_ansi_for_display_removes_color_codes() {
        assert_eq!(strip_ansi_for_display("\u{1b}[31mused\u{1b}[0m"), "used");
    }

    #[test]
    fn strip_ansi_for_display_preserves_cursor_movement_readability() {
        assert_eq!(
            strip_ansi_for_display("used\u{1b}[3C42\u{1b}[2Bdone"),
            "used   42\n\ndone"
        );
    }

    #[test]
    fn strip_ansi_for_display_removes_osc_sequences_and_carriage_returns() {
        assert_eq!(
            strip_ansi_for_display("a\u{1b}]0;title\u{7}b\rc\u{1b}]1;ignored\u{1b}\\d"),
            "abcd"
        );
    }

    #[test]
    fn strip_ansi_for_display_preserves_utf8_and_drops_incomplete_escapes() {
        assert_eq!(strip_ansi_for_display("✓ café\u{1b}\u{1b}[31"), "✓ café");
    }
}
