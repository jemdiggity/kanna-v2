use kanna_terminal_recovery::protocol::{RecoveryCommand, RecoveryResponse};
use kanna_terminal_recovery::service::RecoveryService;
use kanna_terminal_recovery::snapshot_store::SnapshotStore;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::Duration;

struct PermanentlyFailedControlChannel {
    reads: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl Read for PermanentlyFailedControlChannel {
    fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "daemon control channel is gone",
        ))
    }
}

#[test]
fn failed_control_channel_is_read_once_before_service_exits() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let input = PermanentlyFailedControlChannel {
        reads: reads.clone(),
    };
    let mut service = RecoveryService::new(SnapshotStore::new(tempdir.path()));

    let error = service
        .run(input, Vec::<u8>::new())
        .expect_err("a failed daemon channel should stop the helper");

    assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(error.to_string().contains("daemon control channel is gone"));
}

#[test]
fn write_output_keeps_live_snapshot_in_memory_until_flush() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let store = SnapshotStore::new(tempdir.path());
    let mut service = RecoveryService::new_with_persist_debounce_ms(store.clone(), u64::MAX);

    let started = service.handle_command(RecoveryCommand::StartSession {
        session_id: "session-1".to_string(),
        cols: 80,
        rows: 24,
        resume_from_disk: false,
    });
    assert!(matches!(started, RecoveryResponse::Ok));

    let wrote = service.handle_command(RecoveryCommand::WriteOutput {
        session_id: "session-1".to_string(),
        data: b"prompt> ".to_vec(),
        sequence: 1,
    });
    assert!(matches!(wrote, RecoveryResponse::Ok));

    let persisted = store
        .read("session-1")
        .expect("snapshot store read should succeed");
    assert!(
        persisted.is_none(),
        "live writes should not persist immediately"
    );

    let live_snapshot = service.handle_command(RecoveryCommand::GetSnapshot {
        session_id: "session-1".to_string(),
    });
    match live_snapshot {
        RecoveryResponse::Snapshot {
            serialized,
            sequence,
            ..
        } => {
            assert!(serialized.contains("prompt> "));
            assert_eq!(sequence, 1);
        }
        other => panic!("expected live snapshot response, got {:?}", other),
    }

    let flushed = service.handle_command(RecoveryCommand::FlushAndShutdown);
    assert!(matches!(flushed, RecoveryResponse::Ok));

    let persisted = store
        .require("session-1")
        .expect("flush should persist the pending snapshot");
    assert!(persisted.serialized.contains("prompt> "));
    assert_eq!(persisted.sequence, 1);
}

#[test]
fn service_persists_dirty_snapshots_after_debounce_without_followup_commands() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let store = SnapshotStore::new(tempdir.path());
    let (input_reader, mut input_writer) =
        UnixStream::pair().expect("input stream pair should exist");
    let (output_reader, output_writer) =
        UnixStream::pair().expect("output stream pair should exist");

    let service_thread = thread::spawn(move || {
        let mut service = RecoveryService::new_with_persist_debounce_ms(store, 25);
        service
            .run(input_reader, output_writer)
            .expect("service run should succeed");
    });

    let mut output_reader = BufReader::new(
        output_reader
            .try_clone()
            .expect("output clone should succeed"),
    );
    input_writer
        .write_all(b"{\"type\":\"StartSession\",\"sessionId\":\"session-1\",\"cols\":80,\"rows\":24,\"resumeFromDisk\":false}\n")
        .expect("start session command should write");
    input_writer
        .write_all(b"{\"type\":\"WriteOutput\",\"sessionId\":\"session-1\",\"data\":[112,114,111,109,112,116,62,32],\"sequence\":1}\n")
        .expect("write output command should write");
    input_writer.flush().expect("commands should flush");

    let mut response = String::new();
    output_reader
        .read_line(&mut response)
        .expect("start session response should read");
    assert!(response.contains("\"type\":\"Ok\""));

    thread::sleep(Duration::from_millis(100));

    let persisted = SnapshotStore::new(tempdir.path())
        .require("session-1")
        .expect("debounce timer should persist snapshot");
    assert!(persisted.serialized.contains("prompt> "));
    assert_eq!(persisted.sequence, 1);

    input_writer
        .write_all(b"{\"type\":\"FlushAndShutdown\"}\n")
        .expect("shutdown command should write");
    input_writer.flush().expect("shutdown command should flush");

    response.clear();
    output_reader
        .read_line(&mut response)
        .expect("shutdown response should read");
    assert!(response.contains("\"type\":\"Ok\""));

    service_thread.join().expect("service thread should exit");
}

