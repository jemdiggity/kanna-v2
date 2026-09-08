//! The shell Kanna runs repository commands and PTY tasks through.
//!
//! Three product surfaces need one: the setup/teardown supervisor
//! (`workspace_commands`), login-shell PATH discovery
//! (`task_creator::environment`), and the PTY bootstrap a task's agent CLI
//! runs inside (`task_creator`). They must agree, and until Linux support
//! they all simply said `/bin/zsh`.
//!
//! macOS keeps saying exactly that: `/bin/zsh` ships with the system, is the
//! default login shell, and every existing expectation -- including the argv
//! vectors asserted in tests -- is preserved byte for byte.
//!
//! Linux cannot. Phase 0 measured a stock Ubuntu image with **no `zsh` at
//! all**, and found that installing one is not the fix either: a freshly
//! installed `zsh` with no `~/.zshrc` runs `zsh-newuser-install`, an
//! interactive first-run wizard that clears the screen and waits for a
//! keypress -- which is what the PTY bootstrap then sees instead of its setup
//! output. The policy therefore has to name a shell that is *present and
//! non-interactive out of the box*:
//!
//! 1. `$SHELL`, when it is an absolute, executable `bash` or `zsh`. A user who
//!    chose one of those has startup files, and PATH discovery exists
//!    precisely to read them.
//! 2. `/bin/bash`, which every mainstream distribution ships and which needs
//!    no first-run configuration.
//! 3. `/bin/sh` as a last resort. On Debian derivatives that is `dash`, which
//!    accepts `-l -i -c` and is enough to run a command, though its rc
//!    semantics are thinner than the two above.
//!
//! "Login" is spelled differently by these shells and the difference is not
//! cosmetic: `dash` rejects `--login` outright (`Illegal option --`) and wants
//! `-l`. That is why the argument vectors live here beside the path instead of
//! being written out at each call site.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// How a shell spells its own options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    /// `zsh` and `bash`: both take `--login`.
    LongLogin,
    /// POSIX `sh` (`dash` on Debian derivatives): `-l`, no `--login`.
    ShortLogin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoginShell {
    path: PathBuf,
    family: Family,
}

impl LoginShell {
    /// Absolute path to the shell binary.
    pub(crate) fn path(&self) -> &str {
        // Every candidate is an absolute path made of valid UTF-8 by
        // construction; `$SHELL` is only accepted after `to_str` succeeds.
        self.path.to_str().unwrap_or("/bin/sh")
    }

    fn login_flag(&self) -> &'static str {
        match self.family {
            Family::LongLogin => "--login",
            Family::ShortLogin => "-l",
        }
    }

    /// Run `command` in a login shell, non-interactively: repository setup and
    /// teardown, which must source profiles but has no terminal.
    pub(crate) fn login_args(&self, command: &str) -> Vec<String> {
        vec![
            self.login_flag().to_string(),
            "-c".to_string(),
            command.to_string(),
        ]
    }

    /// Run `command` in a login *and interactive* shell: PATH discovery and
    /// the PTY bootstrap, both of which need the rc files an interactive
    /// shell sources, not just the profile.
    pub(crate) fn login_interactive_args(&self, command: &str) -> Vec<String> {
        vec![
            self.login_flag().to_string(),
            "-i".to_string(),
            "-c".to_string(),
            command.to_string(),
        ]
    }
}

