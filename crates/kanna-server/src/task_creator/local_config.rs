//! The machine-local `.kanna/config.local.json` override layer.
//!
//! Repo definitions are resolved from `origin/<default_branch>` (see
//! `definition_source`) so every machine runs a task the same way. That is the
//! right default for anything the repo agrees on, and the wrong one for
//! anything a single machine has to change *now*: when one provider CLI hits
//! its account limit, reordering `agentProviders` should not require a merge
//! to origin before the review lane can run again.
//!
//! This layer is that escape hatch. It is read from the open repo's working
//! tree — being uncommitted is the whole point — and merged over the resolved
//! `.kanna/config.json` with local winning. It is deliberately narrow: only
//! the keys in `OVERRIDABLE_KEYS` may be set, and anything else is a loud
//! error rather than a silently ignored line in an operator's file.

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::Path;

/// Where the local layer lives, relative to the repository root. Sibling of
/// the existing machine-local `.kanna/setup.local.sh` hook, and gitignored
/// next to it.
pub(super) const LOCAL_CONFIG_RELATIVE_PATH: &str = ".kanna/config.local.json";

/// How one key's local value combines with the committed one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalMerge {
    /// The local value replaces the committed one outright. Arrays replace;
    /// they never concatenate — a local `setup` is the whole setup list.
    Replace,
    /// Entries merge by name: a local entry replaces the committed entry of
    /// the same name, and committed entries the local file does not name
    /// survive. Exactly one level deep — a named entry is replaced whole,
    /// never merged field by field.
    Entries,
}

struct OverridableKey {
    name: &'static str,
    merge: LocalMerge,
    /// Rejects a value this key cannot mean, returning the `must be …` tail of
    /// the operator-facing message.
    validate: fn(&Value) -> Result<(), String>,
}

/// The keys a machine may override, and nothing else.
///
/// Everything here is *plumbing*: which CLI runs, which pipeline a new task
/// starts in, which ports and shell commands this machine's workspaces use.
/// Deliberately excluded, because they change what a task *means* rather than
/// how this machine runs it:
///
/// - `vars` and `flavors` feed stage prompts and agent selection. A task
///   created on a machine with a local value for either has a prompt no other
///   machine can reproduce, and nothing in the durable record says why — the
///   opposite of the drift diagnosis this layer is supposed to make easy.
///   That also breaks task transfer: the destination re-resolves definitions
///   from its own checkout, so a resumed or re-forked stage would silently
///   render a different prompt than the one the task ran with.
/// - `workspace` (env and PATH), `reserved_ports`, `reserved_port_offsets`,
///   and `stage_order` are committed on purpose so agents run in the same
///   environment everywhere; they have no incident-response story that
///   `setup` cannot already cover.
const OVERRIDABLE_KEYS: &[OverridableKey] = &[
    OverridableKey {
        name: "agentProviders",
        merge: LocalMerge::Entries,
        validate: validate_agent_providers,
    },
    OverridableKey {
        name: "pipeline",
        merge: LocalMerge::Replace,
        validate: validate_pipeline,
    },
    OverridableKey {
        name: "ports",
        merge: LocalMerge::Entries,
        validate: validate_ports,
    },
    OverridableKey {
        name: "setup",
        merge: LocalMerge::Replace,
        validate: validate_string_array,
    },
    OverridableKey {
        name: "teardown",
        merge: LocalMerge::Replace,
        validate: validate_string_array,
    },
    OverridableKey {
        name: "test",
        merge: LocalMerge::Replace,
        validate: validate_string_array,
    },
];

/// Provenance of an applied local layer, carried on the resolved
/// [`super::definitions::RepoConfig`] so a spawn can say out loud that this
/// machine is not running the committed configuration.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalConfigOverride {
    path: String,
    keys: Vec<String>,
}

impl LocalConfigOverride {
    /// Absolute path of the file in force. Several Kanna instances can share
    /// one repo checkout, so the checkout — not the instance — is what
    /// identifies whose configuration this is.
    pub(super) fn path(&self) -> &str {
        &self.path
    }

    /// Config keys the local file replaced or merged into, sorted.
    pub(super) fn keys(&self) -> &[String] {
        &self.keys
    }
}

