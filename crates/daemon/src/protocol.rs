use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Spawn {
        session_id: String,
        executable: String,
        args: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
    },
    Attach {
        session_id: String,
    },
    Detach {
        session_id: String,
    },
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Signal {
        session_id: String,
        signal: String,
    },
    Kill {
        session_id: String,
    },
    List,
    Subscribe,
    Handoff {
        version: u32,
    },
    HookEvent {
        session_id: String,
        event: String,
        data: Option<serde_json::Value>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Event {
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    Exit {
        session_id: String,
        code: i32,
    },
    StatusChanged {
        session_id: String,
        status: String,
    },
    SessionCreated {
        session_id: String,
    },
    SessionList {
        sessions: Vec<SessionInfo>,
    },
    Ok,
    Error {
        message: String,
    },
    HandoffReady {
        sessions: Vec<SessionInfo>,
    },
    HandoffUnsupported,
    ShuttingDown,
    HookEvent {
        session_id: String,
        event: String,
        data: Option<serde_json::Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub pid: u32,
    pub cwd: String,
    pub state: SessionState,
    pub idle_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionState {
    Active,
    Suspended,
    Exited(i32),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_spawn_roundtrip() {
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), "/home/user".to_string());
        let cmd = Command::Spawn {
            session_id: "abc123".to_string(),
            executable: "/bin/bash".to_string(),
            args: vec!["-l".to_string()],
            cwd: "/tmp".to_string(),
            env,
            cols: 80,
            rows: 24,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Spawn {
                session_id,
                executable,
                cols,
                rows,
                ..
            } => {
                assert_eq!(session_id, "abc123");
                assert_eq!(executable, "/bin/bash");
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_command_list_roundtrip() {
        let cmd = Command::List;
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"List\""));
        let decoded: Command = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, Command::List));
    }

    #[test]
    fn test_command_input_roundtrip() {
        let cmd = Command::Input {
            session_id: "s1".to_string(),
            data: vec![104, 101, 108, 108, 111],
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Input { session_id, data } => {
                assert_eq!(session_id, "s1");
                assert_eq!(data, b"hello");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_output_roundtrip() {
        let evt = Event::Output {
            session_id: "s1".to_string(),
            data: vec![1, 2, 3],
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Output { session_id, data } => {
                assert_eq!(session_id, "s1");
                assert_eq!(data, vec![1, 2, 3]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_exit_roundtrip() {
        let evt = Event::Exit {
            session_id: "s1".to_string(),
            code: 42,
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Exit { session_id, code } => {
                assert_eq!(session_id, "s1");
                assert_eq!(code, 42);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_ok_roundtrip() {
        let evt = Event::Ok;
        let json = serde_json::to_string(&evt).unwrap();
        assert!(json.contains("\"Ok\""));
        let decoded: Event = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, Event::Ok));
    }

    #[test]
    fn test_event_error_roundtrip() {
        let evt = Event::Error {
            message: "something went wrong".to_string(),
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Error { message } => assert_eq!(message, "something went wrong"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_session_info_roundtrip() {
        let info = SessionInfo {
            session_id: "s1".to_string(),
            pid: 12345,
            cwd: "/home/user".to_string(),
            state: SessionState::Active,
            idle_seconds: 30,
        };
        let json = serde_json::to_string(&info).unwrap();
        let decoded: SessionInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.session_id, "s1");
        assert_eq!(decoded.pid, 12345);
        assert_eq!(decoded.idle_seconds, 30);
        assert!(matches!(decoded.state, SessionState::Active));
    }

    #[test]
    fn test_session_state_exited_roundtrip() {
        let state = SessionState::Exited(1);
        let json = serde_json::to_string(&state).unwrap();
        let decoded: SessionState = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, SessionState::Exited(1)));
    }

    #[test]
    fn test_event_session_list_roundtrip() {
        let evt = Event::SessionList {
            sessions: vec![SessionInfo {
                session_id: "s1".to_string(),
                pid: 999,
                cwd: "/tmp".to_string(),
                state: SessionState::Suspended,
                idle_seconds: 10,
            }],
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::SessionList { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].session_id, "s1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_command_hook_event_roundtrip() {
        let cmd = Command::HookEvent {
            session_id: "s1".to_string(),
            event: "Stop".to_string(),
            data: Some(serde_json::json!({"key": "val"})),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::HookEvent {
                session_id,
                event,
                data,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(event, "Stop");
                assert!(data.is_some());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_hook_event_roundtrip() {
        let evt = Event::HookEvent {
            session_id: "s1".to_string(),
            event: "Stop".to_string(),
            data: None,
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::HookEvent {
                session_id,
                event,
                data,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(event, "Stop");
                assert!(data.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_shutting_down_roundtrip() {
        let evt = Event::ShuttingDown;
        let json = serde_json::to_string(&evt).unwrap();
        assert_eq!(json, r#"{"type":"ShuttingDown"}"#);
        let decoded: Event = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, Event::ShuttingDown));
    }

    #[test]
    fn test_command_signal_roundtrip() {
        let cmd = Command::Signal {
            session_id: "s1".to_string(),
            signal: "SIGTERM".to_string(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Signal { session_id, signal } => {
                assert_eq!(session_id, "s1");
                assert_eq!(signal, "SIGTERM");
            }
            _ => panic!("wrong variant"),
        }
    }
}
