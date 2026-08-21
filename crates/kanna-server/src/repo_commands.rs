use crate::db::Repo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoCommandCatalog {
    pub(crate) repo_id: String,
    pub(crate) revision: String,
    pub(crate) commands: Vec<RepoCommand>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoCommand {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) description: String,
    pub(crate) group: RepoCommandGroup,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RepoCommandGroup {
    Automation,
    Configure,
}

#[cfg(test)]
impl RepoCommandGroup {
    fn as_str(self) -> &'static str {
        match self {
            Self::Automation => "automation",
            Self::Configure => "configure",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
struct CustomTaskDefinition {
    name: String,
    description: Option<String>,
    agent: Option<String>,
    agent_provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    execution_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
    disallowed_tools: Option<Vec<String>>,
    max_turns: Option<f64>,
    max_budget_usd: Option<f64>,
    setup: Option<Vec<String>>,
    teardown: Option<Vec<String>>,
    stage: Option<String>,
    prompt: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct RepoCommandLaunch {
    pub(crate) display_name: String,
    pub(crate) prompt: String,
    pub(crate) agent: Option<String>,
    pub(crate) agent_provider: Option<String>,
    pub(crate) agent_type: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) permission_mode: Option<String>,
    pub(crate) allowed_tools: Option<Vec<String>>,
    pub(crate) disallowed_tools: Option<Vec<String>>,
    pub(crate) max_turns: Option<u32>,
    pub(crate) max_budget_usd: Option<f64>,
    pub(crate) setup_cmds: Option<Vec<String>>,
    pub(crate) task_template: Option<crate::mobile_api::TaskTemplateLaunch>,
    pub(crate) stage: Option<String>,
    pub(crate) singleton_agent: Option<String>,
}

pub(crate) fn resolve_repo_command_launch(
    repo: &Repo,
    command_id: &str,
) -> Result<(String, Option<RepoCommandLaunch>), String> {
    let definitions = resolve_custom_task_definitions(repo)?;
    let revision = build_repo_command_catalog_from_definitions(repo, &definitions)?.revision;
    let launch = if let Some(slug) = command_id.strip_prefix("custom:") {
        definitions
            .get(slug)
            .map(|definition| custom_task_launch(slug, definition))
    } else {
        factory_launch(command_id)
    };
    Ok((revision, launch))
}

pub(crate) fn build_repo_command_catalog(repo: &Repo) -> Result<RepoCommandCatalog, String> {
    let definitions = resolve_custom_task_definitions(repo)?;
    build_repo_command_catalog_from_definitions(repo, &definitions)
}

fn build_repo_command_catalog_from_definitions(
    repo: &Repo,
    definitions: &BTreeMap<String, CustomTaskDefinition>,
) -> Result<RepoCommandCatalog, String> {
    let mut commands = ordered_custom_task_slugs(definitions)
        .into_iter()
        .filter_map(|slug| {
            let definition = definitions.get(&slug)?;
            Some(command(
                &format!("custom:{slug}"),
                &definition.name,
                definition.description.as_deref().unwrap_or(""),
                RepoCommandGroup::Automation,
            ))
        })
        .collect::<Vec<_>>();
    commands.extend([
        command(
            "factory:setup-repo",
            "Set Up Repository",
            "Configure .kanna workflow and agent flavors",
            RepoCommandGroup::Configure,
        ),
        command(
            "factory:create-config",
            "Create Config",
            "Create or update .kanna/config.json",
            RepoCommandGroup::Configure,
        ),
        command(
            "factory:create-agent",
            "Create Agent",
            "Create a new agent definition",
            RepoCommandGroup::Configure,
        ),
        command(
            "factory:create-workflow",
            "Create Workflow",
            "Create a new workflow definition",
            RepoCommandGroup::Configure,
        ),
        command(
            "factory:new-custom-task",
            "New Custom Task",
            "Create a new reusable agent task definition",
            RepoCommandGroup::Configure,
        ),
    ]);
    let factory_launches = [
        "factory:setup-repo",
        "factory:create-config",
        "factory:create-agent",
        "factory:create-workflow",
        "factory:new-custom-task",
    ]
    .into_iter()
    .filter_map(factory_launch)
    .collect::<Vec<_>>();
    let encoded = serde_json::to_vec(&(commands.as_slice(), &definitions, factory_launches))
        .map_err(|error| format!("failed to encode repo command catalog: {error}"))?;
    let revision = format!("{:x}", Sha256::digest(encoded));

    Ok(RepoCommandCatalog {
        repo_id: repo.id.clone(),
        revision,
        commands,
    })
}

fn command(id: &str, label: &str, description: &str, group: RepoCommandGroup) -> RepoCommand {
    RepoCommand {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        group,
    }
}

fn resolve_custom_task_definitions(
    repo: &Repo,
) -> Result<BTreeMap<String, CustomTaskDefinition>, String> {
    let mut definitions = BTreeMap::new();
    for (slug, content) in [
        (
            "merge-master",
            include_str!("../../../.kanna/tasks/merge-master/agent.md"),
        ),
        (
            "task-manager",
            include_str!("../../../.kanna/tasks/task-manager/agent.md"),
        ),
        ("ship", include_str!("../../../.kanna/tasks/ship/agent.md")),
    ] {
        if let Some(definition) = parse_custom_task(content, slug) {
            definitions.insert(slug.to_string(), definition);
        }
    }

    let tasks_dir = Path::new(&repo.path).join(".kanna/tasks");
    let entries = match fs::read_dir(&tasks_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(definitions),
        Err(error) => {
            return Err(format!(
                "failed to read custom tasks from {}: {error}",
                tasks_dir.display()
            ))
        }
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().into_owned();
        if slug.is_empty() || slug.contains(['/', '\\']) {
            continue;
        }
        let path = entry.path().join("agent.md");
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some(definition) = parse_custom_task(&content, &slug) {
            definitions.insert(slug, definition);
        }
    }
    Ok(definitions)
}

fn ordered_custom_task_slugs(definitions: &BTreeMap<String, CustomTaskDefinition>) -> Vec<String> {
    let mut slugs = Vec::new();
    for builtin in ["merge-master", "task-manager", "ship"] {
        if definitions.contains_key(builtin) {
            slugs.push(builtin.to_string());
        }
    }
    slugs.extend(
        definitions
            .keys()
            .filter(|slug| {
                slug.as_str() != "merge-master"
                    && slug.as_str() != "task-manager"
                    && slug.as_str() != "ship"
            })
            .cloned(),
    );
    slugs
}

fn parse_custom_task(content: &str, slug: &str) -> Option<CustomTaskDefinition> {
    if content.trim().is_empty() {
        return None;
    }
    let (frontmatter, body) = split_frontmatter(content)?;
    let frontmatter_present = frontmatter.is_some();
    let fm = match frontmatter {
        Some(raw) => match serde_yaml::from_str::<serde_yaml::Value>(raw).ok()? {
            serde_yaml::Value::Null => serde_yaml::Mapping::new(),
            serde_yaml::Value::Mapping(mapping) => mapping,
            _ => return None,
        },
        None => serde_yaml::Mapping::new(),
    };
    let prompt = body.trim().to_string();
    let agent = mapping_string(&fm, "agent").filter(|value| !value.trim().is_empty());
    if prompt.is_empty() && (!frontmatter_present || agent.is_none()) {
        return None;
    }
    let permission_mode = mapping_string(&fm, "permission_mode")
        .filter(|value| matches!(value.as_str(), "dontAsk" | "acceptEdits" | "default"));
    let execution_mode =
        mapping_string(&fm, "execution_mode").and_then(|value| match value.as_str() {
            "pty" | "agent" => Some(value),
            "sdk" => Some("agent".to_string()),
            _ => None,
        });
    let stage = mapping_string(&fm, "stage")
        .filter(|value| matches!(value.as_str(), "in_progress" | "pr" | "done"));

    Some(CustomTaskDefinition {
        name: mapping_string(&fm, "name").unwrap_or_else(|| slug_to_display_name(slug)),
        description: mapping_string(&fm, "description"),
        agent,
        agent_provider: first_known_provider(mapping_value(&fm, "agent_provider")),
        model: mapping_string(&fm, "model"),
        effort: mapping_string(&fm, "effort"),
        permission_mode,
        execution_mode,
        allowed_tools: mapping_string_list(&fm, "allowed_tools"),
        disallowed_tools: mapping_string_list(&fm, "disallowed_tools"),
        max_turns: mapping_number(&fm, "max_turns"),
        max_budget_usd: mapping_number(&fm, "max_budget_usd"),
        setup: mapping_string_list(&fm, "setup"),
        teardown: mapping_string_list(&fm, "teardown"),
        stage,
        prompt,
    })
}

fn split_frontmatter(content: &str) -> Option<(Option<&str>, &str)> {
    let normalized = content.trim_start_matches('\u{feff}');
    let first_line_end = normalized.find('\n').unwrap_or(normalized.len());
    let first_line = normalized[..first_line_end]
        .trim_end_matches('\r')
        .trim_end_matches([' ', '\t']);
    if first_line != "---" {
        return Some((None, normalized));
    }
    if first_line_end == normalized.len() {
        return None;
    }

    let yaml_start = first_line_end + 1;
    let mut line_start = yaml_start;
    loop {
        let line_end = normalized[line_start..]
            .find('\n')
            .map(|offset| line_start + offset)
            .unwrap_or(normalized.len());
        let line = normalized[line_start..line_end]
            .trim_end_matches('\r')
            .trim_end_matches([' ', '\t']);
        if line == "---" {
            let body_start = if line_end < normalized.len() {
                line_end + 1
            } else {
                line_end
            };
            return Some((
                Some(&normalized[yaml_start..line_start]),
                &normalized[body_start..],
            ));
        }
        if line_end == normalized.len() {
            return None;
        }
        line_start = line_end + 1;
    }
}

fn mapping_value<'a>(mapping: &'a serde_yaml::Mapping, key: &str) -> Option<&'a serde_yaml::Value> {
    mapping.get(serde_yaml::Value::String(key.to_string()))
}

fn mapping_string(mapping: &serde_yaml::Mapping, key: &str) -> Option<String> {
    mapping_value(mapping, key)?.as_str().map(str::to_string)
}

fn mapping_string_list(mapping: &serde_yaml::Mapping, key: &str) -> Option<Vec<String>> {
    let serde_yaml::Value::Sequence(values) = mapping_value(mapping, key)? else {
        return None;
    };
    values
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect()
}

fn mapping_number(mapping: &serde_yaml::Mapping, key: &str) -> Option<f64> {
    mapping_value(mapping, key)?.as_f64()
}

fn first_known_provider(value: Option<&serde_yaml::Value>) -> Option<String> {
    let values = match value? {
        serde_yaml::Value::Sequence(values) => values
            .iter()
            .filter_map(serde_yaml::Value::as_str)
            .flat_map(|value| value.split(','))
            .collect::<Vec<_>>(),
        serde_yaml::Value::String(value) => value.split(',').collect::<Vec<_>>(),
        _ => return None,
    };
    values
        .into_iter()
        .map(str::trim)
        .find(|value| {
            matches!(
                *value,
                "claude" | "copilot" | "codex" | "opencode" | "antigravity"
            )
        })
        .map(str::to_string)
}

fn slug_to_display_name(slug: &str) -> String {
    slug.split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn custom_task_launch(slug: &str, definition: &CustomTaskDefinition) -> RepoCommandLaunch {
    let prompt = if slug == "merge-master" && definition.prompt.is_empty() {
        "Analyze, order, verify, and merge ready pull requests for this repository.".to_string()
    } else {
        definition.prompt.clone()
    };
    RepoCommandLaunch {
        display_name: definition.name.clone(),
        prompt,
        agent: definition.agent.clone(),
        agent_provider: definition.agent_provider.clone(),
        agent_type: definition.execution_mode.clone(),
        model: definition.model.clone(),
        effort: definition.effort.clone(),
        permission_mode: definition.permission_mode.clone(),
        allowed_tools: definition.allowed_tools.clone(),
        disallowed_tools: definition.disallowed_tools.clone(),
        max_turns: definition
            .max_turns
            .filter(|value| {
                value.is_finite()
                    && value.fract() == 0.0
                    && *value >= 0.0
                    && *value <= u32::MAX as f64
            })
            .map(|value| value as u32),
        max_budget_usd: definition.max_budget_usd.filter(|value| value.is_finite()),
        setup_cmds: definition.setup.clone(),
        task_template: Some(crate::mobile_api::TaskTemplateLaunch {
            id: format!("custom:{slug}"),
            teardown: definition.teardown.clone().unwrap_or_default(),
        }),
        stage: definition.stage.clone(),
        singleton_agent: match slug {
            "merge-master" => Some("merge".to_string()),
            "task-manager" => Some("task-manager".to_string()),
            _ => None,
        },
    }
}

fn factory_launch(command_id: &str) -> Option<RepoCommandLaunch> {
    let (display_name, prompt, agent) = match command_id {
        "factory:setup-repo" => (
            "Set Up Repository",
            "Set up Kanna for this repository.",
            Some("setup"),
        ),
        "factory:create-config" => (
            "Create Config",
            "Help me create or update the .kanna/config.json for this repository.",
            Some("config-factory"),
        ),
        "factory:create-agent" => (
            "Create Agent",
            "Help me create a new agent definition for this repository.",
            None,
        ),
        "factory:create-workflow" | "factory:create-pipeline" => (
            "Create Workflow",
            "Help me create a new workflow definition for this repository.",
            None,
        ),
        "factory:new-custom-task" => ("New Custom Task", NEW_CUSTOM_TASK_PROMPT, None),
        _ => return None,
    };
    Some(RepoCommandLaunch {
        display_name: display_name.to_string(),
        prompt: prompt.to_string(),
        agent: agent.map(str::to_string),
        agent_provider: None,
        agent_type: Some("pty".to_string()),
        model: None,
        effort: None,
        permission_mode: None,
        allowed_tools: None,
        disallowed_tools: None,
        max_turns: None,
        max_budget_usd: None,
        setup_cmds: None,
        task_template: None,
        stage: None,
        singleton_agent: None,
    })
}

const NEW_CUSTOM_TASK_PROMPT: &str = r#"You are helping the user define a custom agent task for Kanna.

Custom tasks are reusable agent configurations stored at .kanna/tasks/<taskname>/agent.md.
The file uses YAML frontmatter for configuration and markdown body for the agent prompt.
If `agent` is set, the markdown body is optional.

Guide the user through defining their custom task by asking about:
1. What the task should do (name, description, purpose)
2. Whether it should use an existing `.kanna/agents/<name>/AGENT.md` definition or an inline prompt
3. Configuration options they want to set

Available frontmatter fields (all optional, defaults shown):
- name: Display name (default: derived from directory name)
- description: Short description for the command palette
- agent: name of an existing `.kanna/agents/<name>/AGENT.md` to run
- agent_provider: "claude" | "copilot" | "codex" | "opencode" | "antigravity" (optional)
- model: null (uses Kanna default)
- effort: null (uses the provider/model default)
- permission_mode: "dontAsk" | "acceptEdits" | "default" (default: provider-specific yolo-equivalent: Claude and OpenCode use --dangerously-skip-permissions; Copilot and Codex use --yolo)
- execution_mode: "pty" | "agent" (default: pty; legacy "sdk" is accepted as "agent")
- allowed_tools: [] (empty = all allowed)
- disallowed_tools: []
- max_turns: null (unlimited)
- max_budget_usd: null (unlimited)
- setup: [] (commands run before the agent)
- teardown: [] (commands run after task closes)
- stage: "in_progress" (default)

Once you understand what they want, create the directory and write the agent.md file
at .kanna/tasks/<taskname>/agent.md. Use a lowercase hyphenated directory name."#;

#[cfg(test)]
mod tests {
    use super::{build_repo_command_catalog, parse_custom_task, resolve_repo_command_launch};
    use crate::db::Repo;
    use std::fs;

    #[test]
    fn catalog_contains_automations_and_factory_commands_in_stable_order() {
        let repo_dir = tempfile::tempdir().expect("temporary repository");
        let repo = Repo {
            id: "repo-1".to_string(),
            path: repo_dir.path().to_string_lossy().into_owned(),
            name: "Kanna".to_string(),
            default_branch: Some("main".to_string()),
            remote_url_hash: None,
            hidden: None,
            sort_order: None,
            created_at: None,
            last_opened_at: None,
        };

        let catalog = build_repo_command_catalog(&repo).expect("catalog");
        let commands = catalog
            .commands
            .iter()
            .map(|command| (command.id.as_str(), command.group.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(catalog.repo_id, "repo-1");
        assert_eq!(
            commands,
            vec![
                ("custom:merge-master", "automation"),
                ("custom:task-manager", "automation"),
                ("custom:ship", "automation"),
                ("factory:setup-repo", "configure"),
                ("factory:create-config", "configure"),
                ("factory:create-agent", "configure"),
                ("factory:create-workflow", "configure"),
                ("factory:new-custom-task", "configure"),
            ]
        );
        assert!(!catalog.revision.is_empty());
    }

    #[test]
    fn local_tasks_are_discovered_and_override_builtins_by_slug() {
        let repo_dir = tempfile::tempdir().expect("temporary repository");
        fs::create_dir_all(repo_dir.path().join(".kanna/tasks/deploy"))
            .expect("custom task directory");
        fs::write(
            repo_dir.path().join(".kanna/tasks/deploy/agent.md"),
            "---\nname: Production Release\ndescription: Deploy this repository\n---\nDeploy safely.\n",
        )
        .expect("custom task definition");
        fs::create_dir_all(repo_dir.path().join(".kanna/tasks/merge-master"))
            .expect("override directory");
        fs::write(
            repo_dir
                .path()
                .join(".kanna/tasks/merge-master/agent.md"),
            "---\nname: Local Merge Queue\ndescription: Use the repository policy\nagent: merge\n---\n",
        )
        .expect("override definition");
        let repo = Repo {
            id: "repo-1".to_string(),
            path: repo_dir.path().to_string_lossy().into_owned(),
            name: "Kanna".to_string(),
            default_branch: Some("main".to_string()),
            remote_url_hash: None,
            hidden: None,
            sort_order: None,
            created_at: None,
            last_opened_at: None,
        };

        let catalog = build_repo_command_catalog(&repo).expect("catalog");
        let deploy = catalog
            .commands
            .iter()
            .find(|command| command.id == "custom:deploy")
            .expect("deploy command");
        let merge = catalog
            .commands
            .iter()
            .find(|command| command.id == "custom:merge-master")
            .expect("merge command");

        assert_eq!(deploy.label, "Production Release");
        assert_eq!(deploy.description, "Deploy this repository");
        assert_eq!(merge.label, "Local Merge Queue");
        assert_eq!(merge.description, "Use the repository policy");
    }

    #[test]
    fn frontmatter_type_mismatches_fall_back_without_dropping_the_task() {
        let definition = parse_custom_task(
            "---\nname: 42\ndescription: [invalid]\nmax_turns: many\nallowed_tools: [Bash, 7]\n---\nDeploy safely.\n",
            "deploy",
        )
        .expect("custom task");

        assert_eq!(definition.name, "Deploy");
        assert_eq!(definition.description, None);
        assert_eq!(definition.max_turns, None);
        assert_eq!(definition.allowed_tools, None);
        assert_eq!(definition.prompt, "Deploy safely.");
    }

    #[test]
    fn frontmatter_delimiters_allow_trailing_space_and_a_closing_line_at_eof() {
        let definition = parse_custom_task(
            "--- \t\nname: Merge Queue\nagent: merge\n---   ",
            "merge-queue",
        )
        .expect("agent-only custom task");

        assert_eq!(definition.name, "Merge Queue");
        assert_eq!(definition.agent.as_deref(), Some("merge"));
        assert!(definition.prompt.is_empty());
    }

    #[test]
    fn revision_changes_when_launch_content_changes() {
        let repo_dir = tempfile::tempdir().expect("temporary repository");
        let task_dir = repo_dir.path().join(".kanna/tasks/deploy");
        fs::create_dir_all(&task_dir).expect("custom task directory");
        let task_path = task_dir.join("agent.md");
        fs::write(&task_path, "Deploy version one.\n").expect("first definition");
        let repo = Repo {
            id: "repo-1".to_string(),
            path: repo_dir.path().to_string_lossy().into_owned(),
            name: "Kanna".to_string(),
            default_branch: Some("main".to_string()),
            remote_url_hash: None,
            hidden: None,
            sort_order: None,
            created_at: None,
            last_opened_at: None,
        };

        let first = build_repo_command_catalog(&repo).expect("first catalog");
        fs::write(&task_path, "Deploy version two.\n").expect("second definition");
        let second = build_repo_command_catalog(&repo).expect("second catalog");

        assert_ne!(first.revision, second.revision);
    }

    #[test]
    fn custom_launch_preserves_supported_frontmatter_overrides() {
        let repo_dir = tempfile::tempdir().expect("temporary repository");
        fs::create_dir_all(repo_dir.path().join(".kanna/tasks/deploy"))
            .expect("custom task directory");
        fs::write(
            repo_dir.path().join(".kanna/tasks/deploy/agent.md"),
            r#"---
name: Deploy
agent: implement
agent_provider: codex, claude
model: gpt-5.4-mini
effort: high
permission_mode: acceptEdits
execution_mode: sdk
allowed_tools: [Bash]
disallowed_tools: [WebFetch]
max_turns: 12
max_budget_usd: 4.5
setup: [pnpm install]
teardown: [pnpm cleanup]
stage: pr
---
Deploy safely.
"#,
        )
        .expect("custom task definition");
        let repo = Repo {
            id: "repo-1".to_string(),
            path: repo_dir.path().to_string_lossy().into_owned(),
            name: "Kanna".to_string(),
            default_branch: Some("main".to_string()),
            remote_url_hash: None,
            hidden: None,
            sort_order: None,
            created_at: None,
            last_opened_at: None,
        };

        let launch = resolve_repo_command_launch(&repo, "custom:deploy")
            .expect("resolve command")
            .1
            .expect("deploy launch");

        assert_eq!(launch.agent.as_deref(), Some("implement"));
        assert_eq!(launch.agent_provider.as_deref(), Some("codex"));
        assert_eq!(launch.model.as_deref(), Some("gpt-5.4-mini"));
        assert_eq!(launch.effort.as_deref(), Some("high"));
        assert_eq!(launch.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(launch.agent_type.as_deref(), Some("agent"));
        assert_eq!(launch.allowed_tools, Some(vec!["Bash".to_string()]));
        assert_eq!(launch.disallowed_tools, Some(vec!["WebFetch".to_string()]));
        assert_eq!(launch.max_turns, Some(12));
        assert_eq!(launch.max_budget_usd, Some(4.5));
        assert_eq!(launch.setup_cmds, Some(vec!["pnpm install".to_string()]));
        assert_eq!(
            launch.task_template,
            Some(crate::mobile_api::TaskTemplateLaunch {
                id: "custom:deploy".to_string(),
                teardown: vec!["pnpm cleanup".to_string()],
            })
        );
        assert_eq!(launch.stage.as_deref(), Some("pr"));
    }

    #[test]
    fn builtin_ship_launch_binds_the_canonical_agent_in_interactive_mode() {
        let repo_dir = tempfile::tempdir().expect("temporary repository");
        let repo = Repo {
            id: "repo-1".to_string(),
            path: repo_dir.path().to_string_lossy().into_owned(),
            name: "Kanna".to_string(),
            default_branch: Some("main".to_string()),
            remote_url_hash: None,
            hidden: None,
            sort_order: None,
            created_at: None,
            last_opened_at: None,
        };

        let launch = resolve_repo_command_launch(&repo, "custom:ship")
            .expect("resolve command")
            .1
            .expect("ship launch");

        assert_eq!(launch.display_name, "Ship");
        assert_eq!(launch.agent.as_deref(), Some("ship"));
        assert_eq!(launch.agent_type.as_deref(), Some("pty"));
        assert!(launch.prompt.contains("interactive palette mode"));
        assert!(!launch.prompt.contains("git cherry-pick -x"));
    }

    #[test]
    fn builtin_task_manager_launch_binds_the_task_manager_singleton() {
        let repo_dir = tempfile::tempdir().expect("temporary repository");
        let repo = Repo {
            id: "repo-1".to_string(),
            path: repo_dir.path().to_string_lossy().into_owned(),
            name: "Kanna".to_string(),
            default_branch: Some("main".to_string()),
            remote_url_hash: None,
            hidden: None,
            sort_order: None,
            created_at: None,
            last_opened_at: None,
        };

        let launch = resolve_repo_command_launch(&repo, "custom:task-manager")
            .expect("resolve command")
            .1
            .expect("task-manager launch");

        assert_eq!(launch.display_name, "Task Manager");
        assert_eq!(launch.agent.as_deref(), Some("task-manager"));
        assert_eq!(launch.agent_type.as_deref(), Some("pty"));
        assert_eq!(launch.singleton_agent.as_deref(), Some("task-manager"));
        assert!(launch.prompt.contains("long-running Kanna task manager"));
    }

    #[test]
    fn merge_master_resolves_to_the_merge_singleton() {
        let repo_dir = tempfile::tempdir().expect("temporary repository");
        let repo = Repo {
            id: "repo-1".to_string(),
            path: repo_dir.path().to_string_lossy().into_owned(),
            name: "Kanna".to_string(),
            default_branch: Some("main".to_string()),
            remote_url_hash: None,
            hidden: None,
            sort_order: None,
            created_at: None,
            last_opened_at: None,
        };

        let launch = resolve_repo_command_launch(&repo, "custom:merge-master")
            .expect("resolve command")
            .1
            .expect("merge launch");

        assert_eq!(launch.singleton_agent.as_deref(), Some("merge"));
        assert!(!launch.prompt.is_empty());
    }
}
