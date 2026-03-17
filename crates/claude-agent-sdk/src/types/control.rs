use serde::{Deserialize, Serialize};

/// A control request envelope sent over stdin/stdout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlRequestEnvelope {
    /// Always "control_request".
    #[serde(rename = "type")]
    pub type_field: String,
    /// Unique request ID for matching responses.
    pub request_id: String,
    /// The request payload.
    pub request: ControlRequest,
}

/// A control request payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype")]
pub enum ControlRequest {
    /// Interrupt the current operation.
    #[serde(rename = "interrupt")]
    Interrupt,

    /// Set the model for subsequent turns.
    #[serde(rename = "set_model")]
    SetModel {
        /// The model identifier to switch to.
        model: String,
    },

    /// Set the permission mode.
    #[serde(rename = "set_permission_mode")]
    SetPermissionMode {
        /// The new permission mode.
        permission_mode: String,
    },

    /// Permission check: can the CLI use this tool?
    #[serde(rename = "can_use_tool")]
    CanUseTool {
        /// The name of the tool being requested.
        tool_name: String,
        /// The tool input parameters.
        input: serde_json::Value,
    },
}

/// A control response envelope sent over stdin/stdout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlResponseEnvelope {
    /// Always "control_response".
    #[serde(rename = "type")]
    pub type_field: String,
    /// The response payload.
    pub response: ControlResponse,
}

/// A control response payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype")]
pub enum ControlResponse {
    /// The request succeeded.
    #[serde(rename = "success")]
    Success {
        /// The request ID this responds to.
        request_id: String,
        /// The response data.
        response: serde_json::Value,
    },

    /// The request failed.
    #[serde(rename = "error")]
    Error {
        /// The request ID this responds to.
        request_id: String,
        /// Error message.
        error: String,
    },
}

impl ControlResponse {
    /// Returns the request_id from the response.
    pub fn request_id(&self) -> &str {
        match self {
            ControlResponse::Success { request_id, .. } => request_id,
            ControlResponse::Error { request_id, .. } => request_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_interrupt_control_request() {
        let envelope = ControlRequestEnvelope {
            type_field: "control_request".to_string(),
            request_id: "req_001".to_string(),
            request: ControlRequest::Interrupt,
        };

        let json = serde_json::to_string(&envelope).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(value["type"], "control_request");
        assert_eq!(value["request_id"], "req_001");
        assert_eq!(value["request"]["subtype"], "interrupt");
    }

    #[test]
    fn test_serialize_set_model_control_request() {
        let envelope = ControlRequestEnvelope {
            type_field: "control_request".to_string(),
            request_id: "req_002".to_string(),
            request: ControlRequest::SetModel {
                model: "claude-opus-4-6".to_string(),
            },
        };

        let json = serde_json::to_string(&envelope).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(value["request"]["subtype"], "set_model");
        assert_eq!(value["request"]["model"], "claude-opus-4-6");
    }

    #[test]
    fn test_serialize_set_permission_mode_control_request() {
        let envelope = ControlRequestEnvelope {
            type_field: "control_request".to_string(),
            request_id: "req_003".to_string(),
            request: ControlRequest::SetPermissionMode {
                permission_mode: "dont-ask".to_string(),
            },
        };

        let json = serde_json::to_string(&envelope).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(value["request"]["subtype"], "set_permission_mode");
        assert_eq!(value["request"]["permission_mode"], "dont-ask");
    }

    #[test]
    fn test_deserialize_can_use_tool_request() {
        let json = r#"{
            "type": "control_request",
            "request_id": "req_004",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Edit",
                "input": {"file_path": "/tmp/test.rs", "old_string": "foo", "new_string": "bar"}
            }
        }"#;

        let envelope: ControlRequestEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(envelope.request_id, "req_004");
        match envelope.request {
            ControlRequest::CanUseTool { tool_name, input } => {
                assert_eq!(tool_name, "Edit");
                assert_eq!(input["file_path"], "/tmp/test.rs");
            }
            _ => panic!("Expected CanUseTool"),
        }
    }

    #[test]
    fn test_deserialize_success_control_response() {
        let json = r#"{
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "req_005",
                "response": {"status": "ok"}
            }
        }"#;

        let envelope: ControlResponseEnvelope = serde_json::from_str(json).unwrap();
        match &envelope.response {
            ControlResponse::Success {
                request_id,
                response,
            } => {
                assert_eq!(request_id, "req_005");
                assert_eq!(response["status"], "ok");
            }
            _ => panic!("Expected Success response"),
        }
        assert_eq!(envelope.response.request_id(), "req_005");
    }

    #[test]
    fn test_deserialize_error_control_response() {
        let json = r#"{
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": "req_006",
                "error": "Unknown request type"
            }
        }"#;

        let envelope: ControlResponseEnvelope = serde_json::from_str(json).unwrap();
        match &envelope.response {
            ControlResponse::Error { request_id, error } => {
                assert_eq!(request_id, "req_006");
                assert_eq!(error, "Unknown request type");
            }
            _ => panic!("Expected Error response"),
        }
    }

    #[test]
    fn test_serialize_permission_response() {
        let response = ControlResponseEnvelope {
            type_field: "control_response".to_string(),
            response: ControlResponse::Success {
                request_id: "req_perm".to_string(),
                response: serde_json::json!({"allowed": true}),
            },
        };

        let json = serde_json::to_string(&response).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(value["type"], "control_response");
        assert_eq!(value["response"]["subtype"], "success");
        assert_eq!(value["response"]["request_id"], "req_perm");
        assert_eq!(value["response"]["response"]["allowed"], true);
    }

    #[test]
    fn test_roundtrip_control_request() {
        let original = ControlRequestEnvelope {
            type_field: "control_request".to_string(),
            request_id: "req_rt".to_string(),
            request: ControlRequest::SetModel {
                model: "claude-sonnet-4-6".to_string(),
            },
        };

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: ControlRequestEnvelope = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.type_field, "control_request");
        assert_eq!(deserialized.request_id, "req_rt");
        match deserialized.request {
            ControlRequest::SetModel { model } => {
                assert_eq!(model, "claude-sonnet-4-6");
            }
            _ => panic!("Expected SetModel"),
        }
    }
}
