use serde::Deserialize;
use serde_yaml::Value as YamlValue;
use std::collections::HashMap;
use std::path::Path;

#[derive(Default, Deserialize)]
pub(super) struct RepoConfig {
    pub(super) pipeline: Option<String>,
    pub(super) setup: Option<Vec<String>>,
    pub(super) ports: Option<HashMap<String, u16>>,
}

#[derive(Deserialize)]
pub(super) struct PipelineDefinition {
    pub(super) stages: Vec<PipelineStage>,
}

#[derive(Deserialize)]
pub(super) struct PipelineStage {
    pub(super) name: String,
    pub(super) agent: Option<String>,
    pub(super) prompt: Option<String>,
    pub(super) agent_provider: Option<String>,
    pub(super) transition: Option<String>,
    pub(super) mode: Option<PipelineStageMode>,
    pub(super) post_action: Option<PipelinePostAction>,
}

#[derive(Deserialize)]
pub(super) struct PipelinePostAction {
    pub(super) name: String,
    pub(super) agent: Option<String>,
    pub(super) prompt: Option<String>,
    pub(super) agent_provider: Option<String>,
    pub(super) transition: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum PipelineStageMode {
    NewTask,
    Continue,
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
    serde_json::from_str(&content).map_err(|e| format!("invalid pipeline definition: {}", e))
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
    parse_agent_definition(&content)
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
