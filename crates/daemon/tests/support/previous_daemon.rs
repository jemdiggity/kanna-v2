use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const PREVIOUS_TAG: &str = "v0.1.0-staging.1";

/// Whether the release archived at [`PREVIOUS_TAG`] can run on this platform
/// at all.
///
/// It cannot on Linux: that release's `proc_info` has no Linux backend, so the
/// fixture binary aborts in `SuccessorAuthorizer::capture()` before a handoff
/// can even be attempted -- there is no previous *Linux* release to hand off
/// from yet. Cross-version handoff is therefore exercised on macOS only, and
/// the skip notice says so rather than the suite quietly reporting green.
///
/// Revisit this with every [`PREVIOUS_TAG`] bump: the first tag cut after
/// Linux support ships makes it `true` everywhere.
const PREVIOUS_RELEASE_RUNS_HERE: bool = cfg!(target_os = "macos");

/// Test-only: makes the fixture behave as if no ghostty checkout could be
/// resolved, so `fixture_isolation` can observe what the skip notice does to a
/// real libtest run.
///
/// It short-circuits the whole of [`binary`] rather than just
/// [`ghostty_source_dir`], because a cached fixture binary returns before the
/// resolver is ever consulted — hooking the resolver alone would make the
/// observing test pass or fail on whether `.build/daemon-cross-version`
/// happened to be warm.
const FORCE_MISSING_ENV: &str = "KANNA_PREVIOUS_DAEMON_FORCE_MISSING";

