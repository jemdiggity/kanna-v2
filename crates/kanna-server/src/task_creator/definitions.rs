use super::definition_source::RepoDefinitionSnapshot;
use crate::db::Repo;
use kanna_agent_protocol::AgentProvider;
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::str::FromStr;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct RepoConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pipeline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) setup: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) teardown: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) test: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ports: Option<HashMap<String, u16>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) flavors: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) vars: Option<HashMap<String, String>>,
    #[serde(
        rename = "agentProviders",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_agent_provider_preferences"
    )]
    pub(super) agent_providers: Option<BTreeMap<String, AgentProviderPreference>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) reserved_ports: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) reserved_port_offsets: Vec<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) stage_order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace: Option<RepoWorkspaceConfig>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct AgentProviderPreference {
    #[serde(rename = "provider")]
    pub(super) providers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model: Option<String>,
}

impl<'de> Deserialize<'de> for AgentProviderPreference {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        parse_agent_provider_preference(&value)
            .ok_or_else(|| serde::de::Error::custom("invalid agent provider preference"))
    }
}

impl RepoConfig {
    /// Resolve a repo-level provider/model preference for an agent selector.
    ///
    /// Exact names win. Otherwise, the glob with the most non-wildcard
    /// characters wins; equally specific globs use lexical order so JSON map
    /// ordering never affects resolution.
    pub(super) fn agent_provider_preference(
        &self,
        agent_selector: Option<&str>,
    ) -> Option<&AgentProviderPreference> {
        let selector = agent_selector?.trim();
        if selector.is_empty() {
            return None;
        }
        let preferences = self.agent_providers.as_ref()?;
        if let Some(preference) = preferences.get(selector) {
            return Some(preference);
        }

        preferences
            .iter()
            .filter(|(pattern, _)| pattern.contains('*') && wildcard_matches(pattern, selector))
            .min_by(|(left, _), (right, _)| compare_agent_provider_globs(left, right))
            .map(|(_, preference)| preference)
    }
}

fn compare_agent_provider_globs(left: &str, right: &str) -> Ordering {
    let specificity = |pattern: &str| pattern.bytes().filter(|byte| *byte != b'*').count();
    specificity(right)
        .cmp(&specificity(left))
        .then_with(|| left.cmp(right))
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut pattern_index, mut value_index) = (0, 0);
    let mut wildcard_index = None;
    let mut wildcard_value_index = 0;

    while value_index < value.len() {
        if pattern_index < pattern.len() && pattern[pattern_index] == value[value_index] {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            wildcard_index = Some(pattern_index);
            pattern_index += 1;
            wildcard_value_index = value_index;
        } else if let Some(wildcard) = wildcard_index {
            pattern_index = wildcard + 1;
            wildcard_value_index += 1;
            value_index = wildcard_value_index;
        } else {
            return false;
        }
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct RepoWorkspaceConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) path: Option<RepoWorkspacePathConfig>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct RepoWorkspacePathConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prepend: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) append: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PipelineDefinition {
    #[allow(dead_code)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    pub(super) stages: Vec<PipelineStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) environments: Option<HashMap<String, PipelineEnvironment>>,
    /// Cap on agent-requested revision rounds per task before the task parks
    /// for its human instead of looping. Omitted means
    /// `DEFAULT_REVISION_LIMIT`; `0` means unlimited. Pinned `pipeline_def`
    /// snapshots written before this field existed omit it and therefore
    /// inherit the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) revision_limit: Option<i64>,
}

/// Rounds of agent-requested revision a task gets before the engine stops
/// forking new work and parks the task for its human. A review agent that
/// keeps finding new work each round is the mechanism by which a scoped task
/// turns into an open-ended project, so the loop is bounded by default.
pub(crate) const DEFAULT_REVISION_LIMIT: i64 = 3;

impl PipelineDefinition {
    /// Effective revision-round cap: `0` means unlimited. Negative values are
    /// rejected when the definition is parsed, so there is nothing to clamp
    /// here — silently clamping would turn a typo into an unbounded loop,
    /// which is the failure this cap exists to prevent.
    pub(super) fn revision_limit(&self) -> i64 {
        self.revision_limit.unwrap_or(DEFAULT_REVISION_LIMIT)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PipelineStage {
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) agent_provider: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) environment: Option<String>,
    pub(super) policy: PipelineStagePolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) post: Option<PipelinePost>,
}

/// Tail work of a stage, injected into the stage's running agent session when
/// the stage transitions forward. `agent` is the fallback used to spawn a
/// fresh session (and the prompt-body source) when the task's session is
/// dead; a live session keeps whatever agent is already running.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PipelinePost {
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) agent_provider: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PipelineStagePolicy {
    pub(super) transition: PipelineStageTransition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) revision_transition: Option<PipelineStageTransition>,
}

impl PipelineStagePolicy {
    pub(super) fn revision_transition(&self) -> PipelineStageTransition {
        self.revision_transition.unwrap_or(self.transition)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum PipelineStageTransition {
    Manual,
    Auto,
}

impl PipelineStageTransition {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Auto => "auto",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PipelineEnvironment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) setup: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) teardown: Option<Vec<String>>,
}

