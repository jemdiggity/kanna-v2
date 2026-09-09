//! Permission to open the desktop database is separate from path resolution.
//!
//! Call immediately before SQLite opens a file, and before relocation modifies
//! either source or destination. Merely naming a path is never authorization.
use std::path::{Path, PathBuf};

pub const DESKTOP_ACCESS_ENV: &str = "KANNA_DESKTOP_DB_ACCESS";
pub const ISOLATED_ENV: &str = "KANNA_DB_ISOLATED";

/// Validate an actual database access. Test binaries must pass `true` even
/// though this library itself is compiled without `cfg(test)` for consumers.
pub fn check(path: &Path, test_binary: bool) -> Result<(), String> {
    let protected = production_database_paths()?;
    let isolated = test_binary
        || std::env::var_os(ISOLATED_ENV).is_some()
        || (cfg!(target_os = "macos") && std::env::var_os("XDG_DATA_HOME").is_some())
        || std::env::var_os("KANNA_TASK_ID").is_some()
        || std::env::var_os("KANNA_WORKTREE").is_some()
        || std::env::var_os("KANNA_E2E_TEST_SQL").is_some()
        || std::env::var_os("TAURI_WEBDRIVER_PORT").is_some()
        || [std::env::current_dir(), std::env::current_exe()]
            .into_iter()
            .filter_map(Result::ok)
            .any(|path| crate::worktree_root_for_path(&path).is_some());
    let desktop = std::env::var(DESKTOP_ACCESS_ENV).as_deref() == Ok("desktop");
    check_against(path, &protected, desktop, isolated)
}

/// Locations protected for this OS account, independent of environment
/// overrides. Returning these paths does not authorize opening them.
pub fn production_database_paths() -> Result<Vec<PathBuf>, String> {
    let home = account_home()?;
    // Protect the account's standard production locations independently of
    // environment overrides. Temporary HOME/XDG fixture roots remain ordinary
    // custom databases; they never hide these locations.
    let roots = [
        home.join("Library/Application Support"),
        home.join(".local/share"),
    ];
    Ok(roots
        .iter()
        .flat_map(|root| {
            ["build.kanna", "com.kanna.app"]
                .map(|bundle| root.join(bundle).join(crate::DEFAULT_DB_NAME))
        })
        .collect())
}

fn check_against(
    path: &Path,
    protected: &[PathBuf],
    desktop: bool,
    isolated: bool,
) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.to_string_lossy().starts_with("file:") {
        return Err(
            "REFUSED: database access requires a filesystem path, not an empty path or SQLite URI"
                .into(),
        );
    }
    let resolved = resolve_existing_ancestor(path)?;
    for production in protected {
        let canonical_production = resolve_existing_ancestor(production)?;
        let same_path = resolved == canonical_production
            || (cfg!(target_os = "macos")
                && resolved
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&canonical_production.to_string_lossy()));
        if !same_path && !same_file(path, production) {
            continue;
        }
        if isolated {
            return Err(format!(
                "REFUSED: isolated/test/worktree process cannot access desktop production database {} (including legacy paths). Supply an isolated database path; XDG_DATA_HOME does not isolate macOS.",
                path.display()
            ));
        }
        if !desktop {
            return Err(format!(
                "REFUSED: opening desktop production database {} requires deliberate {DESKTOP_ACCESS_ENV}=desktop authorization. Supply an isolated database path for tests; XDG_DATA_HOME does not isolate macOS.",
                path.display()
            ));
        }
    }
    Ok(())
}

/// Resolve existing ancestors too: a fresh installation has no database yet,
/// and a symlink to its parent must not evade the fresh-file guard.
fn resolve_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    resolve_path(path, 0)
}

fn resolve_path(path: &Path, depth: usize) -> Result<PathBuf, String> {
    if depth > 128 {
        return Err("REFUSED: database path has too many ancestors or symbolic links".into());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    if std::fs::symlink_metadata(&absolute).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        let target = std::fs::read_link(&absolute).map_err(|e| e.to_string())?;
        let target = if target.is_absolute() {
            target
        } else {
            absolute
                .parent()
                .ok_or("symlink has no parent")?
                .join(target)
        };
        return resolve_path(&target, depth + 1);
    }
    match std::fs::canonicalize(&absolute) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = absolute.parent().ok_or_else(|| error.to_string())?;
            let name = absolute.file_name().ok_or_else(|| error.to_string())?;
            Ok(resolve_path(parent, depth + 1)?.join(name))
        }
        Err(error) => Err(format!(
            "cannot validate database path {}: {error}",
            path.display()
        )),
    }
}