#[test]
fn default_debounce_does_not_persist_within_three_seconds() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let store = SnapshotStore::new(tempdir.path());
    let (input_reader, mut input_writer) =
        UnixStream::pair().expect("input stream pair should exist");
    let (output_reader, output_writer) =
        UnixStream::pair().expect("output stream pair should exist");

    let service_thread = thread::spawn(move || {
        let mut service = RecoveryService::new(store);
        service
            .run(input_reader, output_writer)
            .expect("service run should succeed");
    });

    let mut output_reader = BufReader::new(output_reader);
    input_writer
        .write_all(b"{\"type\":\"StartSession\",\"sessionId\":\"session-1\",\"cols\":80,\"rows\":24,\"resumeFromDisk\":false}\n")
        .expect("start session command should write");
    input_writer
        .write_all(b"{\"type\":\"WriteOutput\",\"sessionId\":\"session-1\",\"data\":[112,114,111,109,112,116,62,32],\"sequence\":1}\n")
        .expect("write output command should write");
    input_writer.flush().expect("commands should flush");

    let mut response = String::new();
    output_reader
        .read_line(&mut response)
        .expect("start session response should read");

    thread::sleep(Duration::from_secs(3));

    let persisted = SnapshotStore::new(tempdir.path())
        .read("session-1")
        .expect("snapshot lookup should succeed");
    assert!(
        persisted.is_none(),
        "default debounce should not persist this quickly"
    );

    input_writer
        .write_all(b"{\"type\":\"FlushAndShutdown\"}\n")
        .expect("shutdown command should write");
    input_writer.flush().expect("shutdown command should flush");

    response.clear();
    output_reader
        .read_line(&mut response)
        .expect("shutdown response should read");
    assert!(response.contains("\"type\":\"Ok\""));

    service_thread.join().expect("service thread should exit");
}

#[test]
fn write_output_does_not_emit_protocol_response_line() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let store = SnapshotStore::new(tempdir.path());
    let (input_reader, mut input_writer) =
        UnixStream::pair().expect("input stream pair should exist");
    let (output_reader, output_writer) =
        UnixStream::pair().expect("output stream pair should exist");

    let service_thread = thread::spawn(move || {
        let mut service = RecoveryService::new_with_persist_debounce_ms(store, u64::MAX);
        service
            .run(input_reader, output_writer)
            .expect("service run should succeed");
    });

    let output_stream = output_reader
        .try_clone()
        .expect("output clone should succeed");
    output_stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("read timeout should set");
    let mut output_reader = BufReader::new(output_stream);

    input_writer
        .write_all(b"{\"type\":\"StartSession\",\"sessionId\":\"session-1\",\"cols\":80,\"rows\":24,\"resumeFromDisk\":false}\n")
        .expect("start session command should write");
    input_writer.flush().expect("start session should flush");

    let mut response = String::new();
    output_reader
        .read_line(&mut response)
        .expect("start session response should read");
    assert!(response.contains("\"type\":\"Ok\""));

    input_writer
        .write_all(b"{\"type\":\"WriteOutput\",\"sessionId\":\"session-1\",\"data\":[112,114,111,109,112,116,62,32],\"sequence\":1}\n")
        .expect("write output command should write");
    input_writer
        .flush()
        .expect("write output command should flush");

    response.clear();
    let read = output_reader.read_line(&mut response);
    let error = read.expect_err("write output should not emit a response");
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);

    input_writer
        .write_all(b"{\"type\":\"GetSnapshot\",\"sessionId\":\"session-1\"}\n")
        .expect("snapshot command should write");
    input_writer.flush().expect("snapshot command should flush");

    response.clear();
    output_reader
        .read_line(&mut response)
        .expect("snapshot response should read");
    assert!(response.contains("\"type\":\"Snapshot\""));
    assert!(response.contains("prompt> "));

    input_writer
        .write_all(b"{\"type\":\"FlushAndShutdown\"}\n")
        .expect("shutdown command should write");
    input_writer.flush().expect("shutdown command should flush");

    response.clear();
    output_reader
        .read_line(&mut response)
        .expect("shutdown response should read");
    assert!(response.contains("\"type\":\"Ok\""));

    service_thread.join().expect("service thread should exit");
}
