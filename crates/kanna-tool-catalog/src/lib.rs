//! Shared catalog for Kanna MCP and CLI tools.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

const BUNDLED_CATALOG: &str = include_str!("catalog.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Catalog {
    pub tools: Vec<ToolDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub method: Method,
    pub path: String,
    #[serde(rename = "response")]
    pub response_kind: ResponseKind,
    #[serde(default)]
    pub params: Vec<ParamDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParamDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub param_type: ParamType,
    pub required: bool,
    pub location: ParamLoc,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default, rename = "enum")]
    pub enum_values: Option<Vec<String>>,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub min: Option<u64>,
    #[serde(default)]
    pub max: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
    Patch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseKind {
    Json,
    Text,
    Wait,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParamType {
    String,
    Integer,
    StringArray,
    Object,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParamLoc {
    Path,
    Query,
    Body,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WaitUntil {
    Finished,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WaitSpec {
    pub task_id: String,
    pub timeout_secs: u64,
    pub poll_secs: u64,
    pub until: WaitUntil,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedRequest {
    pub kind: ResponseKind,
    pub method: Method,
    pub path: String,
    pub body: Value,
    pub wait: Option<WaitSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogLoad {
    pub catalog: Catalog,
    pub watch_source: Option<PathBuf>,
    pub warning: Option<String>,
}

pub fn bundled_catalog() -> Catalog {
    serde_json::from_str(BUNDLED_CATALOG)
        .unwrap_or_else(|e| panic!("bundled kanna tool catalog is invalid: {e}"))
}

pub fn load_catalog(cwd: &Path) -> CatalogLoad {
    let env_path = std::env::var_os("KANNA_MCP_CATALOG").map(PathBuf::from);
    let file_path = env_path.or_else(|| {
        let local = cwd.join(".kanna/mcp-tools.json");
        local.exists().then_some(local)
    });

    let Some(path) = file_path else {
        return CatalogLoad {
            catalog: bundled_catalog(),
            watch_source: None,
            warning: None,
        };
    };

    match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<Catalog>(&contents) {
            Ok(catalog) => CatalogLoad {
                catalog,
                watch_source: Some(path),
                warning: None,
            },
            Err(e) => CatalogLoad {
                catalog: bundled_catalog(),
                watch_source: Some(path.clone()),
                warning: Some(format!(
                    "failed to parse catalog override {}: {e}",
                    path.display()
                )),
            },
        },
        Err(e) => CatalogLoad {
            catalog: bundled_catalog(),
            watch_source: Some(path.clone()),
            warning: Some(format!(
                "failed to read catalog override {}: {e}",
                path.display()
            )),
        },
    }
}

impl Catalog {
    pub fn tools_list_value(&self) -> Value {
        Value::Array(
            self.tools
                .iter()
                .map(|tool| {
                    let mut entry = serde_json::json!({
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": input_schema(tool),
                    });
                    if tool.method == Method::Get {
                        entry["annotations"] = serde_json::json!({ "readOnlyHint": true });
                    }
                    entry
                })
                .collect(),
        )
    }

    fn find_tool(&self, name: &str) -> Option<&ToolDef> {
        self.tools.iter().find(|tool| tool.name == name)
    }
}

fn input_schema(tool: &ToolDef) -> Value {
    let mut properties = Map::new();
    let mut required = Vec::new();

    for param in &tool.params {
        let mut property = match param.param_type {
            ParamType::String => serde_json::json!({ "type": "string" }),
            ParamType::Integer => serde_json::json!({ "type": "integer" }),
            ParamType::StringArray => {
                serde_json::json!({ "type": "array", "items": { "type": "string" } })
            }
            ParamType::Object => serde_json::json!({ "type": "object" }),
        };

        if let Some(description) = &param.description {
            property["description"] = Value::String(description.clone());
        }

        if let Some(enum_values) = &param.enum_values {
            property["enum"] = Value::Array(
                enum_values
                    .iter()
                    .map(|value| Value::String(value.clone()))
                    .collect(),
            );
        }

        if let Some(default) = &param.default {
            property["default"] = default.clone();
        }
        if param.param_type == ParamType::Integer {
            if let Some(min) = param.min {
                property["minimum"] = Value::Number(min.into());
            }
            if let Some(max) = param.max {
                property["maximum"] = Value::Number(max.into());
            }
        }

        properties.insert(param.name.clone(), property);
        if param.required {
            required.push(Value::String(param.name.clone()));
        }
    }

    let mut schema = Map::new();
    schema.insert("type".to_string(), Value::String("object".to_string()));
    schema.insert("properties".to_string(), Value::Object(properties));
    if !required.is_empty() {
        schema.insert("required".to_string(), Value::Array(required));
    }
    Value::Object(schema)
}

pub fn resolve_request(
    catalog: &Catalog,
    tool_name: &str,
    args: &Value,
) -> Result<ResolvedRequest, String> {
    let tool = catalog.find_tool(tool_name).ok_or_else(|| {
        let available = catalog
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!("unknown tool: {tool_name} (available tools: {available})")
    })?;
    reject_unknown_args(tool, args)?;
    let mut path = tool.path.clone();
    let mut body = Map::new();
    let mut query = Vec::new();

    for param in &tool.params {
        let Some(value) = value_for_param(tool, param, args)? else {
            continue;
        };
        match param.location {
            ParamLoc::Path => {
                let value = string_value(&value, &param.name)?;
                path = path.replace(&format!("{{{}}}", param.name), &encode_path_segment(&value));
            }
            ParamLoc::Query => {
                let key = param.key.as_deref().unwrap_or(&param.name);
                let rendered = query_value(&value, &param.name)?;
                query.push(format!(
                    "{}={}",
                    encode_path_segment(key),
                    encode_path_segment(&rendered)
                ));
            }
            ParamLoc::Body => {
                if tool.response_kind == ResponseKind::Wait {
                    continue;
                }
                let key = param.key.as_deref().unwrap_or(&param.name);
                body.insert(key.to_string(), value);
            }
        }
    }

    if !query.is_empty() {
        path.push('?');
        path.push_str(&query.join("&"));
    }

    let wait = if tool.response_kind == ResponseKind::Wait {
        Some(wait_spec(tool, args)?)
    } else {
        None
    };

    Ok(ResolvedRequest {
        kind: tool.response_kind,
        method: tool.method,
        path,
        body: Value::Object(body),
        wait,
    })
}

fn value_for_param(
    tool: &ToolDef,
    param: &ParamDef,
    args: &Value,
) -> Result<Option<Value>, String> {
    let value = args
        .get(&param.name)
        .cloned()
        .or_else(|| param.default.clone());
    let Some(value) = value else {
        if param.required {
            return Err(format!("missing required argument: {}", param.name));
        }
        return Ok(None);
    };

    if let Some(enum_values) = &param.enum_values {
        let rendered = string_value(&value, &param.name)?;
        if !enum_values.iter().any(|allowed| allowed == &rendered) {
            if tool.name == "kanna_complete_stage" && param.name == "status" {
                return Err("status must be success or failure".to_string());
            }
            if tool.response_kind == ResponseKind::Wait && param.name == "until" {
                return Err(format!("until must be finished or closed, got {rendered}"));
            }
            return Err(format!(
                "{} must be one of {}",
                param.name,
                enum_values.join(", ")
            ));
        }
    }

    let value = match param.param_type {
        ParamType::String => Value::String(string_value(&value, &param.name)?),
        ParamType::Integer => {
            Value::Number(integer_value(&value, &param.name, param.min, param.max)?.into())
        }
        ParamType::StringArray => Value::Array(
            string_array_value(&value, &param.name)?
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
        ParamType::Object => value,
    };
    Ok(Some(value))
}

fn reject_unknown_args(tool: &ToolDef, args: &Value) -> Result<(), String> {
    let Some(args_object) = args.as_object() else {
        return Ok(());
    };
    for key in args_object.keys() {
        if !tool.params.iter().any(|param| param.name == *key) {
            let accepted = tool
                .params
                .iter()
                .map(|param| param.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            if accepted.is_empty() {
                return Err(format!(
                    "unknown argument: {key} ({} accepts no arguments)",
                    tool.name
                ));
            }
            return Err(format!(
                "unknown argument: {key} ({} accepts: {accepted})",
                tool.name
            ));
        }
    }
    Ok(())
}

fn string_value(value: &Value, name: &str) -> Result<String, String> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{name} must be a string"))
}

fn integer_value(
    value: &Value,
    name: &str,
    min: Option<u64>,
    max: Option<u64>,
) -> Result<u64, String> {
    let mut number = value
        .as_u64()
        .ok_or_else(|| format!("{name} must be an unsigned integer"))?;
    if let Some(min) = min {
        number = number.max(min);
    }
    if let Some(max) = max {
        number = number.min(max);
    }
    Ok(number)
}

fn string_array_value(value: &Value, name: &str) -> Result<Vec<String>, String> {
    let Some(values) = value.as_array() else {
        return Err(format!("{name} must be an array of strings"));
    };
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{name} must be an array of strings"))
        })
        .collect()
}

fn query_value(value: &Value, name: &str) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Number(value) => Ok(value.to_string()),
        _ => Err(format!("{name} must be an unsigned integer")),
    }
}

fn wait_spec(tool: &ToolDef, args: &Value) -> Result<WaitSpec, String> {
    let mut task_id = None;
    let mut timeout_secs = 600;
    let mut poll_secs = 3;
    let mut until = WaitUntil::Finished;

    for param in &tool.params {
        let Some(value) = value_for_param(tool, param, args)? else {
            continue;
        };
        match param.name.as_str() {
            "task_id" => task_id = Some(string_value(&value, &param.name)?),
            "timeout_secs" => timeout_secs = integer_value(&value, &param.name, None, None)?,
            "poll_secs" => poll_secs = integer_value(&value, &param.name, None, None)?,
            "until" => {
                until = match string_value(&value, &param.name)?.as_str() {
                    "finished" => WaitUntil::Finished,
                    "closed" => WaitUntil::Closed,
                    other => return Err(format!("until must be finished or closed, got {other}")),
                };
            }
            _ => {}
        }
    }

    Ok(WaitSpec {
        task_id: task_id.ok_or_else(|| "missing required argument: task_id".to_string())?,
        timeout_secs,
        poll_secs,
        until,
    })
}

pub fn encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}
