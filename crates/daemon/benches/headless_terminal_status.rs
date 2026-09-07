use criterion::{black_box, criterion_group, criterion_main, Criterion};
use kanna_daemon::bench::transcript::{BenchmarkMode, BenchmarkProvider, TranscriptSpec};
use kanna_daemon::detection::Classifier;
use kanna_daemon::headless_terminal::HeadlessTerminal;
use kanna_daemon::protocol::AgentProvider;

fn provider_to_agent(provider: BenchmarkProvider) -> AgentProvider {
    match provider {
        BenchmarkProvider::Codex => AgentProvider::Codex,
        BenchmarkProvider::Claude => AgentProvider::Claude,
        BenchmarkProvider::Copilot => AgentProvider::Copilot,
    }
}

fn bench_headless_terminal_status(c: &mut Criterion) {
    let mut group = c.benchmark_group("headless_terminal_status");

    for provider in [
        BenchmarkProvider::Codex,
        BenchmarkProvider::Claude,
        BenchmarkProvider::Copilot,
    ] {
        for mode in [BenchmarkMode::Steady, BenchmarkMode::WorstCase] {
            let transcript = TranscriptSpec::new(provider, mode).build();
            let case_name = format!("{provider:?}_{mode:?}");

            group.bench_function(format!("{case_name}/write_only"), |b| {
                b.iter(|| {
                    let mut headless_terminal = HeadlessTerminal::new(120, 40, 10_000).unwrap();
                    for chunk in &transcript.chunks {
                        headless_terminal.write(black_box(&chunk.bytes));
                    }
                });
            });

            group.bench_function(format!("{case_name}/write_plus_status"), |b| {
                b.iter(|| {
                    let mut classifier = Classifier::new(Some(provider_to_agent(provider)));
                    let mut headless_terminal = HeadlessTerminal::new(120, 40, 10_000).unwrap();
                    let status_checks = transcript.status_check_points_ms(500);
                    let mut next_status_check = status_checks.iter();
                    let mut scheduled_at = next_status_check.next().copied();
                    for chunk in &transcript.chunks {
                        headless_terminal.write(black_box(&chunk.bytes));
                        if Some(chunk.at_ms) == scheduled_at {
                            let _ = headless_terminal.visible_status(&mut classifier).unwrap();
                            scheduled_at = next_status_check.next().copied();
                        }
                    }
                });
            });
        }
    }

    group.finish();
}

criterion_group!(benches, bench_headless_terminal_status);
criterion_main!(benches);