#[cfg(unix)]
fn same_file(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(left), std::fs::metadata(right)) {
        (Ok(left), Ok(right)) => left.dev() == right.dev() && left.ino() == right.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(_left: &Path, _right: &Path) -> bool {
    false
}

/// HOME is caller-controlled isolation, not the identity of the account whose
/// database we protect. Query the account without changing process environment.
#[cfg(unix)]
fn account_home() -> Result<PathBuf, String> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // SAFETY: all output pointers refer to writable storage valid for this
        // call. pw_dir is copied before that backing buffer is dropped.
        let code = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if code == libc::ERANGE && buffer.len() < 1024 * 1024 {
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        if code != 0 || result.is_null() {
            return Err("REFUSED: cannot determine account home for database protection".into());
        }
        // SAFETY: successful getpwuid_r initialized entry.
        let directory = unsafe { (*result).pw_dir };
        if directory.is_null() {
            return Err("REFUSED: account has no home directory".into());
        }
        // SAFETY: a non-null pw_dir is a NUL-terminated string in buffer.
        let directory = unsafe { CStr::from_ptr(directory) };
        let home = PathBuf::from(std::ffi::OsStr::from_bytes(directory.to_bytes()));
        if !home.is_absolute() {
            return Err("REFUSED: account home is not absolute".into());
        }
        return Ok(home);
    }
}

#[cfg(not(unix))]
fn account_home() -> Result<PathBuf, String> {
    Err("REFUSED: database protection is not implemented for this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "kanna-db-access-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let production = root.join("build.kanna/kanna-v2.db");
        (root, production)
    }

    #[test]
    fn fresh_install_requires_deliberate_access_and_isolation_always_wins() {
        let (root, production) = fixture();
        let protected = vec![production.clone()];
        assert!(check_against(&production, &protected, false, false)
            .unwrap_err()
            .contains(DESKTOP_ACCESS_ENV));
        assert!(check_against(&production, &protected, true, false).is_ok());
        for desktop in [false, true] {
            assert!(check_against(&production, &protected, desktop, true)
                .unwrap_err()
                .contains("isolated/test/worktree"));
        }
        assert!(
            !production.parent().unwrap().exists(),
            "checking must not create directories"
        );
        assert!(check_against(&root.join("test.db"), &protected, false, true).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_database_is_untouched_on_refusal() {
        let (root, production) = fixture();
        std::fs::create_dir_all(production.parent().unwrap()).unwrap();
        std::fs::write(&production, b"owner data").unwrap();
        assert!(
            check_against(&production, std::slice::from_ref(&production), false, false).is_err()
        );
        assert_eq!(std::fs::read(&production).unwrap(), b"owner data");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_hardlinks_and_parent_aliases_cannot_bypass_the_guard() {
        use std::os::unix::fs::symlink;
        let (root, production) = fixture();
        std::fs::create_dir_all(production.parent().unwrap()).unwrap();
        let directory_alias = root.join("alias");
        symlink(production.parent().unwrap(), &directory_alias).unwrap();
        let protected = vec![production.clone()];
        assert!(check_against(
            &directory_alias.join("kanna-v2.db"),
            &protected,
            false,
            false
        )
        .is_err());
        let missing_alias = root.join("missing.db");
        symlink(&production, &missing_alias).unwrap();
        assert!(check_against(&missing_alias, &protected, false, false).is_err());
        std::fs::write(&production, b"owner data").unwrap();
        for (name, hardlink) in [("symlink.db", false), ("hardlink.db", true)] {
            let alias = root.join(name);
            if hardlink {
                std::fs::hard_link(&production, &alias).unwrap();
            } else {
                symlink(&production, &alias).unwrap();
            }
            assert!(check_against(&alias, &protected, false, false).is_err());
            assert!(check_against(&alias, &protected, true, true).is_err());
        }
        assert!(check_against(
            &production
                .parent()
                .unwrap()
                .join("../build.kanna/kanna-v2.db"),
            &protected,
            false,
            false
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_uris_and_empty_paths_are_refused() {
        for path in ["", "file:kanna-v2.db?mode=rwc"] {
            assert!(check_against(Path::new(path), &[], true, false).is_err());
        }
    }
}