/// Where a stored stage name sits in a pipeline. In-flight tasks created
/// before posts replaced interleaved continue stages can be parked *at* a
/// folded post name (e.g. `commit`); those resolve to the owning stage's
/// post rather than erroring.
pub(super) enum StagePosition {
    Stage(usize),
    Post { owner: usize },
}

pub(super) fn resolve_stage_position(
    pipeline: &PipelineDefinition,
    stage_name: &str,
) -> Option<StagePosition> {
    if let Some(index) = pipeline
        .stages
        .iter()
        .position(|stage| stage.name == stage_name)
    {
        return Some(StagePosition::Stage(index));
    }
    pipeline
        .stages
        .iter()
        .position(|stage| {
            stage
                .post
                .as_ref()
                .is_some_and(|post| post.name == stage_name)
        })
        .map(|owner| StagePosition::Post { owner })
}

/// A stage's post viewed as a stage: the shape `prepare_stage_run_spawn` and
/// prompt building consume for dead-session fallbacks and legacy in-flight
/// tasks parked at a folded post name. Post success always advances, so the
/// synthetic policy is `auto`.
pub(super) fn post_as_stage(owner: &PipelineStage) -> Option<PipelineStage> {
    owner.post.as_ref().map(|post| PipelineStage {
        name: post.name.clone(),
        description: post.description.clone(),
        agent: post.agent.clone(),
        prompt: post.prompt.clone(),
        agent_provider: post.agent_provider.clone(),
        environment: owner.environment.clone(),
        policy: PipelineStagePolicy {
            transition: PipelineStageTransition::Auto,
            revision_transition: None,
        },
        post: None,
    })
}

#[derive(Deserialize)]
struct RawPipelineDefinition {
    name: Option<String>,
    description: Option<String>,
    stages: Vec<RawPipelineStage>,
    environments: Option<HashMap<String, PipelineEnvironment>>,
    revision_limit: Option<i64>,
}

#[derive(Deserialize)]
struct RawPipelineStage {
    name: String,
    description: Option<String>,
    agent: Option<String>,
    prompt: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_provider_list")]
    agent_provider: Option<Vec<String>>,
    environment: Option<String>,
    policy: Option<RawPipelineStagePolicy>,
    transition: Option<PipelineStageTransition>,
    mode: Option<RawPipelineStageExecution>,
    post: Option<RawPipelinePost>,
    post_action: Option<RawPipelinePostAction>,
}

#[derive(Deserialize)]
struct RawPipelineStagePolicy {
    transition: PipelineStageTransition,
    revision_transition: Option<PipelineStageTransition>,
    execution: Option<RawPipelineStageExecution>,
}

