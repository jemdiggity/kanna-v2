## Kanna Repository Test Requirements

In this repository, "the most relevant focused tests" is not enough. Before
passing review, run the full unit and integration suites and require them to
pass:

```bash
pnpm test                                        # all packages via turborepo
cd crates/daemon && cargo test -- --test-threads=1   # daemon integration tests
```

Also run the Rust server test suite when the branch touches Rust code:

```bash
cargo test -p kanna-server
```

If any suite fails for a reason introduced by the branch, request a revision
with the failing command and output in the prompt. Pre-existing failures on
the base branch are not the branch's fault, but say so explicitly in the
review summary.
