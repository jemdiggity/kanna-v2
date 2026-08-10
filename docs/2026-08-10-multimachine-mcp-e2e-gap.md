# Multi-machine agent routing: remaining full-E2E gap

The shipped path crosses four independently running components:

`kanna-mcp` → source `kanna-server` → relay → target `kanna-server`.

The CLI follows the same catalog and server bridge, substituting `kanna-cli`
for `kanna-mcp` at the first boundary.

The current remote-E2E harness boots one desktop server and a mobile-shaped
relay client. It cannot yet boot two desktop-authenticated `kanna-server`
instances under the same emulator account and then launch `kanna-mcp` against
one of them. Consequently, there is not yet one test that creates a task
through the MCP process and observes that task in the second server's SQLite
state.

That becomes testable when `tests/remote-e2e` can register two desktop
credentials for one test user and provide separate config, database, daemon,
and port roots for both server processes. The final test should call
`kanna_list_machines`, use the second id with `kanna_list_repos`, create a task
there, and verify both positive ownership (only the target DB changes) and the
offline-target failure path. It should then create one task on each desktop,
call `kanna_wait_events` once with both ids, emit events independently, and
verify aggregate-cursor resume across a relay reconnect.

Narrower coverage added meanwhile exercises every boundary and wire shape:

- `crates/kanna-mcp/tests/stdio_http.rs` drives the real MCP stdio process and
  verifies machine discovery plus remote task listing and creation proxy
  requests. It also gives one `kanna_wait_events` call a local and remote task,
  verifies owner discovery and concurrent native waits, and checks the remote
  event's `machineId` plus aggregate cursor.
- `crates/kanna-cli/tests/machine_routing.rs` drives the real CLI process and
  verifies machine discovery, remote proxy routing, and the explicit-self
  local path without relay discovery.
- The MCP stdio coverage also verifies that explicit self-reference remains
  local and that an aggregate cursor claiming a different local identity is
  rejected before task probing or relay routing.
- `kanna-server` HTTP tests verify the loopback-only bridge, request
  validation, and relay queue handoff.
- `kanna-server`'s relay-loop test performs a real WebSocket request/response
  round trip and verifies the targeted HTTP envelope.
- `services/relay/test/routerPresence.test.ts` uses real WebSocket pairs to
  verify same-account desktop-to-desktop routing and response isolation.