#[derive(Deserialize)]
struct RawPipelinePost {
    name: String,
    description: Option<String>,
    agent: Option<String>,
    prompt: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_provider_list")]
    agent_provider: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct RawPipelinePostAction {
    name: String,
    description: Option<String>,
    agent: Option<String>,
    prompt: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_provider_list")]
    agent_provider: Option<Vec<String>>,
    #[allow(dead_code)]
    transition: Option<PipelineStageTransition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawPipelineStageExecution {
    NewTask,
    Continue,
}

#[derive(Default, Deserialize)]
struct AgentFrontmatter {
    name: Option<String>,
    description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_yaml_value")]
    agent_provider: Option<YamlValue>,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct AgentDefinition {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) prompt: String,
    #[serde(rename = "agent_provider", skip_serializing_if = "Vec::is_empty")]
    pub(super) agent_providers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) allowed_tools: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum AgentDefinitionSource {
    BuiltIn,
    RepoOverride,
    RepoAuthored,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedAgentDefinition {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) default_provider: Option<String>,
    pub(super) default_model: Option<String>,
    pub(super) source: AgentDefinitionSource,
}

struct AgentExtension {
    prompt: String,
    description: Option<String>,
    agent_providers: Option<Vec<String>>,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
}

pub(super) struct RepoDefinitions {
    snapshot: RepoDefinitionSnapshot,
    config: RepoConfig,
}

impl RepoDefinitions {
    pub(super) fn resolve(repo: &Repo) -> Result<Self, String> {
        Self::resolve_path(&repo.path, repo.default_branch.as_deref())
    }

    fn resolve_path(repo_path: &str, default_branch: Option<&str>) -> Result<Self, String> {
        let snapshot = RepoDefinitionSnapshot::resolve(repo_path, default_branch)?;
        let config_path = ".kanna/config.json";
        let config = match read_snapshot_utf8(&snapshot, config_path)? {
            Some(content) => parse_repo_config(&content)
                .map_err(|error| definition_error(&snapshot, config_path, error))?,
            None => RepoConfig::default(),
        };
        Ok(Self { snapshot, config })
    }

    pub(super) fn revision(&self) -> Option<&str> {
        self.snapshot.revision()
    }

    pub(super) fn ref_name(&self) -> &str {
        self.snapshot.ref_name()
    }

    pub(super) fn config(&self) -> &RepoConfig {
        &self.config
    }

    pub(super) fn pipeline(&self, name: &str) -> Result<PipelineDefinition, String> {
        self.pipeline_optional(name)?
            .ok_or_else(|| format!("compiled resource not found: .kanna/pipelines/{name}.json"))
    }

    pub(super) fn pipeline_optional(
        &self,
        name: &str,
    ) -> Result<Option<PipelineDefinition>, String> {
        let path = format!(".kanna/pipelines/{name}.json");
        match read_snapshot_utf8(&self.snapshot, &path)? {
            Some(content) => parse_pipeline_definition(&content)
                .map(Some)
                .map_err(|error| definition_error(&self.snapshot, &path, error)),
            None => compiled_builtin_resource(&path)
                .map(parse_pipeline_definition)
                .transpose()
                .map_err(|error| format!("invalid compiled resource `{path}`: {error}")),
        }
    }

    pub(super) fn task_pipeline(
        &self,
        name: &str,
        stored: Option<&str>,
    ) -> Result<PipelineDefinition, String> {
        if let Some(stored) = stored.filter(|value| !value.trim().is_empty()) {
            return parse_stored_pipeline_definition(stored);
        }
        self.pipeline(name)
    }

    pub(super) fn agent(&self, selector: &str) -> Result<AgentDefinition, String> {
        self.agent_optional(selector)?.ok_or_else(|| {
            let (role, _) = split_agent_selector(selector);
            format!("compiled resource not found: .kanna/agents/{role}/AGENT.md")
        })
    }

    pub(super) fn agent_optional(&self, selector: &str) -> Result<Option<AgentDefinition>, String> {
        let selector = AgentSelector::resolve(selector, self.config.flavors.as_ref());
        let agent_path = format!(".kanna/agents/{}/AGENT.md", selector.repo_agent_dir());
        let mut definition = match read_snapshot_utf8(&self.snapshot, &agent_path)? {
            Some(content) => parse_agent_definition(&content)
                .map_err(|error| definition_error(&self.snapshot, &agent_path, error))?,
            None => {
                let Some(content) = optional_builtin_agent_resource(&selector) else {
                    return Ok(None);
                };
                parse_agent_definition(&content).map_err(|error| {
                    format!(
                        "invalid compiled agent resource for selector `{}`: {error}",
                        selector.display()
                    )
                })?
            }
        };

        let extension_path = format!(".kanna/agents/{}/EXTEND.md", selector.repo_agent_dir());
        if let Some(extension) = read_snapshot_utf8(&self.snapshot, &extension_path)? {
            apply_agent_extension(&mut definition, &extension)
                .map_err(|error| definition_error(&self.snapshot, &extension_path, error))?;
        }
        Ok(Some(definition))
    }

    pub(super) fn pipeline_names(&self) -> Result<Vec<String>, String> {
        let path = ".kanna/pipelines";
        let entries = self
            .snapshot
            .list_direct_entries(path)
            .map_err(|error| definition_error(&self.snapshot, path, error))?;
        let mut names = BTreeSet::from([
            "no-review".to_string(),
            "single-reviewer".to_string(),
            "specialized-reviewers".to_string(),
            "specialty-review".to_string(),
        ]);
        for entry in entries {
            let Some(name) = entry.strip_suffix(".json") else {
                continue;
            };
            if !name.is_empty() && name != "schema" {
                names.insert(name.to_string());
            }
        }
        Ok(names.into_iter().collect())
    }

    /// Every named agent selector that can be passed to task creation, after
    /// applying the same repo override, configured-flavor, and EXTEND.md
    /// resolution as `agent()`.
    pub(super) fn agents(&self) -> Result<Vec<ResolvedAgentDefinition>, String> {
        let mut names = builtin_agent_names();
        let entries = self
            .snapshot
            .list_direct_entries(".kanna/agents")
            .map_err(|error| definition_error(&self.snapshot, ".kanna/agents", error))?;

        for name in entries {
            let agent_path = format!(".kanna/agents/{name}/AGENT.md");
            if read_snapshot_utf8(&self.snapshot, &agent_path)?.is_some() {
                names.insert(name);
            }
        }

        names
            .into_iter()
            .map(|name| {
                let repo_agent_path = format!(".kanna/agents/{name}/AGENT.md");
                let repo_has_agent =
                    read_snapshot_utf8(&self.snapshot, &repo_agent_path)?.is_some();
                let repo_extension_path = format!(".kanna/agents/{name}/EXTEND.md");
                let repo_has_extension =
                    read_snapshot_utf8(&self.snapshot, &repo_extension_path)?.is_some();
                let builtin = is_builtin_agent_name(&name);
                let source = match (repo_has_agent, repo_has_extension, builtin) {
                    (true, _, true) | (false, true, true) => AgentDefinitionSource::RepoOverride,
                    (false, false, true) => AgentDefinitionSource::BuiltIn,
                    (true, _, false) => AgentDefinitionSource::RepoAuthored,
                    (false, _, false) => {
                        return Err(format!(
                            "agent `{name}` disappeared while resolving repository definitions"
                        ));
                    }
                };
                let definition = self.agent(&name)?;
                Ok(ResolvedAgentDefinition {
                    name,
                    description: definition.description,
                    default_provider: definition.agent_providers.into_iter().next(),
                    default_model: definition.model,
                    source,
                })
            })
            .collect()
    }
}

fn parse_repo_config(content: &str) -> Result<RepoConfig, String> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|error| format!("invalid repo config: {error}"))?;
    let Some(raw) = value.as_object() else {
        return Ok(RepoConfig::default());
    };