/// Merge `<repo_path>/.kanna/config.local.json` over an already-resolved
/// committed config object, returning what it overrode. `Ok(None)` means no
/// local file applies; every malformed or out-of-scope file is an error naming
/// the file, never a silent fallback to the committed config. An error may
/// leave `config` partly merged — resolution fails with it, so no caller ever
/// sees that intermediate value.
pub(super) fn apply_local_config_override(
    repo_path: &Path,
    config: &mut Map<String, Value>,
) -> Result<Option<LocalConfigOverride>, String> {
    let path = repo_path.join(LOCAL_CONFIG_RELATIVE_PATH);
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(local_error(&path, format!("cannot be read: {error}"))),
    };

    let value: Value = serde_json::from_str(&content)
        .map_err(|error| local_error(&path, format!("is not valid JSON: {error}")))?;
    // The committed config tolerates a non-object top level because Kanna does
    // not control every repo it opens. This file is written by the operator on
    // this machine, and an override that quietly does nothing is exactly the
    // failure this layer exists to prevent.
    let Value::Object(local) = value else {
        return Err(local_error(&path, "must contain a JSON object"));
    };

    let mut keys = Vec::new();
    for (key, value) in &local {
        // Editors resolve `$schema` for completion; it configures nothing.
        if key == "$schema" {
            continue;
        }
        let Some(overridable) = OVERRIDABLE_KEYS.iter().find(|entry| entry.name == key) else {
            return Err(local_error(
                &path,
                format!(
                    "cannot override `{key}` per machine (this layer applies to: {})",
                    overridable_key_names()
                ),
            ));
        };
        (overridable.validate)(value)
            .map_err(|detail| local_error(&path, format!("`{key}` {detail}")))?;

        match overridable.merge {
            LocalMerge::Replace => {
                config.insert(key.clone(), value.clone());
            }
            LocalMerge::Entries => {
                let entry = config
                    .entry(key.clone())
                    .or_insert_with(|| Value::Object(Map::new()));
                // A committed value of the wrong shape is dropped by the
                // committed parser anyway; merging into it would keep nothing.
                if !entry.is_object() {
                    *entry = Value::Object(Map::new());
                }
                if let (Some(base), Some(overrides)) = (entry.as_object_mut(), value.as_object()) {
                    for (name, value) in overrides {
                        base.insert(name.clone(), value.clone());
                    }
                }
            }
        }
        keys.push(key.clone());
    }

    // A file that sets no key changes nothing, so nothing is reported as
    // overridden.
    if keys.is_empty() {
        return Ok(None);
    }
    keys.sort();
    Ok(Some(LocalConfigOverride {
        path: path.to_string_lossy().into_owned(),
        keys,
    }))
}

fn overridable_key_names() -> String {
    OVERRIDABLE_KEYS
        .iter()
        .map(|entry| entry.name)
        .collect::<Vec<_>>()
        .join(", ")
}

fn local_error(path: &Path, detail: impl std::fmt::Display) -> String {
    format!(
        "machine-local repo config `{}` {detail}",
        path.to_string_lossy()
    )
}

fn validate_pipeline(value: &Value) -> Result<(), String> {
    value
        .as_str()
        .filter(|name| !name.trim().is_empty())
        .map(|_| ())
        .ok_or_else(|| "must be a non-empty pipeline name".to_string())
}

fn validate_string_array(value: &Value) -> Result<(), String> {
    let values = value
        .as_array()
        .ok_or_else(|| "must be an array of shell commands".to_string())?;
    if values.iter().all(Value::is_string) {
        Ok(())
    } else {
        Err("must be an array of shell commands".to_string())
    }
}

fn validate_ports(value: &Value) -> Result<(), String> {
    let entries = value.as_object().ok_or_else(|| {
        "must be an object mapping environment variable names to ports".to_string()
    })?;
    for (name, port) in entries {
        let valid = port
            .as_u64()
            .is_some_and(|port| (1..=u64::from(u16::MAX)).contains(&port));
        if !valid {
            return Err(format!(
                "entry `{name}` must be a port number between 1 and {}",
                u16::MAX
            ));
        }
    }
    Ok(())
}

