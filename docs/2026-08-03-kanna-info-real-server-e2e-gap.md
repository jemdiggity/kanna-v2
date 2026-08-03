# `kanna_info` real-server E2E gap (2026-08-03)

`kanna_info` crosses the MCP stdio process → HTTP client → `kanna-server`
status route boundary. This change covers the executable MCP boundary with a
real `kanna-mcp` subprocess and a real HTTP socket fixture, including exact
configured non-default ports, staging/production identity, unreachable status,
and redaction. The shared catalog sanitizer and the `kanna-cli info` executable
path have separate process-level coverage. Existing
`crates/kanna-server/tests/status_build_identity_http.rs` launches real staging
and production server processes and pins the authoritative `/v1/status`
contract.

There is not yet one automated test that launches both sibling Cargo binaries,
`kanna-server` and `kanna-mcp`, in the same lane. Cargo only provides
`CARGO_BIN_EXE_*` paths for binaries in the package whose integration test is
running; making either crate's test discover a sibling package artifact would
couple it to an incidental `.build/` layout or duplicate the repository's
process orchestration. The narrower tests therefore prove both sides of the
HTTP contract without pretending the mock status server is the final
client/server E2E.

Close this gap by adding a `kd` E2E lane that builds both sidecars into a
build-private output directory, starts `kanna-server` with isolated config,
database, daemon directory, and reserved ports, invokes `kanna_info` through
the real `kanna-mcp` stdio protocol, and asserts that the server's configured
environment/version and the MCP process's exact configured base URL survive
the complete round trip. That lane must run for both staging and production
fixtures and retain the redaction assertions.