    let string_array = |name: &str| {
        raw.get(name).and_then(|value| {
            let values = value.as_array()?;
            values
                .iter()
                .map(|value| value.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
        })
    };

    let string_map = |value: Option<&serde_json::Value>| {
        let values = value?.as_object()?;
        let normalized = values
            .iter()
            .filter_map(|(name, value)| {
                value
                    .as_str()
                    .map(|value| (name.clone(), value.to_string()))
            })
            .collect::<HashMap<_, _>>();
        (!normalized.is_empty()).then_some(normalized)
    };

    let ports = raw.get("ports").and_then(|value| {
        let values = value.as_object()?;
        let normalized = values
            .iter()
            .filter_map(|(name, value)| {
                let port = value.as_u64().and_then(|value| u16::try_from(value).ok())?;
                Some((name.clone(), port))
            })
            .collect::<HashMap<_, _>>();
        (!normalized.is_empty()).then_some(normalized)
    });

    let agent_providers = raw
        .get("agentProviders")
        .and_then(serde_json::Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(pattern, value)| {
                    (!pattern.trim().is_empty())
                        .then(|| parse_agent_provider_preference(value))
                        .flatten()
                        .map(|preference| (pattern.clone(), preference))
                })
                .collect::<BTreeMap<_, _>>()
        })
        .filter(|values| !values.is_empty());

    let integer_array = |name: &str, valid: fn(i64) -> bool| {
        raw.get(name)
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_i64)
                    .filter(|value| valid(*value))
                    .collect::<Vec<_>>()
            })
            .filter(|values| !values.is_empty())
            .unwrap_or_default()
    };

    let workspace = raw
        .get("workspace")
        .and_then(serde_json::Value::as_object)
        .and_then(|workspace_raw| {
            let env = string_map(workspace_raw.get("env"));
            let path = workspace_raw
                .get("path")
                .and_then(serde_json::Value::as_object)
                .and_then(|path_raw| {
                    let filtered_entries = |name: &str| {
                        let entries = path_raw.get(name)?.as_array()?;
                        let entries = entries
                            .iter()
                            .filter_map(|entry| entry.as_str().map(str::to_string))
                            .collect::<Vec<_>>();
                        (!entries.is_empty()).then_some(entries)
                    };
                    let prepend = filtered_entries("prepend");
                    let append = filtered_entries("append");
                    (prepend.is_some() || append.is_some())
                        .then_some(RepoWorkspacePathConfig { prepend, append })
                });
            (env.is_some() || path.is_some()).then_some(RepoWorkspaceConfig { env, path })
        });

    Ok(RepoConfig {
        pipeline: raw
            .get("pipeline")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        setup: string_array("setup"),
        teardown: string_array("teardown"),
        test: string_array("test"),
        ports,
        flavors: string_map(raw.get("flavors")),
        vars: string_map(raw.get("vars")),
        agent_providers,
        reserved_port_offsets: integer_array("reserved_port_offsets", |value| value >= 0),
        reserved_ports: integer_array("reserved_ports", |value| (1..=65535).contains(&value)),
        stage_order: string_array("stage_order"),
        workspace,
    })
}

fn deserialize_optional_agent_provider_preferences<'de, D>(
    deserializer: D,
) -> Result<Option<BTreeMap<String, AgentProviderPreference>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    let Some(raw) = value.and_then(|value| value.as_object().cloned()) else {
        return Ok(None);
    };
    let preferences = raw
        .iter()
        .filter_map(|(pattern, value)| {
            (!pattern.trim().is_empty())
                .then(|| parse_agent_provider_preference(value))
                .flatten()
                .map(|preference| (pattern.clone(), preference))
        })
        .collect::<BTreeMap<_, _>>();
    Ok((!preferences.is_empty()).then_some(preferences))
}

fn parse_agent_provider_preference(value: &serde_json::Value) -> Option<AgentProviderPreference> {
    let (provider, model) = match value {
        serde_json::Value::String(_) => (value, None),
        serde_json::Value::Object(raw) => (
            raw.get("provider")?,
            raw.get("model")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        ),
        _ => return None,
    };
    let providers = match provider {
        serde_json::Value::String(provider) => provider
            .split(',')
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>(),
        serde_json::Value::Array(providers) => providers
            .iter()
            .map(serde_json::Value::as_str)
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>(),
        _ => return None,
    };
    (!providers.is_empty()).then_some(AgentProviderPreference { providers, model })
}

fn read_snapshot_utf8(
    snapshot: &RepoDefinitionSnapshot,
    relative_path: &str,
) -> Result<Option<String>, String> {
    snapshot
        .read_optional_utf8(relative_path)
        .map_err(|error| definition_error(snapshot, relative_path, error))
}

