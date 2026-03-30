use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    future::pending,
    io::{Read, Write},
    net::SocketAddr,
    sync::{Arc, Mutex},
    thread,
};
use tokio::sync::broadcast;
use vt100::Parser;

const INDEX_HTML: &str = include_str!("../index.html");
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 36;

#[derive(Clone)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    parser: Mutex<Parser>,
    tx: broadcast::Sender<Vec<u8>>,
}

#[derive(Debug, Deserialize)]
struct SpawnRequest {
    #[serde(rename = "sessionId")]
    session_id: String,
    executable: String,
    args: Vec<String>,
    cwd: String,
}

#[derive(Debug, Serialize)]
struct SpawnResponse {
    ok: bool,
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Deserialize)]
struct KillRequest {
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Deserialize)]
struct WsParams {
    session: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "attach")]
    Attach {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: Option<u16>,
        rows: Option<u16>,
    },
    #[serde(rename = "input")]
    Input {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: Vec<u8>,
    },
    #[serde(rename = "resize")]
    Resize {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "detach")]
    Detach {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[derive(Debug, Serialize)]
struct ServerMessage<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

#[tokio::main]
async fn main() {
    let state = AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/spawn", post(spawn))
        .route("/kill", post(kill))
        .route("/ws", get(ws))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 3491));
    println!("pty-restore-test listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind listener");
    axum::serve(listener, app).await.expect("serve app");
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn spawn(
    State(state): State<AppState>,
    Json(request): Json<SpawnRequest>,
) -> Result<Json<SpawnResponse>, (StatusCode, Json<serde_json::Value>)> {
    println!("[spawn] request session_id={}", request.session_id);
    let session = spawn_session(&request).map_err(error_response)?;
    println!("[spawn] created session session_id={}", request.session_id);
    let mut sessions = state.sessions.lock().expect("sessions lock");
    if sessions.contains_key(&request.session_id) {
        return Err(error_response("session already exists"));
    }
    sessions.insert(request.session_id.clone(), session);
    println!("[spawn] stored session session_id={}", request.session_id);
    Ok(Json(SpawnResponse {
        ok: true,
        session_id: request.session_id,
    }))
}

async fn kill(
    State(state): State<AppState>,
    Json(request): Json<KillRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let session = {
        let mut sessions = state.sessions.lock().expect("sessions lock");
        sessions.remove(&request.session_id)
    };

    let Some(session) = session else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        ));
    };

    session
        .writer
        .lock()
        .expect("writer lock")
        .write_all(&[0x03])
        .ok();

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<WsParams>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, params.session))
}

async fn handle_socket(mut socket: WebSocket, state: AppState, initial_session: Option<String>) {
    let mut active_session = initial_session;
    let mut rx: Option<broadcast::Receiver<Vec<u8>>> = None;

    loop {
        tokio::select! {
            maybe_msg = socket.recv() => {
                let Some(Ok(msg)) = maybe_msg else { break; };
                if let Message::Text(text) = msg {
                    let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else {
                        let _ = send_server_message(&mut socket, "error", None, Some("invalid message")).await;
                        continue;
                    };

                    match message {
                        ClientMessage::Attach { session_id, cols, rows } => {
                            let Some(session) = get_session(&state, &session_id) else {
                                let _ = send_server_message(&mut socket, "error", Some(&session_id), Some("session not found")).await;
                                continue;
                            };

                            if let (Some(cols), Some(rows)) = (cols, rows) {
                                let _ = resize_session(&session, cols, rows);
                            }

                            active_session = Some(session_id.clone());
                            rx = Some(session.tx.subscribe());

                            let snapshot = snapshot_from_parser(&session.parser.lock().expect("parser lock"));
                            if !snapshot.is_empty() {
                                let _ = socket.send(Message::Binary(snapshot.into())).await;
                            }

                            let _ = send_server_message(&mut socket, "attached", Some(&session_id), None).await;
                        }
                        ClientMessage::Input { session_id, data } => {
                            if let Some(session) = get_session(&state, &session_id) {
                                let _ = session.writer.lock().expect("writer lock").write_all(&data);
                                let _ = session.writer.lock().expect("writer lock").flush();
                            }
                        }
                        ClientMessage::Resize { session_id, cols, rows } => {
                            if let Some(session) = get_session(&state, &session_id) {
                                let _ = resize_session(&session, cols, rows);
                            }
                        }
                        ClientMessage::Detach { session_id } => {
                            active_session = None;
                            rx = None;
                            let _ = send_server_message(&mut socket, "detached", Some(&session_id), None).await;
                        }
                    }
                }
            }
            result = async {
                match &mut rx {
                    Some(receiver) => receiver.recv().await.ok(),
                    None => pending::<Option<Vec<u8>>>().await,
                }
            } => {
                if let Some(bytes) = result {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    let _ = active_session;
}

fn spawn_session(request: &SpawnRequest) -> Result<Arc<Session>, String> {
    println!(
        "[spawn_session] executable={} args={:?} cwd={}",
        request.executable, request.args, request.cwd
    );
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    println!("[spawn_session] openpty ok");

    let mut command = CommandBuilder::new(&request.executable);
    for arg in &request.args {
        command.arg(arg);
    }
    command.cwd(&request.cwd);
    command.env("TERM", "xterm-256color");
    command.env("TERM_PROGRAM", "xterm");

    println!("[spawn_session] spawning child");
    let _child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    println!("[spawn_session] child spawned");

    let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    println!("[spawn_session] writer acquired");
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    println!("[spawn_session] reader cloned");
    let (tx, _) = broadcast::channel(256);

    let session = Arc::new(Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        parser: Mutex::new(Parser::new(
            DEFAULT_ROWS,
            DEFAULT_COLS,
            10_000,
        )),
        tx,
    });

    let session_for_thread = Arc::clone(&session);
    thread::spawn(move || {
        println!("[spawn_session] reader thread start");
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = buffer[..n].to_vec();
                    session_for_thread
                        .parser
                        .lock()
                        .expect("parser lock")
                        .process(&chunk);
                    let _ = session_for_thread.tx.send(chunk);
                }
                Err(_) => break,
            }
        }
    });

    Ok(session)
}

fn resize_session(session: &Arc<Session>, cols: u16, rows: u16) -> Result<(), String> {
    session
        .master
        .lock()
        .expect("master lock")
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    session
        .parser
        .lock()
        .expect("parser lock")
        .screen_mut()
        .set_size(rows, cols);

    Ok(())
}

fn get_session(state: &AppState, session_id: &str) -> Option<Arc<Session>> {
    state
        .sessions
        .lock()
        .expect("sessions lock")
        .get(session_id)
        .cloned()
}

fn snapshot_from_parser(parser: &Parser) -> Vec<u8> {
    parser.screen().contents_formatted().to_vec()
}

fn error_response(message: impl ToString) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": message.to_string() })),
    )
}

async fn send_server_message(
    socket: &mut WebSocket,
    kind: &'static str,
    session_id: Option<&str>,
    message: Option<&str>,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(&ServerMessage {
        kind,
        session_id,
        message,
    })
    .expect("serialize server message");
    socket.send(Message::Text(payload.into())).await
}

#[cfg(test)]
mod tests {
    use super::snapshot_from_parser;
    use vt100::Parser;

    #[test]
    fn snapshot_contains_rendered_terminal_content() {
        let mut parser = Parser::new(24, 80, 1000);
        parser.process(b"hello from vt100");

        let snapshot = snapshot_from_parser(&parser);
        let snapshot_text = String::from_utf8(snapshot).expect("snapshot should be utf8");

        assert!(snapshot_text.contains("hello from vt100"));
    }
}
