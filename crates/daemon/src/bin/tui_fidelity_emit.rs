use std::{env, fs, path::PathBuf};

use base64::Engine;
use kanna_agent_protocol::frames::ServerFrame;
use kanna_daemon::headless_terminal::HeadlessTerminal;
use serde::Serialize;

const DEFAULT_COLS: u16 = 220;
const DEFAULT_ROWS: u16 = 48;
const DEFAULT_TASK_ID: &str = "tui-fidelity";
const DEFAULT_CHUNK_PATTERN: &[usize] = &[7, 1, 13, 2, 31];

#[derive(Debug, Serialize)]
struct Emission {
    fixture: String,
    cols: u16,
    rows: u16,
    snapshot_at: usize,
    resnapshot_at: Option<usize>,
    used_visible_text_fallback: bool,
    frames: Vec<ServerFrame>,
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = parse_args(env::args().skip(1))?;
    let bytes = fs::read(&config.fixture_path)?;
    let fixture = config.fixture_path.to_string_lossy().into_owned();
    let emitted = emit_fixture_with_snapshot_at(
        &fixture,
        &bytes,
        config.cols,
        config.rows,
        config.snapshot_at.unwrap_or(0),
        config.resnapshot_at,
        &config.chunk_pattern,
    )?;
    let json = serde_json::to_string_pretty(&emitted)?;
    if let Some(output_path) = config.output_path {
        fs::write(output_path, json)?;
    } else {
        println!("{json}");
    }
    Ok(())
}

struct CliConfig {
    fixture_path: PathBuf,
    output_path: Option<PathBuf>,
    cols: u16,
    rows: u16,
    snapshot_at: Option<usize>,
    resnapshot_at: Option<usize>,
    chunk_pattern: Vec<usize>,
}

fn parse_args<I>(args: I) -> Result<CliConfig, Box<dyn std::error::Error + Send + Sync>>
where
    I: IntoIterator<Item = String>,
{
    let mut fixture_path = None;
    let mut output_path = None;
    let mut cols = DEFAULT_COLS;
    let mut rows = DEFAULT_ROWS;
    let mut snapshot_at = None;
    let mut resnapshot_at = None;
    let mut chunk_pattern = DEFAULT_CHUNK_PATTERN.to_vec();
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cols" => cols = parse_next(&mut args, "--cols")?,
            "--rows" => rows = parse_next(&mut args, "--rows")?,
            "--snapshot-at" => snapshot_at = Some(parse_next(&mut args, "--snapshot-at")?),
            "--resnapshot-at" => resnapshot_at = Some(parse_next(&mut args, "--resnapshot-at")?),
            "--chunk-pattern" => {
                let value: String = parse_next(&mut args, "--chunk-pattern")?;
                chunk_pattern = parse_chunk_pattern(&value)?;
            }
            "--output" => {
                let value: String = parse_next(&mut args, "--output")?;
                output_path = Some(PathBuf::from(value));
            }
            "--help" | "-h" => return Err(usage().into()),
            _ if arg.starts_with('-') => return Err(format!("unknown option: {arg}").into()),
            _ if fixture_path.is_none() => fixture_path = Some(PathBuf::from(arg)),
            _ => return Err(format!("unexpected positional argument: {arg}").into()),
        }
    }

    let Some(fixture_path) = fixture_path else {
        return Err(usage().into());
    };

    Ok(CliConfig {
        fixture_path,
        output_path,
        cols,
        rows,
        snapshot_at,
        resnapshot_at,
        chunk_pattern,
    })
}

fn parse_next<T, I>(args: &mut I, flag: &str) -> Result<T, Box<dyn std::error::Error + Send + Sync>>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
    I: Iterator<Item = String>,
{
    let Some(value) = args.next() else {
        return Err(format!("missing value for {flag}").into());
    };
    Ok(value.parse::<T>()?)
}

fn parse_chunk_pattern(
    value: &str,
) -> Result<Vec<usize>, Box<dyn std::error::Error + Send + Sync>> {
    let mut pattern = Vec::new();
    for raw in value.split(',') {
        let size = raw.trim().parse::<usize>()?;
        if size == 0 {
            return Err("chunk pattern entries must be greater than zero".into());
        }
        pattern.push(size);
    }
    if pattern.is_empty() {
        return Err("chunk pattern must not be empty".into());
    }
    Ok(pattern)
}

fn usage() -> String {
    "usage: tui-fidelity-emit [--cols N] [--rows N] [--snapshot-at N] [--resnapshot-at N] [--chunk-pattern 7,1,13] [--output PATH] FIXTURE".to_string()
}