fn definition_error(
    snapshot: &RepoDefinitionSnapshot,
    relative_path: &str,
    error: impl std::fmt::Display,
) -> String {
    format!(
        "repository definition `{relative_path}` from `{}` at revision `{}`: {error}",
        snapshot.ref_name(),
        snapshot.revision().unwrap_or("<none>"),
    )
}

fn parse_pipeline_definition(content: &str) -> Result<PipelineDefinition, String> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| format!("invalid pipeline definition: {error}"))?;
    reject_explicit_null_pipeline_providers(&value)?;
    let raw: RawPipelineDefinition = serde_json::from_value(value)
        .map_err(|error| format!("invalid pipeline definition: {error}"))?;
    normalize_pipeline_definition(raw)
        .map_err(|error| format!("invalid pipeline definition: {error}"))
}

fn reject_explicit_null_pipeline_providers(value: &serde_json::Value) -> Result<(), String> {
    let Some(stages) = value.get("stages").and_then(serde_json::Value::as_array) else {
        return Ok(());
    };
    for (index, stage) in stages.iter().enumerate() {
        if stage
            .get("agent_provider")
            .is_some_and(serde_json::Value::is_null)
        {
            return Err(format!(
                "invalid pipeline definition: stages[{index}].agent_provider must be a string or a non-empty array of strings"
            ));
        }
        for post_key in ["post", "post_action"] {
            if stage
                .get(post_key)
                .and_then(serde_json::Value::as_object)
                .and_then(|post| post.get("agent_provider"))
                .is_some_and(serde_json::Value::is_null)
            {
                return Err(format!(
                    "invalid pipeline definition: stages[{index}].{post_key}.agent_provider must be a string or a non-empty array of strings"
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn parse_stored_pipeline_definition(
    content: &str,
) -> Result<PipelineDefinition, String> {
    let mut value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| format!("invalid stored pipeline definition: {error}"))?;
    normalize_legacy_pipeline_provider_csv(&mut value);
    let raw: RawPipelineDefinition = serde_json::from_value(value)
        .map_err(|error| format!("invalid stored pipeline definition: {error}"))?;
    normalize_pipeline_definition(raw)
        .map_err(|error| format!("invalid stored pipeline definition: {error}"))
}

fn normalize_legacy_pipeline_provider_csv(value: &mut serde_json::Value) {
    let Some(stages) = value
        .get_mut("stages")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };

    for stage in stages {
        if let Some(provider) = stage.get_mut("agent_provider") {
            normalize_legacy_provider_csv(provider);
        }
        for post_key in ["post", "post_action"] {
            if let Some(provider) = stage
                .get_mut(post_key)
                .and_then(|post| post.get_mut("agent_provider"))
            {
                normalize_legacy_provider_csv(provider);
            }
        }
    }
}

fn normalize_legacy_provider_csv(value: &mut serde_json::Value) {
    let serde_json::Value::String(provider) = value else {
        return;
    };
    if !provider.contains(',') {
        return;
    }

    *value = serde_json::Value::Array(
        provider
            .split(',')
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
            .map(|provider| serde_json::Value::String(provider.to_string()))
            .collect(),
    );
}

struct AgentSelector {
    role: String,
    explicit_flavor: Option<String>,
    configured_flavor: Option<String>,
}

impl AgentSelector {
    fn resolve(agent_name: &str, flavors: Option<&HashMap<String, String>>) -> Self {
        let (role, explicit_flavor) = split_agent_selector(agent_name);
        let configured_flavor = explicit_flavor
            .is_none()
            .then(|| flavors.and_then(|map| map.get(&role).cloned()))
            .flatten();
        Self {
            role,
            explicit_flavor,
            configured_flavor,
        }
    }

    fn selected_flavor(&self) -> Option<&str> {
        self.explicit_flavor
            .as_deref()
            .or(self.configured_flavor.as_deref())
    }

    fn repo_agent_dir(&self) -> String {
        self.role.clone()
    }

    fn display(&self) -> String {
        match self.selected_flavor() {
            Some(flavor) => format!("{}@{flavor}", self.role),
            None => self.role.clone(),
        }
    }
}

fn split_agent_selector(agent_name: &str) -> (String, Option<String>) {
    let Some((role, flavor)) = agent_name.split_once('@') else {
        return (agent_name.to_string(), None);
    };
    if role.is_empty() || flavor.is_empty() || flavor.contains('@') {
        return (agent_name.to_string(), None);
    }
    (role.to_string(), Some(flavor.to_string()))
}

fn optional_builtin_agent_resource(selector: &AgentSelector) -> Option<String> {
    if let Some(flavor) = selector.selected_flavor() {
        let flavor_path = format!(
            ".kanna/agents/{}/flavors/{}/AGENT.md",
            selector.role, flavor
        );
        if let Some(content) = compiled_builtin_resource(&flavor_path) {
            return Some(content.to_string());
        }
    }

    compiled_builtin_resource(&format!(".kanna/agents/{}/AGENT.md", selector.role))
        .map(str::to_string)
}

const BUILTIN_AGENT_RESOURCES: &[(&str, &str)] = &[
    (
        ".kanna/agents/agent-factory/AGENT.md",
        include_str!("../../../../.kanna/agents/agent-factory/AGENT.md"),
    ),
    (
        ".kanna/agents/approve/AGENT.md",
        include_str!("../../../../.kanna/agents/approve/AGENT.md"),
    ),
    (
        ".kanna/agents/commit/AGENT.md",
        include_str!("../../../../.kanna/agents/commit/AGENT.md"),
    ),
    (
        ".kanna/agents/config-factory/AGENT.md",
        include_str!("../../../../.kanna/agents/config-factory/AGENT.md"),
    ),
    (
        ".kanna/agents/implement/AGENT.md",
        include_str!("../../../../.kanna/agents/implement/AGENT.md"),
    ),
    (
        ".kanna/agents/merge/AGENT.md",
        include_str!("../../../../.kanna/agents/merge/AGENT.md"),
    ),
    (
        ".kanna/agents/merge/flavors/git/AGENT.md",
        include_str!("../../../../.kanna/agents/merge/flavors/git/AGENT.md"),
    ),
    (
        ".kanna/agents/merge/flavors/github/AGENT.md",
        include_str!("../../../../.kanna/agents/merge/flavors/github/AGENT.md"),
    ),
    (
        ".kanna/agents/pipeline-factory/AGENT.md",
        include_str!("../../../../.kanna/agents/pipeline-factory/AGENT.md"),
    ),
    (
        ".kanna/agents/pr/AGENT.md",
        include_str!("../../../../.kanna/agents/pr/AGENT.md"),
    ),
    (
        ".kanna/agents/pr/flavors/draft-pr/AGENT.md",
        include_str!("../../../../.kanna/agents/pr/flavors/draft-pr/AGENT.md"),
    ),
    (
        ".kanna/agents/pr/flavors/push-only/AGENT.md",
        include_str!("../../../../.kanna/agents/pr/flavors/push-only/AGENT.md"),
    ),
    (
        ".kanna/agents/qa-dispatcher/AGENT.md",
        include_str!("../../../../.kanna/agents/qa-dispatcher/AGENT.md"),
    ),
    (
        ".kanna/agents/review/AGENT.md",
        include_str!("../../../../.kanna/agents/review/AGENT.md"),
    ),
    (
        ".kanna/agents/review-compat/AGENT.md",
        include_str!("../../../../.kanna/agents/review-compat/AGENT.md"),
    ),
    (
        ".kanna/agents/review-concurrency/AGENT.md",
        include_str!("../../../../.kanna/agents/review-concurrency/AGENT.md"),
    ),
    (
        ".kanna/agents/review-migration/AGENT.md",
        include_str!("../../../../.kanna/agents/review-migration/AGENT.md"),
    ),
    (
        ".kanna/agents/review-perf/AGENT.md",
        include_str!("../../../../.kanna/agents/review-perf/AGENT.md"),
    ),
    (
        ".kanna/agents/review-security/AGENT.md",
        include_str!("../../../../.kanna/agents/review-security/AGENT.md"),
    ),
    (
        ".kanna/agents/review-ui/AGENT.md",
        include_str!("../../../../.kanna/agents/review-ui/AGENT.md"),
    ),
    (
        ".kanna/agents/setup/AGENT.md",
        include_str!("../../../../.kanna/agents/setup/AGENT.md"),
    ),
];

fn builtin_agent_names() -> BTreeSet<String> {
    BUILTIN_AGENT_RESOURCES
        .iter()
        .filter_map(|(path, _)| {
            path.strip_prefix(".kanna/agents/")?
                .strip_suffix("/AGENT.md")
                .filter(|name| !name.contains('/'))
                .map(str::to_string)
        })
        .collect()
}

fn is_builtin_agent_name(name: &str) -> bool {
    let path = format!(".kanna/agents/{name}/AGENT.md");
    BUILTIN_AGENT_RESOURCES
        .iter()
        .any(|(resource_path, _)| *resource_path == path)
}

/// Built-in pipelines that shipped under an earlier name, mapped to the
/// definition each now resolves to. Single source of truth: the compiled
/// resource fallback below and manifest canonicalization in
/// `load_repo_kanna_definitions` both read this table, so a retired name never
/// has its mapping written twice.
///
/// These are resolution aliases only. They stay out of `pipeline_names()`, so
/// a retired name never returns as a user-facing choice, and they always lose
/// to a repo that ships its own pipeline under the same name.
pub(super) const LEGACY_BUILTIN_PIPELINES: &[(&str, &str)] = &[
    ("default", "no-review"),
    ("qa", "single-reviewer"),
    ("qa-dispatch", "specialized-reviewers"),
];

/// The current name a possibly-retired built-in pipeline resolves to, or
/// `name` unchanged when it was never retired.
pub(super) fn canonical_builtin_pipeline_name(name: &str) -> &str {
    LEGACY_BUILTIN_PIPELINES
        .iter()
        .find_map(|(legacy, current)| (*legacy == name).then_some(*current))
        .unwrap_or(name)
}

fn compiled_builtin_resource(relative_path: &str) -> Option<&'static str> {
    // A retired built-in pipeline name serves its current definition.
    if let Some(name) = relative_path
        .strip_prefix(".kanna/pipelines/")
        .and_then(|file| file.strip_suffix(".json"))
    {
        let canonical = canonical_builtin_pipeline_name(name);
        if canonical != name {
            return compiled_builtin_resource(&format!(".kanna/pipelines/{canonical}.json"));
        }
    }

    let pipeline = match relative_path {
        ".kanna/pipelines/no-review.json" => {
            Some(include_str!("../../../../.kanna/pipelines/no-review.json"))
        }
        ".kanna/pipelines/single-reviewer.json" => Some(include_str!(
            "../../../../.kanna/pipelines/single-reviewer.json"
        )),
        ".kanna/pipelines/specialized-reviewers.json" => Some(include_str!(
            "../../../../.kanna/pipelines/specialized-reviewers.json"
        )),
        ".kanna/pipelines/specialty-review.json" => Some(include_str!(
            "../../../../.kanna/pipelines/specialty-review.json"
        )),
        _ => None,
    };
    pipeline.or_else(|| {
        BUILTIN_AGENT_RESOURCES
            .iter()
            .find_map(|(path, content)| (*path == relative_path).then_some(*content))
    })
}

/// Merge an `EXTEND.md` document into a resolved agent definition: the body
/// is appended to the base prompt and frontmatter fields replace the base's
/// when present. Frontmatter is optional; a plain markdown file is a pure
/// prompt extension.
fn apply_agent_extension(definition: &mut AgentDefinition, content: &str) -> Result<(), String> {
    let extension = parse_agent_extension(content)?;

    if let Some(description) = extension.description {
        definition.description = description;
    }
    if !extension.prompt.is_empty() {
        if definition.prompt.is_empty() {
            definition.prompt = extension.prompt;
        } else {
            definition.prompt = format!("{}\n\n{}", definition.prompt, extension.prompt);
        }
    }
    if let Some(agent_providers) = extension.agent_providers {
        definition.agent_providers = agent_providers;
    }
    if extension.model.is_some() {
        definition.model = extension.model;
    }
    if extension.permission_mode.is_some() {
        definition.permission_mode = extension.permission_mode;
    }
    if let Some(allowed_tools) = extension.allowed_tools {
        definition.allowed_tools = allowed_tools;
    }

    validate_agent_definition(definition)
        .map_err(|error| format!("invalid extended agent: {error}"))
}

fn parse_agent_definition(content: &str) -> Result<AgentDefinition, String> {
    let (frontmatter, body) = split_frontmatter(content);
    let fm: AgentFrontmatter = match frontmatter {
        Some(raw) => {
            serde_yaml::from_str(raw).map_err(|e| format!("invalid AGENT.md frontmatter: {}", e))?
        }
        None => AgentFrontmatter::default(),
    };

    let definition = AgentDefinition {
        name: fm.name.unwrap_or_default(),
        description: fm.description.unwrap_or_default(),
        prompt: body.trim().to_string(),
        agent_providers: parse_agent_providers(fm.agent_provider)?,
        model: fm.model,
        permission_mode: validate_permission_mode(fm.permission_mode)?,
        allowed_tools: fm.allowed_tools.unwrap_or_default(),
    };
    validate_agent_definition(&definition).map_err(|error| format!("invalid AGENT.md: {error}"))?;
    Ok(definition)
}

fn parse_agent_extension(content: &str) -> Result<AgentExtension, String> {
    let (frontmatter, body) = split_frontmatter(content);
    let fm: AgentFrontmatter = match frontmatter {
        Some(raw) => {
            serde_yaml::from_str(raw).map_err(|e| format!("invalid AGENT.md frontmatter: {}", e))?
        }
        None => AgentFrontmatter::default(),
    };

    let agent_providers = fm
        .agent_provider
        .map(|value| parse_agent_providers(Some(value)))
        .transpose()?;

    Ok(AgentExtension {
        prompt: body.trim().to_string(),
        description: fm.description,
        agent_providers,
        model: fm.model,
        permission_mode: validate_permission_mode(fm.permission_mode)?,
        allowed_tools: fm.allowed_tools,
    })
}

fn validate_permission_mode(permission_mode: Option<String>) -> Result<Option<String>, String> {
    let Some(permission_mode) = permission_mode else {
        return Ok(None);
    };
    if matches!(
        permission_mode.as_str(),
        "default" | "acceptEdits" | "dontAsk"
    ) {
        Ok(Some(permission_mode))
    } else {
        Err(format!(
            "permission_mode must be one of: default, acceptEdits, dontAsk (got \"{permission_mode}\")"
        ))
    }
}

fn validate_agent_definition(definition: &AgentDefinition) -> Result<(), String> {
    if definition.name.trim().is_empty() {
        return Err("name is required and must be a non-empty string".to_string());
    }
    if definition.description.trim().is_empty() {
        return Err("description is required and must be a non-empty string".to_string());
    }
    Ok(())
}

fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let normalized = content.trim_start_matches('\u{feff}');
    let Some(rest) = normalized.strip_prefix("---") else {
        return (None, normalized);
    };
    let Some(rest) = rest
        .strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))
    else {
        return (None, normalized);
    };
    if let Some(index) = rest.find("\n---\n") {
        let frontmatter = &rest[..index];
        let body = &rest[index + 5..];
        return (Some(frontmatter), body);
    }
    if let Some(index) = rest.find("\r\n---\r\n") {
        let frontmatter = &rest[..index];
        let body = &rest[index + 7..];
        return (Some(frontmatter), body);
    }
    (None, normalized)
}

