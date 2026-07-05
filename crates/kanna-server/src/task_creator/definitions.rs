use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use std::collections::HashMap;
use std::path::Path;

#[derive(Default, Deserialize)]
pub(super) struct RepoConfig {
    pub(super) pipeline: Option<String>,
    pub(super) setup: Option<Vec<String>>,
    pub(super) teardown: Option<Vec<String>>,
    pub(super) ports: Option<HashMap<String, u16>>,
    pub(super) workspace: Option<RepoWorkspaceConfig>,
}

#[derive(Default, Deserialize)]
pub(super) struct RepoWorkspaceConfig {
    pub(super) path: Option<RepoWorkspacePathConfig>,
}

#[derive(Default, Deserialize)]
pub(super) struct RepoWorkspacePathConfig {
    pub(super) prepend: Option<Vec<String>>,
    pub(super) append: Option<Vec<String>>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PipelineDefinition {
    #[allow(dead_code)]
    pub(super) name: Option<String>,
    pub(super) stages: Vec<PipelineStage>,
    pub(super) environments: Option<HashMap<String, PipelineEnvironment>>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PipelineStage {
    pub(super) name: String,
    pub(super) agent: Option<String>,
    pub(super) prompt: Option<String>,
    pub(super) agent_provider: Option<String>,
    pub(super) environment: Option<String>,
    pub(super) policy: PipelineStagePolicy,
    pub(super) post: Option<PipelinePost>,
}

/// Tail work of a stage, injected into the stage's running agent session when
/// the stage transitions forward. `agent` is the fallback used to spawn a
/// fresh session (and the prompt-body source) when the task's session is
/// dead; a live session keeps whatever agent is already running.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PipelinePost {
    pub(super) name: String,
    pub(super) agent: Option<String>,
    pub(super) prompt: Option<String>,
    pub(super) agent_provider: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PipelineStagePolicy {
    pub(super) transition: PipelineStageTransition,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
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

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PipelineEnvironment {
    pub(super) setup: Option<Vec<String>>,
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
        agent: post.agent.clone(),
        prompt: post.prompt.clone(),
        agent_provider: post.agent_provider.clone(),
        environment: owner.environment.clone(),
        policy: PipelineStagePolicy {
            transition: PipelineStageTransition::Auto,
        },
        post: None,
    })
}

#[derive(Deserialize)]
struct RawPipelineDefinition {
    name: Option<String>,
    stages: Vec<RawPipelineStage>,
    environments: Option<HashMap<String, PipelineEnvironment>>,
}

#[derive(Deserialize)]
struct RawPipelineStage {
    name: String,
    agent: Option<String>,
    prompt: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_provider_list")]
    agent_provider: Option<String>,
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
    execution: Option<RawPipelineStageExecution>,
}

#[derive(Deserialize)]
struct RawPipelinePost {
    name: String,
    agent: Option<String>,
    prompt: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_provider_list")]
    agent_provider: Option<String>,
}

#[derive(Deserialize)]
struct RawPipelinePostAction {
    name: String,
    agent: Option<String>,
    prompt: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_provider_list")]
    agent_provider: Option<String>,
    #[allow(dead_code)]
    transition: Option<PipelineStageTransition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawPipelineStageExecution {
    NewTask,
    Continue,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawAgentProviderList {
    Single(String),
    Multiple(Vec<String>),
}

#[derive(Default, Deserialize)]
struct AgentFrontmatter {
    agent_provider: Option<YamlValue>,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
}

pub(super) struct AgentDefinition {
    pub(super) prompt: String,
    pub(super) agent_providers: Vec<String>,
    pub(super) model: Option<String>,
    pub(super) permission_mode: Option<String>,
    pub(super) allowed_tools: Vec<String>,
}

pub(super) fn read_repo_config(repo_path: &str) -> Result<RepoConfig, String> {
    let path = Path::new(repo_path).join(".kanna/config.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            serde_json::from_str(&content).map_err(|e| format!("invalid repo config: {}", e))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(RepoConfig::default()),
        Err(err) => Err(format!("failed to read repo config: {}", err)),
    }
}

pub(super) fn read_pipeline_definition(
    repo_path: &str,
    pipeline_name: &str,
) -> Result<PipelineDefinition, String> {
    let path = Path::new(repo_path).join(format!(".kanna/pipelines/{pipeline_name}.json"));
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => read_builtin_resource(&format!(".kanna/pipelines/{pipeline_name}.json"))?,
    };
    let raw: RawPipelineDefinition = serde_json::from_str(&content)
        .map_err(|e| format!("invalid pipeline definition: {}", e))?;
    normalize_pipeline_definition(raw)
}

pub(super) fn read_task_pipeline_definition(
    repo_path: &str,
    pipeline_name: &str,
    pipeline_def: Option<&str>,
) -> Result<PipelineDefinition, String> {
    if let Some(pipeline_def) = pipeline_def.filter(|value| !value.trim().is_empty()) {
        let raw: RawPipelineDefinition = serde_json::from_str(pipeline_def)
            .map_err(|e| format!("invalid stored pipeline definition: {}", e))?;
        return normalize_pipeline_definition(raw);
    }
    read_pipeline_definition(repo_path, pipeline_name)
}

pub(super) fn read_agent_definition(
    repo_path: &str,
    agent_name: &str,
) -> Result<AgentDefinition, String> {
    let path = Path::new(repo_path).join(format!(".kanna/agents/{agent_name}/AGENT.md"));
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => read_builtin_resource(&format!(".kanna/agents/{agent_name}/AGENT.md"))?,
    };
    let mut definition = parse_agent_definition(&content)?;