/// The process-wide resolved shell.
pub(crate) fn login_shell() -> &'static LoginShell {
    static RESOLVED: std::sync::OnceLock<LoginShell> = std::sync::OnceLock::new();
    RESOLVED.get_or_init(|| {
        resolve_login_shell(std::env::var_os("SHELL").as_deref(), is_executable_file)
    })
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Resolve the policy above. `preferred` is `$SHELL`; `executable` answers
/// whether a candidate exists and can be run, so this stays pure and testable.
fn resolve_login_shell(preferred: Option<&OsStr>, executable: impl Fn(&Path) -> bool) -> LoginShell {
    #[cfg(target_os = "macos")]
    {
        // Unconditional on macOS: /bin/zsh is the system shell, and every
        // existing argv expectation is written against it.
        let _ = (preferred, executable);
        return LoginShell {
            path: PathBuf::from("/bin/zsh"),
            family: Family::LongLogin,
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(path) = preferred
            .and_then(OsStr::to_str)
            .map(Path::new)
            .filter(|path| path.is_absolute())
            .filter(|path| {
                matches!(
                    path.file_name().and_then(OsStr::to_str),
                    Some("bash") | Some("zsh")
                )
            })
            .filter(|path| executable(path))
        {
            return LoginShell {
                path: path.to_path_buf(),
                family: Family::LongLogin,
            };
        }

        let bash = Path::new("/bin/bash");
        if executable(bash) {
            return LoginShell {
                path: bash.to_path_buf(),
                family: Family::LongLogin,
            };
        }

        LoginShell {
            path: PathBuf::from("/bin/sh"),
            family: Family::ShortLogin,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nothing_executable(_: &Path) -> bool {
        false
    }

    fn everything_executable(_: &Path) -> bool {
        true
    }

    /// macOS behaviour is frozen: the same shell and the same argv the three
    /// call sites have always used, whatever `$SHELL` says.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_always_resolves_to_the_system_zsh() {
        for preferred in [None, Some(OsStr::new("/opt/homebrew/bin/fish"))] {
            let shell = resolve_login_shell(preferred, everything_executable);
            assert_eq!(shell.path(), "/bin/zsh");
            assert_eq!(shell.login_args("run"), ["--login", "-c", "run"]);
            assert_eq!(
                shell.login_interactive_args("run"),
                ["--login", "-i", "-c", "run"]
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    mod elsewhere {
        use super::*;

        #[test]
        fn an_absolute_executable_bash_or_zsh_from_the_environment_wins() {
            for candidate in ["/usr/bin/zsh", "/usr/local/bin/bash"] {
                let shell = resolve_login_shell(Some(OsStr::new(candidate)), everything_executable);
                assert_eq!(shell.path(), candidate);
                assert_eq!(shell.login_args("run"), ["--login", "-c", "run"]);
            }
        }

        /// A shell whose rc semantics Kanna's PATH discovery is not written
        /// for, a relative value, and one that is not there at all all fall
        /// through to the policy default rather than being run.
        #[test]
        fn an_unusable_shell_variable_is_ignored() {
            for preferred in [
                Some(OsStr::new("/usr/bin/fish")),
                Some(OsStr::new("bash")),
                None,
            ] {
                assert_eq!(
                    resolve_login_shell(preferred, everything_executable).path(),
                    "/bin/bash"
                );
            }
            assert_eq!(
                resolve_login_shell(Some(OsStr::new("/usr/bin/zsh")), nothing_executable).path(),
                "/bin/sh",
                "a $SHELL that is not executable must not be spawned"
            );
        }

        /// `dash` rejects `--login`, so the last-resort shell must be invoked
        /// with the short flag or every workspace command fails to start.
        #[test]
        fn the_posix_fallback_uses_the_short_login_flag() {
            let shell = resolve_login_shell(None, nothing_executable);
            assert_eq!(shell.path(), "/bin/sh");
            assert_eq!(shell.login_args("run"), ["-l", "-c", "run"]);
            assert_eq!(shell.login_interactive_args("run"), ["-l", "-i", "-c", "run"]);
        }

        /// The resolved shell must actually be runnable on this machine --
        /// the point of the policy is that a clean image has one.
        #[test]
        fn the_resolved_shell_exists_on_this_machine() {
            let shell = login_shell();
            assert!(
                is_executable_file(Path::new(shell.path())),
                "resolved shell {} is not executable",
                shell.path()
            );
        }
    }
}
