//! Agent-status detection: the rules the daemon classifies terminal sessions
//! with, and where they come from.
//!
//! The daemon remains the classification authority and the verdict vocabulary
//! is unchanged — `busy`, `waiting`, `idle`, each a positive match on
//! something the provider drew. What lives here is the answer to two questions
//! the old design answered badly:
//!
//! - **Where do the patterns live?** In [`rules.json`], bundled into the
//!   binary and overridable from a machine-local file that hot-reloads. A
//!   provider that reshuffles its footer used to cost a daemon release.
//! - **Which patterns apply?** The ones measured against the CLI version this
//!   session is actually running. One machine on the newest Claude and another
//!   several releases behind need different patterns, and a constant is a
//!   single slot.
//!
//! See `docs/specs/agent-status-detection-rules.md`.

// This module is compiled into both the `kanna_daemon` library and the daemon
// binary, which declare their own module trees over the same files. Parts of
// the surface have exactly one of those two callers — the daemon binary probes
// CLI versions and reloads rules, while the library serves `kanna-server`'s
// replay and the composer helpers — so per-crate dead-code analysis flags the
// half it cannot see. Same reason as `proc_info`.
#![allow(dead_code)]

pub mod classify;
pub mod probe;
pub mod progress;
pub mod rules;
pub mod schema;
pub mod version;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

#[allow(unused_imports)]
pub use classify::{Classifier, ComposerState, Evidence, Verdict};
#[allow(unused_imports)]
pub use progress::ProgressScanner;
pub use rules::CompiledRules;
pub use version::CliVersion;

/// The measured defaults, compiled into the daemon.
const BUNDLED_RULES: &str = include_str!("rules.json");

/// Where a machine-local override is read from, unless
/// `KANNA_DAEMON_DETECTION_RULES` names another path.
pub const OVERRIDE_FILE: &str = "detection-rules.json";

/// Bumped whenever the active rules change, so live sessions re-resolve
/// without polling a lock.
static GENERATION: AtomicU64 = AtomicU64::new(1);

static ACTIVE: OnceLock<RwLock<Arc<CompiledRules>>> = OnceLock::new();

fn active() -> &'static RwLock<Arc<CompiledRules>> {
    ACTIVE.get_or_init(|| RwLock::new(Arc::new(bundled())))
}

/// The bundled rule set. Panics if it is invalid: shipping a daemon whose own
/// rules do not parse is a build defect, and a test pins it.
pub fn bundled() -> CompiledRules {
    CompiledRules::parse(BUNDLED_RULES, "the bundled detection rules")
        .unwrap_or_else(|error| panic!("bundled detection rules are invalid: {error}"))
}

pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// The active rules and the generation they were published under.
pub fn current_rules() -> (Arc<CompiledRules>, u64) {
    // Read the generation first: a concurrent swap then makes the cached view
    // look stale and is re-resolved, rather than looking fresh and being kept.
    let generation = generation();
    let rules = active()
        .read()
        .map(|guard| Arc::clone(&guard))
        .unwrap_or_else(|poisoned| Arc::clone(&poisoned.into_inner()));
    (rules, generation)
}

fn publish(rules: CompiledRules) {
    match active().write() {
        Ok(mut guard) => *guard = Arc::new(rules),
        Err(poisoned) => *poisoned.into_inner() = Arc::new(rules),
    }
    GENERATION.fetch_add(1, Ordering::AcqRel);
}

/// Install a rule set directly. For tests and for the reload path.
pub fn install(rules: CompiledRules) {
    publish(rules);
}

pub fn override_path() -> PathBuf {
    if let Some(path) = std::env::var_os("KANNA_DAEMON_DETECTION_RULES") {
        return PathBuf::from(path);
    }
    kanna_runtime_defaults::daemon_dir_for_current_runtime().join(OVERRIDE_FILE)
}

/// What a load attempt produced, so the caller can log it once instead of on
/// every poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadOutcome {
    /// No override file; the bundled rules are active.
    BundledOnly,
    /// The override merged cleanly. Carries the path for the log line.
    Merged(PathBuf),
    /// The override could not be read, parsed or validated. The rules already
    /// in force are kept: a broken override must not cost a machine its
    /// classification.
    Refused { path: PathBuf, error: String },
}

/// Load the bundled rules, merge any override over them, and publish.
pub fn load() -> LoadOutcome {
    let bundled = bundled();
    let path = override_path();
    if !path.exists() {
        publish(bundled);
        return LoadOutcome::BundledOnly;
    }
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) => {
            return LoadOutcome::Refused {
                path,
                error: format!("could not be read: {error}"),
            }
        }
    };
    match CompiledRules::parse(&contents, &path.display().to_string()) {
        Ok(overlay) => {
            publish(bundled.merge_over(&overlay));
            LoadOutcome::Merged(path)
        }
        Err(error) => LoadOutcome::Refused { path, error },
    }
}

/// Load once at daemon startup and log what took effect.
pub fn init() {
    report(load());
}

fn report(outcome: LoadOutcome) {
    match outcome {
        LoadOutcome::BundledOnly => log::info!(
            "[detection] using bundled agent-status rules; no override at {}",
            override_path().display()
        ),
        LoadOutcome::Merged(path) => log::info!(
            "[detection] merged agent-status rule override {}",
            path.display()
        ),
        LoadOutcome::Refused { path, error } => log::warn!(
            "[detection] keeping the rules already in force: the override {} {error}",
            path.display()
        ),
    }
}

/// Watch the override file and reload it into the running daemon.
///
/// Polled rather than event-driven for the same reason the MCP catalog watcher
/// is: one `stat` a second costs nothing, and a file-watch API that misses an
/// atomic replace would cost a pattern fix its whole point.
pub fn spawn_watcher() -> std::thread::JoinHandle<()> {
    std::thread::spawn(|| {
        let path = override_path();
        let mut state = watch_state(&path);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let next = watch_state(&path);
            if next == state {
                continue;
            }
            state = next;
            report(load());
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WatchState {
    exists: bool,
    modified: Option<std::time::SystemTime>,
    len: u64,
}

fn watch_state(path: &std::path::Path) -> WatchState {
    match std::fs::metadata(path) {
        Ok(metadata) => WatchState {
            exists: true,
            modified: metadata.modified().ok(),
            len: metadata.len(),
        },
        Err(_) => WatchState {
            exists: false,
            modified: None,
            len: 0,
        },
    }
}

/// Every composer prompt glyph any provider draws.
///
/// Public because the composer has to be recognisable outside the daemon too:
/// the task-logs tail is a rendered frame flattened to text, and an agent
/// reading it cannot be left to guess which line is the prompt. One rule, one
/// place, so the tail and the snippet agree on what the composer is.
pub fn global_composer_prompts() -> Vec<char> {
    current_rules().0.global_composer_prompts()
}
