# Relay Scaling Plan — 10 / 100 / 1,000 / 10,000 Users

Status: architecture plan (task `5ded9d27`, 2026-08-20). Analysis and a staged
plan only — each stage is meant to be turned into implementation tasks when its
entry gate approaches. All GCP prices are us-central1 list prices as of
2026-08; re-verify against the live pricing pages before committing spend.

## Verified baseline (2026-08-20)

Confirmed by source inspection in this worktree.

- **One always-on e2-micro VM per environment** (2 shared vCPU with 0.25 vCPU
  sustained baseline, 1 GB RAM, 30 GB pd-standard, static IPv4), created by
  `kd cloud deploy` — machine type hardcoded at
  `tools/kd/src/runtime/cloud-deploy.ts:276`, provisioning in
  `services/relay/deploy/provision.sh`. Caddy (Let's Encrypt) + the Node relay
  in docker-compose (`services/relay/deploy/docker-compose.yml`); image via
  Cloud Build → Artifact Registry, deploy = `docker compose pull && up -d` on
  the VM (`docs/relay-vm-operations.md`). No autoscaling, no load balancer, no
  CDN, no Cloud Logging agent, no resource limits or `ulimits` in compose.
  Firebase Functions deploy zero functions by design.
- **Everything flows through this one VM and one Node process:**
  - ksp tunnels streaming live PTY/agent/companion frames mobile↔desktop.
    Frames are base64-in-JSON (`crates/kanna-server/src/ksp.rs:600`), ~1.4×
    raw-byte overhead. The router forwards tunnel frames without parsing them
    but buffers up to **64 MiB per tunnel** with 32/16 MiB pause/resume water
    marks (`services/relay/src/router.ts:71-73`). Task-transfer tunnels get a
    tighter 1 MiB cap (512/256 KiB marks).
  - Desktop↔desktop task-transfer tunnels and desktop-to-desktop invokes.
  - OTA: the manifest **and every OTA asset byte**. `findAsset` in
    `services/relay/src/ota.ts:508-518` does a **bucket-wide `getFiles` list
    per asset request** and downloads the whole asset into relay RAM before
    serving it (already with `Cache-Control: immutable` — but nothing caches
    in front of the VM).
  - Push registration and FCM sends; Firestore task publication
    (`services/relay/src/cloudTaskPublication.ts` — 512 KiB snapshot cap, ≤250
    tasks, full task-collection read + reconcile per publication, all inside
    the desktop's control-connection message handler).
  - Non-tunnel control messages (including `observe_session` terminal event
    fan-out) are `JSON.parse`d per message on the single event loop
    (`router.ts:585`).
- **Client URL contract:** desktops read `relay_url` from `server.toml`
  (`crates/kanna-server/src/config.rs`); mobile bakes one `relayUrl` per
  environment in `apps/mobile/src/mobileEnvironments.json` (JS config —
  OTA-updatable, but the OTA endpoint itself lives at that same relay URL, so
  a relay move must keep the old origin serving OTA until the fleet updates).
  Desktops reconnect on a fixed 5 s loop (`relay.rs`); the relay closes all
  sockets with 1012 on shutdown and clients reconnect.
- **In-flight efficiency levers treated as landed baseline** (not yet on this
  branch): per-user byte odometer (task `2afa6564`), diff-aware task
  publication (task `28dbd45b`), desktopCredentials auth cache +
  perMessageDeflate (task `058e51d5`). The 2026-08-20 cost analysis put a
  typical active user at ~$5–6/mo pre-levers (dominated by Firestore write
  amplification from full-snapshot reconciles) and **<$1/mo post-levers**.
- **Billing context** (`docs/specs/accounts-and-billing.md`): ~$10/mo "Kanna
  Cloud" subscription, relay-enforced entitlements, LAN free forever. Today
  the relay serves every authenticated account unconditionally.

### Traffic model used for the arithmetic below

Assumptions, stated so the numbers can be re-derived and corrected:

- "N users" = N paying accounts. Concurrency model per N: **~1.0 N desktop
  control connections** (the desktop app keeps its relay socket whenever
  running), **~0.3 N phone control connections**, **~0.15 N live ksp tunnels**
  actually streaming at a given time (each tunnel = 2 relay sockets).
  Connection total ≈ 1.6 N sockets.
- A streaming PTY tunnel averages **5–10 KB/s** on the wire (keystrokes are
  ~200 B frames; TUI redraw bursts are 2–100 KB/s), post-base64/JSON overhead,
  pre-compression. perMessageDeflate roughly halves ANSI-heavy text.
- Per-user relayed volume **~1–3 GB/mo** (consistent with the <$1/user
  post-lever estimate). Relay internet egress ≈ 1× the phone-bound stream.
- OTA update ≈ 10 MB (Hermes bundle + assets); every online phone fetches
  within hours of a publish.

## Stage 1 — 10 users (today's architecture)

### What breaks first

Nothing structural. Margins: ~16 sockets, ~2 tunnels streaming ≤20 KB/s —
noise against even 0.25 sustained vCPU and the NIC. The real risks are
**RAM cliffs, not averages**, and they exist today at any user count:

- 1 GB RAM minus OS (~150 MB), Node baseline (~80 MB), Caddy (~40 MB) leaves
  ~700 MB. The ksp tunnel cap is 64 MiB *per tunnel*: **five or six tunnels
  with a stalled phone-side reader can OOM the VM** (5 × 64 MiB = 320 MiB in
  `bufferedAmount` plus heap churn). The cap is per-tunnel with no global
  budget.
- One OTA publish makes every phone fetch ~10 MB through Node with full-asset
  buffering and a bucket-wide list per asset request — at 10 users this is a
  blip (10 phones × ~15 assets = 150 list ops), but it is the same code that
  falls over at Stage 2.
- Single VM restart on deploy = full outage; all clients auto-reconnect in
  ≤~10 s. Acceptable at this stage.

### Minimal change

None required for capacity. Two cheap hardening items worth doing now because
they are code-only and remove the cliffs:

1. **Global tunnel-buffer budget**: cap total `bufferedAmount` across all
   tunnels (e.g. 256 MiB) in `router.ts`, closing the worst offender at the
   cap instead of letting per-tunnel 64 MiB caps stack past RAM.
2. **OTA asset index**: at publish time write an `assets.json`
   (key → object path + contentType) per update, so `findAsset` does one JSON
   read instead of a bucket-wide list. This is a prerequisite for the Stage 2
   CDN split anyway (content-addressed direct URLs need the same index).

### Operability gate (to *enter* Stage 2)

- **Observability**: extend `/health` (already reports connection count +
  tunnel flow stats) into a scrapeable metrics payload: connections by role,
  tunnel count, total/`top-k` `bufferedAmount`, RSS, event-loop lag, and
  per-user odometer totals. Install the Ops Agent (or ship docker logs to
  Cloud Logging) — today a crashed relay leaves logs only on the VM.
  Alert on: VM down, mem >80%, cert renewal failure, restart loops.
- **Byte odometer rollups** (task `2afa6564`) landing in a queryable place
  (Firestore rollup docs or BigQuery export) — this is the input for every
  cost sanity check below.
- **Load test**: none required yet; build the harness (Stage 2 gate) early if
  convenient.

### Cost

~$11/mo per environment: e2-micro ~$6.1 + 30 GB pd-standard ~$1.2 + static
IPv4 ~$3.7. Variable costs at 10 users ≈ $5–10/mo total (post-lever <$1/user).
**~$1.5–2/user/mo all-in against a $10 subscription.**

## Stage 2 — 100 users

### What breaks first

**RAM on the 1 GB e2-micro, via burst behavior — not averages.**

- Sockets: ~160 connections. With perMessageDeflate, zlib contexts cost
  ~150–300 KB per active compression pair → 25–50 MB; socket + `ws` overhead
  ~100 KB each → ~16 MB. Fine on its own.
- Tunnels: ~15 concurrent streams. Worst-case buffered bytes 15 × 64 MiB =
  960 MiB — **over the whole VM's RAM**. A handful of phones on bad cellular
  links during a busy evening is enough; this stops being a tail risk and
  becomes weekly.
- OTA: 100 phones × ~10 MB within an hour of a publish = 1 GB pushed through
  Node full-asset buffers + ~1,500 bucket-list operations, on the same event
  loop as live tunnels. This is the clearest "shared fate" failure: an OTA
  release degrades live PTY streaming.
- CPU second: 0.25 sustained vCPU handles ~15 streams × 10 KB/s (~150 KB/s
  TLS + forwarding) easily; bursts ride the 2-vCPU burst budget. Not the
  binding constraint yet.

### Minimal change

1. **Vertical resize** to **e2-small** (2 GB, ~$12.2/mo) or **e2-medium**
   (4 GB, ~$24.5/mo). Recommend e2-medium: the extra $12 buys headroom for
   every burst scenario above and pushes the next forced move to Stage 3.
   One-line change in `cloud-deploy.ts` + a stop/start (brief outage,
   acceptable here).
2. **Split OTA assets off the relay** — the cheapest big win. Assets are
   immutable and already carry immutable cache headers:
   - Publisher writes assets to GCS under content-addressed names + the
     per-update asset index (Stage 1 item).
   - `buildAssetUrl` (`ota.ts:571`) points at the bucket origin instead of
     `/ota/assets` — either direct
     `https://storage.googleapis.com/<bucket>/...` public objects (no new
     infra; GCS egress ~$0.12/GB) or a CDN-fronted backend bucket
     (external ALB ~$18/mo + CDN egress ~$0.08/GB) once volume justifies it.
     **Recommend direct GCS at this stage, CDN at Stage 3+.**
   - The signed manifest stays on the relay (small, cheap, needs the signing
     key). Old clients keep working: `/ota/assets` remains as a fallback path
     until fleet telemetry shows it idle.
3. **Entitlement enforcement lands before or during this stage** (per
   `docs/specs/accounts-and-billing.md`): at 100 users the relay must stop
   serving every authenticated account unconditionally, or free riders set
   the cost baseline.

Explicitly *not* yet: multiple relays, load balancers, managed platforms.

### Operability gate (to enter Stage 3)

- Metrics from Stage 1 gate flowing into Cloud Monitoring dashboards with
  alerting; reconnect-storm visibility (connects/sec).
- **Load-test harness exists and passes at 2× Stage 2**: a Node script
  driving M desktop-role + M phone-role sockets against staging (desktop
  credentials provisioned in staging Firestore), establishing ksp tunnels and
  replaying recorded PTY frame-size distributions (200 B keystrokes, 2–8 KB
  redraw bursts, occasional 100 KB/s streams). Pass = 250 connections /
  40 tunnels for 1 h with p99 forward latency <150 ms, no pause/cap events at
  rest, RSS stable.
- Deploy story: still compose-restart full outage, now **health-gated and
  off-peak** (deploy script curls `/health`, watches reconnect completion).
  Acceptable because reconnect ≤10 s and sessions survive on the desktop.
- `ulimits` (nofile) pinned explicitly in compose — don't discover a host
  default at Stage 3.

### Cost

Baseline ~$30/mo (e2-medium + disk + IP + ~$1 GCS/OTA). Variable: 100 ×
<$1 ≈ $50–100/mo. **~$1/user/mo against $10.**

## Stage 3 — 1,000 users

### What breaks first

Three things arrive together; none is "the NIC":

1. **Availability, not capacity.** ~1,600 connections and ~150 live streams ×
   10 KB/s ≈ 1.5 MB/s ≈ 12 Mbps — trivially within one bigger VM's NIC and
   CPU. But a compose-restart now drops 1,600 paying connections at once, and
   the reconnect stampede (1,600 TLS handshakes + Firestore
   `desktopCredentials` verifications within ~10 s — the auth cache helps
   only warm entries) hammers the freshly started process. A single VM is
   also a single failure domain for every paying user. **This is the stage
   where "one VM, restart to deploy" stops being acceptable.**
2. **RAM arithmetic gets real**: 1,600 sockets × ~100 KB + ~1,600
   perMessageDeflate contexts × ~200 KB ≈ 480 MB, plus a 256 MiB tunnel
   budget, plus heap headroom → needs ≥4 GB dedicated, i.e. past e2-medium.
3. **Firestore publication traffic**: 1,000 desktops publishing on task
   change. Post-diff-aware this is bounded, but the *desktop doc* (generation
   claim) is written on every publication — the sustained 1 write/sec/doc
   guidance means client-side coalescing must be verified under load, and
   aggregate bursts (deploys reconnect everyone → everyone republishes)
   need the load test to include a full-fleet reconnect.

### Minimal change

**Two relay instances with drain-capable deploys.** Two viable shapes:

- **Option A (recommended): 2 shards + client-side routing** (design below).
  Each shard is one VM (e2-standard-2, 2 vCPU/8 GB, ~$49/mo) with its own
  DNS name and IP. Deploys roll one shard at a time; half the fleet
  reconnects, the other half never notices. This does the routing work at
  1,000 users that Stage 4 requires anyway, while the blast radius of getting
  it wrong is small.
- **Option B: active/standby blue-green behind one IP** (passthrough NLB
  ~$18/mo + $0.008/GB, or IP re-pointing): keeps the single-URL contract,
  defers all client changes — but buys nothing toward Stage 4 and still
  reconnects the whole fleet on every deploy. Choose only if Stage 4 looks
  >12 months away.

Cloud Run is rejected at this stage: 60-minute request timeout forcibly
recycles every WebSocket hourly, and best-effort session affinity cannot
express "phone must land on its desktop's instance". GKE solves deploys but
imports cluster operations for a two-instance problem. Both stay on the table
for Stage 4 as owner decisions.

### Routing/sharding design (the once-there-is-more-than-one-relay contract)

The invariant: **a phone (or peer desktop) must reach the control connection
of the desktop it addresses, and tunnel peers must meet on the same
instance.** The design keeps relays stateless and puts routing in clients:

- **Roster**: a small `relayRoster` document (Firestore, admin-written;
  mirrored as JSON at a stable HTTPS URL for pre-auth fetch) listing shard
  origins (`wss://relay-0.kanna.build`, `relay-1`, …), health, and a
  generation number. `relay.kanna.build` stays alive as shard 0's alias for
  legacy clients.
- **Assignment**: desktops pick their shard by **rendezvous (HRW) hash of
  desktopId over healthy roster entries** — no coordinator, deterministic,
  minimal reshuffle when a shard joins/leaves. On control connect, the relay
  writes a `desktopRelay/{desktopId} → {shardOrigin, updatedAt}` discovery
  record (admin SDK, owner-readable in rules).
- **Lookup**: phones resolve each paired desktopId via the discovery record
  (they already read Firestore), falling back to the hash if the record is
  stale. Phones open **one control connection per shard hosting at least one
  of their desktops** (multi-desktop accounts may hold 2; the common case
  stays 1). Desktop→desktop invokes and task-transfer likewise: the source
  desktop resolves the target's shard and dials a secondary control
  connection there. **No relay-to-relay backplane** — a mesh would make
  relays stateful, add a hop to every frame, and exists only to preserve
  "one socket reaches all desktops", which clients can handle.
- **Rejected: LB sticky routing** as the primary mechanism. GCP ALB affinity
  keys (cookie/client-IP) cannot express cross-principal rendezvous; a
  ring-hash-on-desktopId Envoy tier could, but that is running a bespoke
  routing proxy to avoid a modest client change, and the phone connection
  multiplexes several desktopIds anyway.
- **Reconnect / drain / deploy**: to drain a shard, mark it draining in the
  roster (generation bump), let the relay close with 1012; clients re-fetch
  the roster and re-resolve. In steady state a shard's replacement comes up
  on the same origin (blue-green per shard), so re-resolution is a no-op and
  the existing 5 s reconnect loop suffices. ksp tunnels die and re-establish
  automatically; task-transfer tunnels abort and resume through the existing
  destination-restart resume path.
- **Version skew**: ship roster/discovery support in desktop + mobile
  **during Stage 2** (mobile is OTA-deliverable JS; desktop rides the normal
  update train), well before a second shard exists. Legacy clients that never
  update keep hitting `relay.kanna.build` = shard 0, which therefore must
  keep serving un-sharded traffic (and OTA manifests) for the deprecation
  window. A desktop whose hash says shard 1 but whose phone is legacy still
  works: the phone's lookup happens via Firestore/roster only in new
  clients — so **the cutover rule is: no desktop moves off shard 0 until its
  account's phones are roster-capable** (relay can see client capabilities in
  the auth handshake and report the fleet mix).

### Operability gate (to enter Stage 4)

- Per-shard dashboards (connections, tunnels, buffered bytes, event-loop
  lag, egress) + SLO alerting on connect success rate and stream latency.
- Load test at 2× Stage 3: 2,500 connections / 400 tunnels sustained 1 h,
  **including a rolling shard deploy under load and a full-fleet reconnect**
  (kill one shard; measure time-to-restore and auth-path behavior).
- Runbook: shard drain, shard replace, roster rollback; `docs/` runbook
  updated from `relay-vm-operations.md`.
- Odometer rollups reconciled monthly against GCP billing (egress) and
  Firestore usage — the per-user variable cost claim below must be
  re-measured, not assumed.

### Cost

Baseline: 2 × e2-standard-2 ≈ $98 + disks/IPs ~$10 + CDN/ALB for OTA ~$20 ≈
**~$130/mo**. Variable: 1,000 × ~$0.3–1 (egress ~$0.12/GB × 1–3 GB + Firestore
post-lever) ≈ $300–1,000/mo. **Total ~$0.4–1.1/user/mo against $10.**

## Stage 4 — 10,000 users

### What breaks first

**The single Node event loop and per-instance RAM — i.e. the shard count,
not the architecture, if Stage 3's design landed.**

- ~16,000 sockets, ~1,500 live streams ≈ 15 MB/s ≈ 120 Mbps sustained
  (bursts higher) and tens of thousands of small frames/sec. One Node
  process at ~16 k sockets with deflate contexts (~16 k × 200 KB ≈ 3.2 GB)
  and JSON parsing on every control message is past comfortable headroom for
  a single instance — GC pauses become visible as stream latency.
- Per-shard comfort target: **≤2,500 connections / ≤400 streaming tunnels**
  (validated by the Stage 3 load test, revised by real telemetry). 10 k users
  → **6–8 shards** of e2-standard-2 (or 4 × e2-standard-4 at ~$98 each if
  fewer, larger shards test better).
- Firestore: aggregate publication write rate (10 k desktops × post-lever
  rates ≈ low hundreds of writes/sec sustained, bursts on reconnect waves)
  is within Firestore's documented scaling, but reconnect waves must be
  jittered client-side (add jitter to the fixed 5 s loop) or a shard deploy
  produces synchronized republish spikes.
- OTA: 10 k phones × 10 MB = 100 GB per release — a non-event on CDN
  (~$8), a severe event if any of it still transits relay VMs. The Stage 2
  split must be complete (legacy `/ota/assets` path retired).
- Egress cost, not bandwidth, is the dominant variable: 10–30 TB/mo ≈
  $1.2–3.6 k/mo at ~$0.12/GB.

### Minimal change

Scale the Stage 3 design out: 6–8 shards, managed instance group or plain
VMs per shard with blue-green deploys, roster-driven. Add:

- **Connection jitter + backoff** in desktop and mobile reconnect paths.
- **Capacity automation**: shard add/remove is a roster edit + HRW property
  (only ~1/N of desktops re-home). Keep it operator-triggered; autoscaling
  WebSocket fleets on connection count is an owner decision, not a default.
- Re-evaluate **GKE Autopilot** (or Cloud Run if its WebSocket timeout story
  has improved) purely as an ops-burden trade: the sharding/roster design is
  platform-independent, so a migration moves the same containers behind the
  same origins. **Owner decision — not required by the arithmetic.**
- Multi-region: nothing in the 10 k arithmetic forces it; it is a
  latency/product decision (APAC users currently ride us-central1).
  **Owner decision; out of scope here.**

### Operability gate

- Load test at 25 k connections / 4 k tunnels across shards, including
  one-shard failure (kill −1 shard; verify re-home ≤ 1/N of fleet and
  time-to-restore) and an OTA release under load.
- On-call rotation or at minimum paging alerts; per-shard capacity dashboard
  driving the "add a shard" runbook.
- Monthly cost-per-user report from odometer + billing export, compared to
  the subscription price.

### Cost

Baseline: 7 × e2-standard-2 ≈ $343 + disks/IPs ~$35 + ALB/CDN ~$30 ≈
**~$400–900/mo** depending on shard sizing. Variable: 10,000 × $0.3–1 ≈
$3–10 k/mo, dominated by egress. **Total ~$0.35–1.1/user/mo against $10** —
margin holds if and only if the per-user levers (diff-aware publication,
compression, odometer-verified egress) hold; that is what the recurring
cost report is for.

## Cost summary

| Stage | Infra baseline /mo | Per-user variable /mo | All-in per user |
| --- | --- | --- | --- |
| 10 | ~$11 (e2-micro, disk, IP) | <$1 | ~$1.5–2 |
| 100 | ~$30 (e2-medium + OTA on GCS) | <$1 | ~$1 |
| 1,000 | ~$130 (2 × e2-standard-2, CDN) | ~$0.3–1 | ~$0.4–1.1 |
| 10,000 | ~$400–900 (6–8 shards, LB/CDN) | ~$0.3–1 | ~$0.35–1.1 |

Staging stays one e2-micro at every stage (~$11/mo).

## Decisions that need the owner

- **Stage 2**: entitlement-enforcement timing (couples to the billing spec
  launch); OTA asset domain (bare `storage.googleapis.com` vs a
  `kanna.build` CDN hostname).
- **Stage 3**: spend step to ~$130/mo baseline; Option A (2 shards, client
  routing work now) vs Option B (blue-green, defer clients); shard hostname
  scheme (`relay-{n}.kanna.build`) and the legacy-client deprecation window.
- **Stage 4**: spend step to ~$0.5–1 k/mo baseline; managed-platform (GKE)
  migration; multi-region; any autoscaling.

## Sequencing summary (what to implement, when)

1. **Now / Stage 1 hardening**: global tunnel-buffer budget; OTA asset
   index; metrics endpoint + Cloud Logging/Monitoring; odometer rollups.
2. **Stage 2**: e2-medium resize; OTA assets to GCS; entitlement
   enforcement; load-test harness; compose `ulimits`; **ship roster/discovery
   client support** (dormant, single-entry roster).
3. **Stage 3**: second shard + discovery records live; per-shard blue-green
   drain deploys; reconnect jitter; runbooks.
4. **Stage 4**: shard fleet to 6–8; capacity automation runbook; platform
   re-evaluation.

## E2E coverage expectation for the implementation stages

Per the repo's E2E convention, the cross-boundary behaviors introduced above
must land with end-to-end coverage when implemented, or a dated
`docs/YYYY-MM-DD-<topic>-e2e-gap.md` note where not yet testable:

- Roster/discovery routing: a two-relay `tests/` fixture proving phone →
  correct shard resolution, cross-shard desktop→desktop dial, and
  re-resolution after a drain (extends the existing relay E2E harness that
  `KANNA_E2E_RELAY_SHUTDOWN_TOKEN` in `services/relay/src/index.ts` serves).
- Tunnel-buffer global budget: relay unit/integration test driving a stalled
  reader past the budget (extend `router.ts` flow-state test hooks).
- OTA CDN split: mobile-side E2E that a manifest from the relay + assets
  from the bucket origin produce a working update, plus legacy-path fallback.
- Drain/deploy: load-test-harness scenario, recorded as a repeatable script
  under `tools/` or `tests/`, not a manual runbook step.
