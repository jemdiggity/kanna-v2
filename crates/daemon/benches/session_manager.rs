use criterion::{black_box, criterion_group, criterion_main, BatchSize, Criterion};
use kanna_daemon::bench::transcript::{BenchmarkMode, BenchmarkProvider, TranscriptSpec};
use kanna_daemon::detection::Classifier;
use kanna_daemon::headless_terminal::{initial_session_status, HeadlessTerminal};
use kanna_daemon::protocol::{AgentProvider, SessionStatus};
use kanna_daemon::session::{replay_headless_terminal_for_benchmark, BenchmarkStatusState};
use std::time::Instant;

fn agent_provider(provider: BenchmarkProvider) -> AgentProvider {
    match provider {
        BenchmarkProvider::Codex => AgentProvider::Codex,
        BenchmarkProvider::Claude => AgentProvider::Claude,
        BenchmarkProvider::Copilot => AgentProvider::Copilot,
    }
}

struct ReplayState {
    started_at: Instant,
    headless_terminals: Vec<HeadlessTerminal>,
    statuses: Vec<BenchmarkStatusState>,
}

fn new_replay_state(provider: AgentProvider, sessions: usize) -> ReplayState {
    ReplayState {
        started_at: Instant::now(),
        headless_terminals: (0..sessions)
            .map(|_| HeadlessTerminal::new(120, 40, 10_000).unwrap())
            .collect(),
        statuses: (0..sessions)
            .map(|_| BenchmarkStatusState::new(initial_session_status(Some(provider))))
            .collect(),
    }
}

fn replay_case(provider: BenchmarkProvider, mode: BenchmarkMode, sessions: usize) {
    let transcript = TranscriptSpec::new(provider, mode).build();
    let provider = agent_provider(provider);
    let mut state = new_replay_state(provider, sessions);
    let mut classifier = Classifier::new(Some(provider));

    for chunk in &transcript.chunks {
        for index in 0..sessions {
            let changed = replay_headless_terminal_for_benchmark(
                &mut state.headless_terminals[index],
                &mut classifier,
                &mut state.statuses[index],
                state.started_at,
                chunk.at_ms,
                black_box(&chunk.bytes),
            )
            .unwrap();

            if let Some(next) = changed {
                state.statuses[index].status = next;
            }
        }
    }

    assert!(state.statuses.iter().all(|state| state.status_observed));
    assert!(state.statuses.iter().all(|status| {
        matches!(
            status.status,
            SessionStatus::Busy | SessionStatus::Idle | SessionStatus::Waiting
        )
    }));
}

fn bench_session_manager(c: &mut Criterion) {
    let mut group = c.benchmark_group("session_manager");

    for provider in [
        BenchmarkProvider::Codex,
        BenchmarkProvider::Claude,
        BenchmarkProvider::Copilot,
    ] {
        for mode in [BenchmarkMode::Steady, BenchmarkMode::WorstCase] {
            for session_count in [1_usize, 10_usize] {
                let case_name = format!("{provider:?}_{mode:?}_{session_count}sessions");
                group.bench_function(case_name, |b| {
                    b.iter_batched(
                        || (),
                        |_| replay_case(provider, mode, session_count),
                        BatchSize::SmallInput,
                    );
                });
            }
        }
    }

    group.finish();
}

criterion_group!(benches, bench_session_manager);
criterion_main!(benches);
