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
    pub(super) flavors: Option<HashMap<String, String>>,
    pub(super) vars: Option<HashMap<String, String>>,
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

struct AgentExtension {
    prompt: String,
    agent_providers: Vec<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
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
    let config = read_repo_config(repo_path)?;
    let selector = AgentSelector::resolve(agent_name, config.flavors.as_ref());
    let path = Path::new(repo_path).join(format!(
        ".kanna/agents/{}/AGENT.md",
        selector.repo_agent_dir()
    ));
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => read_builtin_agent_resource(&selector)?,
    };
    let mut definition = parse_agent_definition(&content)?;

    // Repo-local extension: layered onto the resolved agent (repo override or
    // built-in) so a repo can customize a default agent without rewriting it.
    let extend_path = Path::new(repo_path).join(format!(
        ".kanna/agents/{}/EXTEND.md",
        selector.repo_agent_dir()
    ));
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
    if let Some(vars) = config.vars.as_ref() {
        definition.prompt = substitute_repo_config_vars(&definition.prompt, vars);
    }

    Ok(definition)
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
        match self.explicit_flavor.as_deref() {
            Some(flavor) => format!("{}@{}", self.role, flavor),
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

fn read_builtin_agent_resource(selector: &AgentSelector) -> Result<String, String> {
    if let Some(flavor) = selector.selected_flavor() {
        let flavor_path = format!(
            ".kanna/agents/{}/flavors/{}/AGENT.md",
            selector.role, flavor
        );
        if let Ok(content) = read_builtin_resource(&flavor_path) {
            return Ok(content);
        }
    }

    read_builtin_resource(&format!(".kanna/agents/{}/AGENT.md", selector.role))
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
        ".kanna/agents/merge/flavors/git/AGENT.md" => Some(include_str!(
            "../../../../.kanna/agents/merge/flavors/git/AGENT.md"
        )),
        ".kanna/agents/merge/flavors/github/AGENT.md" => Some(include_str!(
            "../../../../.kanna/agents/merge/flavors/github/AGENT.md"
        )),
        ".kanna/agents/pipeline-factory/AGENT.md" => Some(include_str!(
            "../../../../.kanna/agents/pipeline-factory/AGENT.md"
        )),
        ".kanna/agents/pr/AGENT.md" => Some(include_str!("../../../../.kanna/agents/pr/AGENT.md")),
        ".kanna/agents/pr/flavors/draft-pr/AGENT.md" => Some(include_str!(
            "../../../../.kanna/agents/pr/flavors/draft-pr/AGENT.md"
        )),
        ".kanna/agents/pr/flavors/push-only/AGENT.md" => Some(include_str!(
            "../../../../.kanna/agents/pr/flavors/push-only/AGENT.md"
        )),
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
    let extension = parse_agent_extension(content)?;

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
    if let Some(allowed_tools) = extension.allowed_tools {
        definition.allowed_tools = allowed_tools;
    }

    Ok(())
}

const RESERVED_PROMPT_VARS: &[&str] = &[
    "BASE_REF",
    "BRANCH",
    "PREV_RESULT",
    "SOURCE_WORKTREE",
    "TASK_PROMPT",
];

fn substitute_repo_config_vars(prompt: &str, vars: &HashMap<String, String>) -> String {
    let chars: Vec<char> = prompt.chars().collect();
    let mut rendered = String::with_capacity(prompt.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '$' {
            rendered.push(chars[index]);
            index += 1;
            continue;
        }

        if chars.get(index + 1) == Some(&'{') {
            if let Some(end_offset) = chars[index + 2..].iter().position(|ch| *ch == '}') {
                let name: String = chars[index + 2..index + 2 + end_offset].iter().collect();
                if is_config_var_name(&name) {
                    if let Some(value) = config_var_value(vars, &name) {
                        rendered.push_str(value);
                    } else {
                        rendered.push('$');
                        rendered.push('{');
                        rendered.push_str(&name);
                        rendered.push('}');
                    }
                    index += end_offset + 3;
                    continue;
                }
            }
        }

        if chars
            .get(index + 1)
            .is_some_and(|ch| ch.is_ascii_uppercase())
        {
            let start = index + 1;
            let mut end = start;
            while chars
                .get(end)
                .is_some_and(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || *ch == '_')
            {
                end += 1;
            }
            let name: String = chars[start..end].iter().collect();
            if let Some(value) = config_var_value(vars, &name) {
                rendered.push_str(value);
            } else {
                rendered.push('$');
                rendered.push_str(&name);
            }
            index = end;
            continue;
        }

        rendered.push('$');
        index += 1;
    }

    rendered
}

fn config_var_value<'a>(vars: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    if RESERVED_PROMPT_VARS.contains(&name) {
        return None;
    }
    vars.get(name).map(String::as_str)
}

fn is_config_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_uppercase()
        && chars.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
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

fn parse_agent_extension(content: &str) -> Result<AgentExtension, String> {
    let (frontmatter, body) = split_frontmatter(content);
    let fm: AgentFrontmatter = match frontmatter {
        Some(raw) => {
            serde_yaml::from_str(raw).map_err(|e| format!("invalid AGENT.md frontmatter: {}", e))?
        }
        None => AgentFrontmatter::default(),
    };

    let agent_providers = match fm.agent_provider {
        Some(value) => parse_agent_providers(Some(value)),
        None => Vec::new(),
    };

    Ok(AgentExtension {
        prompt: body.trim().to_string(),
        agent_providers,
        model: fm.model,
        permission_mode: fm.permission_mode,
        allowed_tools: fm.allowed_tools,
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