/// The previous-release daemon binary, or `None` when it cannot be produced
/// without network access.
///
/// The fixture itself is hermetic: the archived source comes from this
/// repository's own object database and the ghostty checkout it compiles
/// against is the one the current build already materialized. `None` means the
/// caller must skip — see [`binary_or_skip`], which is what the tests use.
pub fn binary() -> Option<PathBuf> {
    if std::env::var_os(FORCE_MISSING_ENV).is_some() {
        return None;
    }
    if let Some(path) = std::env::var_os("KANNA_PREVIOUS_DAEMON_BIN") {
        return Some(PathBuf::from(path));
    }
    if !PREVIOUS_RELEASE_RUNS_HERE {
        return None;
    }

    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates directory")
        .parent()
        .expect("repository root")
        .to_path_buf();
    let commit = command_stdout(
        Command::new("git")
            .current_dir(&repo)
            .args(["rev-parse", PREVIOUS_TAG]),
    );
    let root = repo.join(".build/daemon-cross-version").join(format!(
        "{}-{}-{}",
        commit.trim(),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let binary = root.join("target/debug/kanna-daemon");
    if binary.is_file() {
        return Some(binary);
    }

    let _lock = BuildLock::acquire(&root, &binary);
    if !binary.is_file() {
        materialize_archive(&repo, &root);
        let source = root.join("source");
        let ghostty = ghostty_source_dir(&source)?;
        let status = isolated_cargo_build(&source, &root)
            .env("GHOSTTY_SOURCE_DIR", &ghostty)
            .args([
                "build",
                "--locked",
                "-p",
                "kanna-daemon",
                "--bin",
                "kanna-daemon",
            ])
            .status()
            .expect("build previous daemon");
        assert!(status.success(), "previous daemon fixture build failed");
    }
    Some(binary)
}

/// [`binary`], announcing the skip on the way out so a lane that quietly loses
/// its cross-version coverage says so in the log.
///
/// The notice goes to fd 2 through [`std::io::Stderr`] rather than through
/// `eprintln!`. libtest's capture is installed by `set_output_capture`, which
/// only diverts the `print!`/`eprintln!` macro path, and it keeps a passing
/// test's captured output out of the report entirely — a skip announced with
/// `eprintln!` is visible only under `--nocapture`, which no lane passes. These
/// tests are the only cover for the cross-version handoff invariants in
/// `crates/daemon/SPEC.md`, so their absence has to be legible in the ordinary
/// run. `crates/daemon/tests/fixture_isolation.rs` holds that to be true.
pub fn binary_or_skip(test: &str) -> Option<PathBuf> {
    let binary = binary();
    if binary.is_none() {
        let notice = if PREVIOUS_RELEASE_RUNS_HERE {
            format!(
                "SKIP {test}: no local ghostty checkout for the previous-daemon fixture. \
                 The cross-version handoff invariants in crates/daemon/SPEC.md were NOT \
                 exercised. Build this workspace first (`cargo build -p kanna-daemon`), or \
                 point GHOSTTY_SOURCE_DIR at a ghostty checkout, or set \
                 KANNA_PREVIOUS_DAEMON_BIN to a prebuilt {PREVIOUS_TAG} daemon.\n"
            )
        } else {
            format!(
                "SKIP {test}: the previous release {PREVIOUS_TAG} predates Linux support \
                 and cannot start on {}, so the cross-version handoff invariants in \
                 crates/daemon/SPEC.md were NOT exercised here. They are covered on macOS \
                 until a Linux-capable release tag becomes the previous release.\n",
                std::env::consts::OS
            )
        };
        let mut stderr = std::io::stderr();
        let _ = stderr.write_all(notice.as_bytes());
        let _ = stderr.flush();
    }
    binary
}

/// The ghostty checkout the fixture's nested Cargo build compiles against.
///
/// `libghostty-vt-sys`'s build script clones ghostty from GitHub whenever
/// `GHOSTTY_SOURCE_DIR` is unset, into its own `OUT_DIR`. The fixture compiles
/// the archived release in a *private* Cargo tree, so an unset variable makes
/// the test run clone ghostty a second time — a network fetch inside the test
/// lane, which is how a GitHub timeout failed `--test handoff` with nothing
/// wrong in the daemon. The running test binary was itself linked against a
/// checkout of the same pinned commit, so the fixture reuses that one and the
/// nested build touches the network for nothing.
fn ghostty_source_dir(archive: &Path) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("GHOSTTY_SOURCE_DIR") {
        let dir = PathBuf::from(dir);
        if dir.join("build.zig").is_file() {
            return Some(dir);
        }
    }

    let pinned = pinned_ghostty_commit(archive);
    let exe = std::env::current_exe().expect("locate the running test binary");
    exe.ancestors()
        .map(|ancestor| ancestor.join("build"))
        .filter(|dir| dir.is_dir())
        .find_map(|dir| checkout_in(&dir, pinned.as_deref()))
}

/// The `ghostty-src` checkout under one Cargo `build` directory, if the commit
/// it was cloned at is the one the archived release pins.
///
/// A checkout with no stamp came from an already-resolved `GHOSTTY_SOURCE_DIR`
/// rather than from the build script's own clone, so there is nothing to
/// compare and the caller's own pin is what vouches for it.
fn checkout_in(build_dir: &Path, pinned: Option<&str>) -> Option<PathBuf> {
    let entries = std::fs::read_dir(build_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("libghostty-vt-sys-") {
            continue;
        }
        let source = entry.path().join("out/ghostty-src");
        if !source.join("build.zig").is_file() {
            continue;
        }
        let stamp = std::fs::read_to_string(source.join(".ghostty-commit")).ok();
        match (stamp.as_deref().map(str::trim), pinned) {
            (Some(stamp), Some(pinned)) if stamp != pinned => continue,
            _ => return Some(source),
        }
    }
    None
}

/// The ghostty commit the archived release's vendored `libghostty-vt-sys`
/// pins, read out of its build script's `GHOSTTY_COMMIT` constant.
fn pinned_ghostty_commit(archive: &Path) -> Option<String> {
    let build_script = archive.join("vendor/libghostty-rs/crates/libghostty-vt-sys/build.rs");
    let source = std::fs::read_to_string(build_script).ok()?;
    let line = source
        .lines()
        .find(|line| line.starts_with("const GHOSTTY_COMMIT"))?;
    let start = line.find('"')? + 1;
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

/// Every environment spelling Cargo consults for its output directories, in
/// precedence order over a checkout's `.cargo/config.toml`.
pub const CARGO_DIRECTORY_ENV: [&str; 3] = [
    "CARGO_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
];

/// A `cargo` invocation that compiles `source` strictly into `root`.
///
/// Cargo reads these variables *before* the checkout's `.cargo/config.toml`, and
/// `kd` exports `CARGO_BUILD_BUILD_DIR` for every worktree. Inheriting them here
/// would compile the archived previous-release source into the *active*
/// worktree's build directory: that archive's `kanna-runtime-defaults` predates
/// the commit adding `session_id`, so it writes a `kanna_runtime_defaults` rlib
/// without that module into a tree the current sources also build into, and a
/// later current-source compile links the stale artifact and fails with
/// `E0432: no session_id in the root`. Two source revisions must never share one
/// Cargo fingerprint tree, so the inherited spellings are removed before the
/// fixture's own private directories are applied.
pub fn isolated_cargo_build(source: &Path, root: &Path) -> Command {
    let mut command = Command::new("cargo");
    command.current_dir(source);
    for key in CARGO_DIRECTORY_ENV {
        command.env_remove(key);
    }
    command
        .env("CARGO_TARGET_DIR", root.join("target"))
        .env("CARGO_BUILD_BUILD_DIR", root.join("cargo-build"));
    command
}

fn command_stdout(command: &mut Command) -> String {
    let output = command.output().expect("run fixture command");
    assert!(
        output.status.success(),
        "fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("fixture command output is UTF-8")
}

fn materialize_archive(repo: &Path, root: &Path) {
    let source = root.join("source");
    if source.is_dir() {
        return;
    }
    std::fs::create_dir_all(root).expect("create fixture cache root");
    let staging = root.join(format!("source.staging-{}", std::process::id()));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).expect("remove stale owned staging");
    }
    std::fs::create_dir_all(&staging).expect("create fixture staging");

    let mut archive = Command::new("git")
        .current_dir(repo)
        .args(["archive", PREVIOUS_TAG])
        .stdout(Stdio::piped())
        .spawn()
        .expect("start git archive");
    let archive_stdout = archive.stdout.take().expect("git archive stdout");
    let extract = Command::new("tar")
        .args(["-x", "-C"])
        .arg(&staging)
        .stdin(Stdio::from(archive_stdout))
        .status()
        .expect("extract previous source");
    let archived = archive.wait().expect("wait for git archive");
    assert!(archived.success(), "git archive failed");
    assert!(extract.success(), "tar extraction failed");
    std::fs::rename(staging, source).expect("publish previous source atomically");
}

struct BuildLock {
    path: Option<PathBuf>,
}

impl BuildLock {
    fn acquire(root: &Path, binary: &Path) -> Self {
        std::fs::create_dir_all(root).expect("create fixture cache root");
        let path = root.join("build.lock");
        loop {
            if binary.is_file() {
                return Self { path: None };
            }
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => {
                    return Self { path: Some(path) };
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|metadata| metadata.modified())
                        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
                        .is_ok_and(|age| age > Duration::from_secs(15 * 60));
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    } else {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
                Err(error) => panic!("acquire previous-daemon build lock: {error}"),
            }
        }
    }
}

impl Drop for BuildLock {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}
