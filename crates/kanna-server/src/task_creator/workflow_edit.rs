//! Authoring boundary for replacing an existing task's pinned linear workflow.
use super::{definitions::*, TaskWorkflowSnapshot};
use crate::db::{Repo, StageRun};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::LazyLock;

static SCHEMA: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let schema = serde_json::from_str(include_str!("../../../../.kanna/workflows/schema.json"))
        .expect("bundled workflow schema is JSON");
    jsonschema::validator_for(&schema).expect("bundled workflow schema compiles")
});

pub(crate) struct ValidatedWorkflowReplacement {
    pub snapshot: TaskWorkflowSnapshot,
    pub superseded_run_ids: Vec<String>,
    pub changed_execution_stages: Vec<String>,
}

pub(crate) fn validate_task_workflow_replacement(
    repo: &Repo,
    value: &Value,
    previous: &str,
    current_stage: &str,
    runs: &[StageRun],
) -> Result<ValidatedWorkflowReplacement, String> {
    if value.to_string().len() > 256 * 1024 {
        return Err("workflowDefinition exceeds 256 KiB".into());
    }
    let errors: Vec<_> = SCHEMA
        .iter_errors(value)
        .map(|error| format!("{}: {error}", error.instance_path()))
        .collect();
    if !errors.is_empty() {
        return Err(format!("workflowDefinition: {}", errors.join("; ")));
    }
    let workflow = parse_workflow_definition(&value.to_string())?;
    let prior = parse_stored_workflow_definition(previous)?;
    let definitions = RepoDefinitions::resolve(repo)?;
    let bindings =
        |workflow: &WorkflowDefinition| -> Result<BTreeMap<String, (String, Value)>, String> {
            let mut bindings = BTreeMap::new();
            for stage in &workflow.stages {
                if bindings
                    .insert(
                        stage.name.clone(),
                        (
                            "main".into(),
                            serde_json::to_value(stage)
                                .map_err(|error| format!("stage '{}': {error}", stage.name))?,
                        ),
                    )
                    .is_some()
                {
                    return Err(format!("duplicate stage/post name '{}'", stage.name));
                }
                if let Some(post) = &stage.post {
                    if bindings
                        .insert(
                            post.name.clone(),
                            (
                                format!("post:{}", stage.name),
                                serde_json::to_value(post)
                                    .map_err(|error| format!("post '{}': {error}", post.name))?,
                            ),
                        )
                        .is_some()
                    {
                        return Err(format!("duplicate stage/post name '{}'", post.name));
                    }
                }
            }
            Ok(bindings)
        };
    let before = bindings(&prior)?;
    let after = bindings(&workflow)?;
    if after.len() > 32 {
        return Err("workflowDefinition exceeds 32 stages including posts".into());
    }
    for name in std::iter::once(current_stage).chain(runs.iter().map(|run| run.stage.as_str())) {
        let old = before
            .get(name)
            .ok_or_else(|| format!("recorded stage '{name}' is absent from the pinned workflow"))?;
        let new = after
            .get(name)
            .ok_or_else(|| format!("cannot remove or rename current/recorded stage '{name}'"))?;
        if old.0 != new.0 {
            return Err(format!(
                "cannot change the main/post ownership of recorded stage '{name}'"
            ));
        }
    }
    let protected: std::collections::BTreeSet<&str> = std::iter::once(current_stage)
        .chain(runs.iter().map(|run| run.stage.as_str()))
        .collect();
    let protected_order = |definition: &WorkflowDefinition| -> Vec<String> {
        definition
            .stages
            .iter()
            .flat_map(|stage| {
                std::iter::once(&stage.name).chain(stage.post.iter().map(|post| &post.name))
            })
            .filter(|name| protected.contains(name.as_str()))
            .cloned()
            .collect()
    };
    if protected_order(&prior) != protected_order(&workflow) {
        return Err("cannot reorder current/recorded stages or posts".into());
    }
    for stage in &workflow.stages {
        if let Some(environment) = &stage.environment {
            if !workflow
                .environments
                .as_ref()
                .is_some_and(|all| all.contains_key(environment))
            {
                return Err(format!(
                    "stage '{}': unknown environment '{environment}'",
                    stage.name
                ));
            }
        }
        for (name, agent) in std::iter::once((&stage.name, &stage.agent))
            .chain(stage.post.iter().map(|post| (&post.name, &post.agent)))
        {
            if let Some(agent) = agent {
                definitions
                    .agent(agent)
                    .map_err(|error| format!("stage '{name}', agent '{agent}': {error}"))?;
            }
        }
    }
    // A changed execution binding supersedes old conversations for this stage
    // only. Description/policy edits need no provider re-resolution.
    let execution = |definition: &WorkflowDefinition, name: &str, value: &Value| {
        let owner = definition.stages.iter().find(|stage| {
            stage.name == name || stage.post.as_ref().is_some_and(|post| post.name == name)
        });
        let environment = owner.and_then(|stage| stage.environment.as_deref());
        serde_json::json!({
            "agent": value.get("agent"), "agent_provider": value.get("agent_provider"),
            "prompt": value.get("prompt"), "environment": environment,
            "environmentDefinition": environment.and_then(|name| definition.environments.as_ref()?.get(name))
        })
    };
    let changed_execution_stages: Vec<String> = after
        .iter()
        .filter(|(name, new)| {
            before.get(*name).is_none_or(|old| {
                execution(&prior, name, &old.1) != execution(&workflow, name, &new.1)
            })
        })
        .map(|(name, _)| name.clone())
        .collect();
    let superseded_run_ids = runs
        .iter()
        .filter(|run| changed_execution_stages.contains(&run.stage))
        .map(|run| run.id.clone())
        .collect();
    Ok(ValidatedWorkflowReplacement {
        snapshot: TaskWorkflowSnapshot {
            definition_json: serde_json::to_string(&workflow).map_err(|error| error.to_string())?,
            stage_names: workflow
                .stages
                .iter()
                .map(|stage| stage.name.clone())
                .collect(),
            revision_limit: workflow.revision_limit(),
        },
        superseded_run_ids,
        changed_execution_stages,
    })
}