    // Repo-local extension: layered onto the resolved agent (repo override or
    // built-in) so a repo can customize a default agent without rewriting it.
    let extend_path = Path::new(repo_path).join(format!(".kanna/agents/{agent_name}/EXTEND.md"));
    match std::fs::read_to_string(&extend_path) {
        Ok(extension) => {
            apply_agent_extension(&mut definition, &extension)
                .map_err(|e| format!("invalid agent extension {}: {}", extend_path.display(), e))?;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(format!(
                "failed to read agent extension {}: {}",
                extend_path.display(),
                err
            ))
        }
    }

    Ok(definition)
}

fn read_builtin_resource(relative_path: &str) -> Result<String, String> {
    if let Some(content) = compiled_builtin_resource(relative_path) {
        return Ok(content.to_string());
    }

    let mut dir = std::env::current_dir().map_err(|e| format!("failed to read cwd: {}", e))?;
    for _ in 0..10 {
        let candidate = dir.join(relative_path);
        if candidate.exists() {
            return std::fs::read_to_string(&candidate)
                .map_err(|e| format!("failed to read builtin resource: {}", e));
        }
        if !dir.pop() {
            break;
        }
    }
    Err(format!("resource not found: {}", relative_path))
}

fn compiled_builtin_resource(relative_path: &str) -> Option<&'static str> {
    match relative_path {
        ".kanna/pipelines/default.json" => {
            Some(include_str!("../../../../.kanna/pipelines/default.json"))
        }
        ".kanna/pipelines/qa.json" => Some(include_str!("../../../../.kanna/pipelines/qa.json")),
        ".kanna/agents/agent-factory/AGENT.md" => Some(include_str!(
            "../../../../.kanna/agents/agent-factory/AGENT.md"
        )),
        ".kanna/agents/approve/AGENT.md" => {
            Some(include_str!("../../../../.kanna/agents/approve/AGENT.md"))
        }
        ".kanna/agents/commit/AGENT.md" => {
            Some(include_str!("../../../../.kanna/agents/commit/AGENT.md"))
        }
        ".kanna/agents/config-factory/AGENT.md" => Some(include_str!(
            "../../../../.kanna/agents/config-factory/AGENT.md"
        )),
        ".kanna/agents/implement/AGENT.md" => {
            Some(include_str!("../../../../.kanna/agents/implement/AGENT.md"))
        }
        ".kanna/agents/merge/AGENT.md" => {
            Some(include_str!("../../../../.kanna/agents/merge/AGENT.md"))
        }
        ".kanna/agents/pipeline-factory/AGENT.md" => Some(include_str!(
            "../../../../.kanna/agents/pipeline-factory/AGENT.md"
        )),
        ".kanna/agents/pr/AGENT.md" => Some(include_str!("../../../../.kanna/agents/pr/AGENT.md")),
        ".kanna/agents/review/AGENT.md" => {
            Some(include_str!("../../../../.kanna/agents/review/AGENT.md"))
        }
        _ => None,
    }
}