fn validate_agent_providers(value: &Value) -> Result<(), String> {
    let entries = value
        .as_object()
        .ok_or_else(|| "must be an object keyed by agent name or `*` glob".to_string())?;
    for (pattern, preference) in entries {
        if pattern.trim().is_empty() {
            return Err("must not name an empty agent selector".to_string());
        }
        if super::definitions::parse_agent_provider_preference(preference).is_none() {
            return Err(format!(
                "entry `{pattern}` must be a provider name, an array of provider names, \
                 or an object with a `provider` field"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_local_config_override, LOCAL_CONFIG_RELATIVE_PATH};
    use serde_json::{json, Map, Value};
    use std::path::Path;

    fn committed() -> Map<String, Value> {
        json!({
            "pipeline": "single-reviewer",
            "setup": ["pnpm install"],
            "test": ["pnpm test"],
            "ports": {"KANNA_DEV_PORT": 1420, "KANNA_MOBILE_PORT": 8081},
            "agentProviders": {
                "*": {"provider": ["codex", "claude"]},
                "review": {"provider": "codex", "model": "committed-model"}
            },
            "vars": {"OWNER": "kanna"}
        })
        .as_object()
        .cloned()
        .expect("committed fixture is an object")
    }

    fn write_local(repo: &Path, content: &str) {
        std::fs::create_dir_all(repo.join(".kanna")).expect("create fixture .kanna directory");
        std::fs::write(repo.join(LOCAL_CONFIG_RELATIVE_PATH), content).expect("write local config");
    }

    #[test]
    fn absent_local_file_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = committed();

        let applied = apply_local_config_override(temp.path(), &mut config).unwrap();

        assert!(applied.is_none());
        assert_eq!(config, committed());
    }

    #[test]
    fn a_file_that_sets_no_key_is_not_reported_as_an_override() {
        let temp = tempfile::tempdir().unwrap();
        write_local(
            temp.path(),
            &json!({"$schema": "https://schemas.kanna.build/config.schema.json"}).to_string(),
        );
        let mut config = committed();

        let applied = apply_local_config_override(temp.path(), &mut config).unwrap();

        assert!(applied.is_none());
        assert_eq!(config, committed());
    }

    #[test]
    fn agent_provider_entries_merge_by_name_and_local_replaces_the_named_entry() {
        let temp = tempfile::tempdir().unwrap();
        write_local(
            temp.path(),
            &json!({
                "agentProviders": {
                    "*": {"provider": ["claude", "codex"]},
                    "implement": "opencode"
                }
            })
            .to_string(),
        );
        let mut config = committed();

        let applied = apply_local_config_override(temp.path(), &mut config)
            .unwrap()
            .expect("local file overrides agentProviders");

        assert_eq!(applied.keys(), ["agentProviders"]);
        assert!(
            applied.path().ends_with("/.kanna/config.local.json"),
            "{}",
            applied.path()
        );
        assert_eq!(
            config["agentProviders"],
            json!({
                // Replaced whole: the committed provider order is gone, not merged.
                "*": {"provider": ["claude", "codex"]},
                // Added by the local file.
                "implement": "opencode",
                // Untouched by the local file, so the committed entry survives.
                "review": {"provider": "codex", "model": "committed-model"}
            })
        );
    }

    #[test]
    fn ports_merge_by_name_while_arrays_and_scalars_replace() {
        let temp = tempfile::tempdir().unwrap();
        write_local(
            temp.path(),
            &json!({
                "pipeline": "no-review",
                "setup": ["./local-setup.sh"],
                "ports": {"KANNA_DEV_PORT": 1500}
            })
            .to_string(),
        );
        let mut config = committed();

        let applied = apply_local_config_override(temp.path(), &mut config)
            .unwrap()
            .expect("local file overrides three keys");

        assert_eq!(applied.keys(), ["pipeline", "ports", "setup"]);
        assert_eq!(config["pipeline"], json!("no-review"));
        // Replaced, never concatenated onto the committed list.
        assert_eq!(config["setup"], json!(["./local-setup.sh"]));
        assert_eq!(
            config["ports"],
            json!({"KANNA_DEV_PORT": 1500, "KANNA_MOBILE_PORT": 8081})
        );
        // Keys the local file never named keep their committed values.
        assert_eq!(config["test"], json!(["pnpm test"]));
        assert_eq!(config["vars"], json!({"OWNER": "kanna"}));
    }

    #[test]
    fn an_entry_key_absent_from_the_committed_config_is_created() {
        let temp = tempfile::tempdir().unwrap();
        write_local(
            temp.path(),
            &json!({"agentProviders": {"review": "claude"}}).to_string(),
        );
        let mut config = Map::new();

        apply_local_config_override(temp.path(), &mut config)
            .unwrap()
            .expect("local file applies to an empty committed config");

        assert_eq!(config["agentProviders"], json!({"review": "claude"}));
    }

    #[test]
    fn malformed_json_is_a_loud_error_naming_the_file() {
        let temp = tempfile::tempdir().unwrap();
        write_local(temp.path(), "{\"pipeline\": ");
        let mut config = committed();

        let error = apply_local_config_override(temp.path(), &mut config).unwrap_err();

        assert!(error.contains(".kanna/config.local.json"), "{error}");
        assert!(error.contains("is not valid JSON"), "{error}");
        // A malformed file must not half-apply.
        assert_eq!(config, committed());
    }

    #[test]
    fn a_non_object_document_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        write_local(temp.path(), "[]");
        let mut config = committed();

        let error = apply_local_config_override(temp.path(), &mut config).unwrap_err();

        assert!(error.contains(".kanna/config.local.json"), "{error}");
        assert!(error.contains("must contain a JSON object"), "{error}");
    }

    #[test]
    fn a_key_outside_the_local_layer_is_rejected_by_name() {
        let temp = tempfile::tempdir().unwrap();
        write_local(
            temp.path(),
            &json!({"vars": {"OWNER": "someone-else"}}).to_string(),
        );
        let mut config = committed();

        let error = apply_local_config_override(temp.path(), &mut config).unwrap_err();

        assert!(error.contains(".kanna/config.local.json"), "{error}");
        assert!(
            error.contains("cannot override `vars` per machine"),
            "{error}"
        );
        assert!(
            error.contains("agentProviders, pipeline, ports, setup, teardown, test"),
            "{error}"
        );
        assert_eq!(config["vars"], json!({"OWNER": "kanna"}));
    }

    #[test]
    fn malformed_values_are_rejected_per_key() {
        let cases = [
            (
                json!({"pipeline": ""}),
                "`pipeline` must be a non-empty pipeline name",
            ),
            (
                json!({"setup": "pnpm install"}),
                "`setup` must be an array of shell commands",
            ),
            (
                json!({"teardown": ["ok", 7]}),
                "`teardown` must be an array of shell commands",
            ),
            (
                json!({"ports": {"KANNA_DEV_PORT": 0}}),
                "`ports` entry `KANNA_DEV_PORT` must be a port number between 1 and 65535",
            ),
            (
                json!({"ports": {"KANNA_DEV_PORT": 70000}}),
                "`ports` entry `KANNA_DEV_PORT` must be a port number between 1 and 65535",
            ),
            (
                json!({"agentProviders": ["claude"]}),
                "`agentProviders` must be an object keyed by agent name or `*` glob",
            ),
            (
                json!({"agentProviders": {"review": {"model": "no-provider"}}}),
                "`agentProviders` entry `review` must be a provider name",
            ),
            (
                json!({"agentProviders": {"   ": "claude"}}),
                "`agentProviders` must not name an empty agent selector",
            ),
        ];

        for (local, expected) in cases {
            let temp = tempfile::tempdir().unwrap();
            write_local(temp.path(), &local.to_string());
            let mut config = committed();

            let error = apply_local_config_override(temp.path(), &mut config).unwrap_err();

            assert!(error.contains(expected), "{local}: {error}");
            assert!(
                error.contains(".kanna/config.local.json"),
                "{local}: {error}"
            );
        }
    }

    #[test]
    fn an_unreadable_local_file_is_an_error_rather_than_a_silent_fallback() {
        let temp = tempfile::tempdir().unwrap();
        // A directory where the file belongs: readable metadata, unreadable
        // content, and never NotFound.
        std::fs::create_dir_all(temp.path().join(LOCAL_CONFIG_RELATIVE_PATH)).unwrap();
        let mut config = committed();

        let error = apply_local_config_override(temp.path(), &mut config).unwrap_err();

        assert!(error.contains(".kanna/config.local.json"), "{error}");
        assert!(error.contains("cannot be read"), "{error}");
    }
}
