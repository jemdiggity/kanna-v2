# LAN authorization second-host E2E gap

Task c9f5721b hardens every HTTP route behind pairing by default. This session
has no provisioned second-host runner targeting this worktree's isolated
server. The running staging instance was not probed or modified. A same-host
request to a non-loopback interface proves the server's real TCP peer handling,
but does not prove a second host can reach the listener through LAN/firewall
configuration.

Narrower coverage accompanies this note: production-router enumeration checks
every registered path and HTTP method against missing/invalid LAN credentials;
paired and loopback route fixtures exercise data reads and mutations, and real
TCP tests probe settings/repository routes on an ephemeral worktree-test
listener. KSP tests check both stream versions reject unpaired authentication
and accept paired authentication; a paused-clock test also proves that task-state
broadcasts cannot precede authentication. Bootstrap/status and mobile pairing, transport,
and cloud-fallback tests remain in the normal suites.

To close the gap, provision the remote-e2e LAN layer's second host against an
isolated server built from this branch. From that host, request
`GET /v1/settings/lan-auth-canary` and `GET /v1/repos` without credentials and
assert identical 401 text without canary values. Create/claim pairing on the
test instance, repeat with its device headers and assert successful reads,
then revoke trust and repeat the refusal checks. Keep the server port, DB,
pairing file, and daemon isolated; never target staging/production for this test.