fn emit_fixture_with_snapshot_at(
    fixture: &str,
    bytes: &[u8],
    cols: u16,
    rows: u16,
    snapshot_at: usize,
    resnapshot_at: Option<usize>,
    pattern: &[usize],
) -> Result<Emission, Box<dyn std::error::Error + Send + Sync>> {
    let snapshot_at = snapshot_at.min(bytes.len());
    let resnapshot_at = resnapshot_at
        .map(|offset| offset.min(bytes.len()))
        .filter(|offset| *offset > snapshot_at);
    let mut terminal = HeadlessTerminal::new(cols, rows, 10_000)?;
    terminal.write(&bytes[..snapshot_at]);
    let snapshot = terminal.snapshot_with_metadata()?;
    let mut used_visible_text_fallback = snapshot.used_visible_text_fallback;

    let mut frames = vec![ServerFrame::TermSnapshot {
        task_id: DEFAULT_TASK_ID.to_string(),
        cols: snapshot.snapshot.cols,
        rows: snapshot.snapshot.rows,
        data_b64: b64(snapshot.snapshot.vt.as_bytes()),
        agent_provider: None,
        // The fidelity harness replays a whole terminal, never a bounded
        // remote window.
        stream_id: None,
        stream_offset: None,
        history_id: None,
        scrollback_lines: None,
    }];
    let first_output_end = resnapshot_at.unwrap_or(bytes.len());
    for chunk in split_chunks(&bytes[snapshot_at..first_output_end], pattern) {
        terminal.write(&chunk);
        frames.push(ServerFrame::TermOutput {
            task_id: DEFAULT_TASK_ID.to_string(),
            data_b64: b64(&chunk),
        });
    }
    if let Some(resnapshot_at) = resnapshot_at {
        let resnapshot = terminal.snapshot_with_metadata()?;
        used_visible_text_fallback |= resnapshot.used_visible_text_fallback;
        frames.push(ServerFrame::TermSnapshot {
            task_id: DEFAULT_TASK_ID.to_string(),
            cols: resnapshot.snapshot.cols,
            rows: resnapshot.snapshot.rows,
            data_b64: b64(resnapshot.snapshot.vt.as_bytes()),
            agent_provider: None,
            stream_id: None,
            stream_offset: None,
            history_id: None,
            scrollback_lines: None,
        });
        for chunk in split_chunks(&bytes[resnapshot_at..], pattern) {
            frames.push(ServerFrame::TermOutput {
                task_id: DEFAULT_TASK_ID.to_string(),
                data_b64: b64(&chunk),
            });
        }
    }

    Ok(Emission {
        fixture: fixture.to_string(),
        cols,
        rows,
        snapshot_at,
        resnapshot_at,
        used_visible_text_fallback,
        frames,
    })
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn split_chunks(bytes: &[u8], pattern: &[usize]) -> Vec<Vec<u8>> {
    if bytes.is_empty() {
        return Vec::new();
    }

    let pattern = if pattern.is_empty() {
        &[bytes.len()]
    } else {
        pattern
    };
    let mut chunks = Vec::new();
    let mut offset = 0;
    let mut pattern_index = 0;
    while offset < bytes.len() {
        let requested = pattern[pattern_index % pattern.len()].max(1);
        let next = (offset + requested).min(bytes.len());
        chunks.push(bytes[offset..next].to_vec());
        offset = next;
        pattern_index += 1;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use kanna_agent_protocol::frames::ServerFrame;

    #[test]
    fn splits_bytes_with_repeating_chunk_pattern() {
        let chunks = super::split_chunks(b"abcdefghijkl", &[3, 1, 4]);

        assert_eq!(
            chunks,
            vec![
                b"abc".to_vec(),
                b"d".to_vec(),
                b"efgh".to_vec(),
                b"ijk".to_vec(),
                b"l".to_vec()
            ]
        );
    }

    #[test]
    fn emits_snapshot_then_chunked_ksp_output_frames() {
        let emitted =
            super::emit_fixture_with_snapshot_at("fixture.bin", b"hello", 80, 24, 1, None, &[2, 3])
                .unwrap();

        assert_eq!(emitted.fixture, "fixture.bin");
        assert_eq!(emitted.cols, 80);
        assert_eq!(emitted.rows, 24);
        assert_eq!(emitted.snapshot_at, 1);
        assert!(!emitted.used_visible_text_fallback);
        assert_eq!(emitted.frames.len(), 3);
        assert!(matches!(
            emitted.frames[0],
            ServerFrame::TermSnapshot { .. }
        ));
        assert_eq!(
            emitted.frames[1],
            ServerFrame::TermOutput {
                task_id: "tui-fidelity".to_string(),
                data_b64: "ZWw=".to_string(),
            }
        );
        assert_eq!(
            emitted.frames[2],
            ServerFrame::TermOutput {
                task_id: "tui-fidelity".to_string(),
                data_b64: "bG8=".to_string(),
            }
        );
    }

    #[test]
    fn emits_a_second_authoritative_snapshot_after_intervening_output() {
        let emitted = super::emit_fixture_with_snapshot_at(
            "fixture.bin",
            b"initial-live-tail",
            80,
            24,
            7,
            Some(12),
            &[5],
        )
        .unwrap();

        assert_eq!(emitted.resnapshot_at, Some(12));
        assert_eq!(emitted.frames.len(), 4);
        assert!(matches!(
            emitted.frames[0],
            ServerFrame::TermSnapshot { .. }
        ));
        assert_eq!(
            emitted.frames[1],
            ServerFrame::TermOutput {
                task_id: "tui-fidelity".to_string(),
                data_b64: "LWxpdmU=".to_string(),
            }
        );
        assert!(matches!(
            emitted.frames[2],
            ServerFrame::TermSnapshot { .. }
        ));
        assert_eq!(
            emitted.frames[3],
            ServerFrame::TermOutput {
                task_id: "tui-fidelity".to_string(),
                data_b64: "LXRhaWw=".to_string(),
            }
        );
    }
}