/// Merge an `EXTEND.md` document into a resolved agent definition: the body
/// is appended to the base prompt and frontmatter fields replace the base's
/// when present. Frontmatter is optional; a plain markdown file is a pure
/// prompt extension.
fn apply_agent_extension(definition: &mut AgentDefinition, content: &str) -> Result<(), String> {
    let extension = parse_agent_definition(content)?;

    if !extension.prompt.is_empty() {
        if definition.prompt.is_empty() {
            definition.prompt = extension.prompt;
        } else {
            definition.prompt = format!("{}\n\n{}", definition.prompt, extension.prompt);
        }
    }
    if !extension.agent_providers.is_empty() {
        definition.agent_providers = extension.agent_providers;
    }
    if extension.model.is_some() {
        definition.model = extension.model;
    }
    if extension.permission_mode.is_some() {
        definition.permission_mode = extension.permission_mode;
    }
    if !extension.allowed_tools.is_empty() {
        definition.allowed_tools = extension.allowed_tools;
    }

    Ok(())
}

fn parse_agent_definition(content: &str) -> Result<AgentDefinition, String> {
    let (frontmatter, body) = split_frontmatter(content);
    let fm: AgentFrontmatter = match frontmatter {
        Some(raw) => {
            serde_yaml::from_str(raw).map_err(|e| format!("invalid AGENT.md frontmatter: {}", e))?
        }
        None => AgentFrontmatter::default(),
    };

    Ok(AgentDefinition {
        prompt: body.trim().to_string(),
        agent_providers: parse_agent_providers(fm.agent_provider),
        model: fm.model,
        permission_mode: fm.permission_mode,
        allowed_tools: fm.allowed_tools.unwrap_or_default(),
    })
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

fn parse_agent_providers(value: Option<YamlValue>) -> Vec<String> {
    match value {
        Some(YamlValue::Sequence(values)) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        Some(YamlValue::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn normalize_pipeline_definition(raw: RawPipelineDefinition) -> Result<PipelineDefinition, String> {
    let mut stages: Vec<PipelineStage> = Vec::new();
    for stage in raw.stages {
        let RawPipelineStage {
            name,
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

        let (transition, continues) = match policy {
            Some(policy) => (
                policy.transition,
                matches!(policy.execution, Some(RawPipelineStageExecution::Continue)),
            ),
            None => (
                transition.ok_or_else(|| format!("stage {name:?} is missing policy.transition"))?,
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
                agent: post.agent,
                prompt: post.prompt,
                agent_provider: post.agent_provider,
            }),
            (None, Some(post_action)) => Some(PipelinePost {
                name: post_action.name,
                agent: post_action.agent,
                prompt: post_action.prompt,
                agent_provider: post_action.agent_provider,
            }),
            (None, None) => None,
        };

        stages.push(PipelineStage {
            name,
            agent,
            prompt,
            agent_provider,
            environment,
            policy: PipelineStagePolicy { transition },
            post,
        });
    }

    Ok(PipelineDefinition {
        name: raw.name,
        stages,
        environments: raw.environments,
    })
}

fn deserialize_optional_provider_list<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<RawAgentProviderList>::deserialize(deserializer)?;
    Ok(match value {
        Some(RawAgentProviderList::Single(provider)) => Some(provider),
        Some(RawAgentProviderList::Multiple(providers)) => Some(providers.join(",")),
        None => None,
    })
}
