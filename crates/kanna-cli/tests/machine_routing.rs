use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;

fn read_request(stream: &mut TcpStream) -> (String, Option<Value>) {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("read request");
        assert_ne!(read, 0, "client closed before headers");
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).expect("utf8 headers");
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().expect("content length"))
        })
        .unwrap_or(0);
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).expect("read request body");
        assert_ne!(read, 0, "client closed before body");
        bytes.extend_from_slice(&buffer[..read]);
    }
    let body = (content_length > 0).then(|| {
        serde_json::from_slice(&bytes[header_end..header_end + content_length])
            .expect("json request body")
    });
    (
        headers.lines().next().expect("request line").to_string(),
        body,
    )
}

fn write_json(stream: &mut TcpStream, body: Value) {
    let body = body.to_string();
    stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(), body
            )
            .as_bytes(),
        )
        .expect("write response");
}

#[test]
fn machine_list_calls_the_catalog_discovery_route() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept discovery");
        let (request, body) = read_request(&mut stream);
        assert!(request.starts_with("GET /v1/cloud/desktops HTTP/1.1"));
        assert!(body.is_none());
        write_json(
            &mut stream,
            json!({
                "currentMachineId": "desktop-local",
                "relayAvailable": true,
                "machines": [{ "id": "desktop-local", "isLocal": true }]
            }),
        );
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "machine",
            "list",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .expect("run machine list");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("fixture server");
    let result: Value = serde_json::from_slice(&output.stdout).expect("machine JSON");
    assert_eq!(result["currentMachineId"], "desktop-local");
}

#[test]
fn tool_call_machine_id_routes_remote_requests_through_the_local_proxy() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || {
        let (mut status_stream, _) = listener.accept().expect("accept identity");
        let (request, _) = read_request(&mut status_stream);
        assert!(request.starts_with("GET /v1/status HTTP/1.1"));
        write_json(&mut status_stream, json!({ "desktopId": "desktop-local" }));

        let (mut proxy_stream, _) = listener.accept().expect("accept proxy");
        let (request, body) = read_request(&mut proxy_stream);
        assert!(request.starts_with("POST /v1/cloud/desktops/desktop-studio/invoke HTTP/1.1"));
        assert_eq!(
            body,
            Some(json!({
                "method": "GET",
                "path": "/v1/repos",
                "body": null
            }))
        );
        write_json(
            &mut proxy_stream,
            json!({ "status": 200, "body": [{ "id": "repo-remote" }], "error": null }),
        );
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "tool",
            "call",
            "kanna_list_repos",
            "--machine-id",
            "desktop-studio",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .expect("run routed tool call");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("fixture server");
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).expect("repo JSON"),
        json!([{ "id": "repo-remote" }])
    );
}

#[test]
fn explicit_self_machine_id_stays_local_when_the_relay_is_unavailable() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || {
        let (mut status_stream, _) = listener.accept().expect("accept identity");
        let (request, _) = read_request(&mut status_stream);
        assert!(request.starts_with("GET /v1/status HTTP/1.1"));
        write_json(&mut status_stream, json!({ "desktopId": "desktop-local" }));

        let (mut repo_stream, _) = listener.accept().expect("accept local repo list");
        let (request, body) = read_request(&mut repo_stream);
        assert!(request.starts_with("GET /v1/repos HTTP/1.1"));
        assert!(body.is_none());
        write_json(&mut repo_stream, json!([{ "id": "repo-local" }]));
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "tool",
            "call",
            "kanna_list_repos",
            "--machine-id",
            "desktop-local",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .expect("run explicit-self tool call");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("fixture server");
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).expect("repo JSON"),
        json!([{ "id": "repo-local" }])
    );
}