fn parse_agent_providers(value: Option<YamlValue>) -> Result<Vec<String>, String> {
    let providers: Vec<String> = match value {
        None => return Ok(Vec::new()),
        Some(YamlValue::Sequence(values)) => {
            if !values.iter().all(|value| value.as_str().is_some()) {
                return Err("agent_provider must be a string or an array of strings".to_string());
            }
            values
                .into_iter()
                .filter_map(|value| value.as_str().map(str::trim).map(str::to_string))
                .filter(|value| !value.is_empty())
                .collect()
        }
        Some(YamlValue::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        Some(_) => {
            return Err("agent_provider must be a string or an array of strings".to_string());
        }
    };

    if providers.is_empty() {
        return Err("agent_provider must include at least one non-empty provider".to_string());
    }
    for provider in &providers {
        AgentProvider::from_str(provider)?;
    }
    Ok(providers)
}

fn normalize_pipeline_definition(raw: RawPipelineDefinition) -> Result<PipelineDefinition, String> {
    let mut stages: Vec<PipelineStage> = Vec::new();
    for stage in raw.stages {
        let RawPipelineStage {
            name,
            description,
            agent,
            prompt,
            agent_provider,
            environment,
            policy,
            transition,
            mode,
            post,
            post_action,
        } = stage;

        let (transition, revision_transition, continues) = match policy {
            Some(policy) => (
                policy.transition,
                policy.revision_transition,
                matches!(policy.execution, Some(RawPipelineStageExecution::Continue)),
            ),
            None => (
                transition.ok_or_else(|| format!("stage {name:?} is missing policy.transition"))?,
                None,
                matches!(mode, Some(RawPipelineStageExecution::Continue)),
            ),
        };

        // Legacy interleaved continue stage (old `post_action` compilation or
        // an `execution: "continue"` policy, including pinned pipeline_def
        // snapshots): fold into the preceding stage's post. Stages swap
        // sessions; posts continue them.
        if continues {
            if let Some(previous) = stages.last_mut() {
                if previous.post.is_none() {
                    previous.post = Some(PipelinePost {
                        name,
                        description,
                        agent,
                        prompt,
                        agent_provider,
                    });
                    continue;
                }
            }
        }

        let post = match (post, post_action) {
            (Some(post), _) => Some(PipelinePost {
                name: post.name,
                description: post.description,
                agent: post.agent,
                prompt: post.prompt,
                agent_provider: post.agent_provider,
            }),
            (None, Some(post_action)) => Some(PipelinePost {
                name: post_action.name,
                description: post_action.description,
                agent: post_action.agent,
                prompt: post_action.prompt,
                agent_provider: post_action.agent_provider,
            }),
            (None, None) => None,
        };

        stages.push(PipelineStage {
            name,
            description,
            agent,
            prompt,
            agent_provider,
            environment,
            policy: PipelineStagePolicy {
                transition,
                revision_transition,
            },
            post,
        });
    }

    // A negative cap is a definition error, not "unlimited": accepting it
    // would silently disable the very bound the field configures.
    if let Some(revision_limit) = raw.revision_limit {
        if revision_limit < 0 {
            return Err(format!(
                "revision_limit must be zero or greater, got {revision_limit} \
                 (0 disables the cap; omit the field for the default of \
                 {DEFAULT_REVISION_LIMIT})"
            ));
        }
    }

    Ok(PipelineDefinition {
        name: raw.name,
        description: raw.description,
        stages,
        environments: raw.environments,
        revision_limit: raw.revision_limit,
    })
}

fn deserialize_optional_provider_list<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let providers = match value {
        // Pipeline snapshots created before provider validation serialized an
        // unset optional field as null. Continue reading those durable task
        // snapshots while omitting the field from newly serialized snapshots.
        serde_json::Value::Null => return Ok(None),
        serde_json::Value::String(provider) => vec![provider.trim().to_string()],
        serde_json::Value::Array(values) => {
            if values.is_empty() || !values.iter().all(serde_json::Value::is_string) {
                return Err(serde::de::Error::custom(
                    "agent_provider must be a string or a non-empty array of strings",
                ));
            }
            values
                .into_iter()
                .filter_map(|value| value.as_str().map(str::trim).map(str::to_string))
                .collect()
        }
        _ => {
            return Err(serde::de::Error::custom(
                "agent_provider must be a string or a non-empty array of strings",
            ));
        }
    };

    if providers.is_empty() || providers.iter().any(|provider| provider.is_empty()) {
        return Err(serde::de::Error::custom(
            "agent_provider must include at least one non-empty provider",
        ));
    }
    for provider in &providers {
        AgentProvider::from_str(provider).map_err(|error| {
            serde::de::Error::custom(format!("invalid agent_provider: {error}"))
        })?;
    }
    Ok(Some(providers))
}

fn deserialize_optional_yaml_value<'de, D>(deserializer: D) -> Result<Option<YamlValue>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    YamlValue::deserialize(deserializer).map(Some)
}
