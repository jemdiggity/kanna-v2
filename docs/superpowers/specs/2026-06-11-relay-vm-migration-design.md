# Relay VM Migration — Design

**Date:** 2026-06-11
**Status:** Approved
**Goal:** Move the `kanna-relay` WebSocket service off Cloud Run onto a free-tier e2-micro GCE VM, and retire the staging Cloud Run relay. Reduces ~$60/mo (production) + ~$40/mo (staging) of always-on Cloud Run cost to ~$0–4/mo.

## Background

The relay holds long-lived WebSocket connections from every running desktop (`kanna-server` maintains a permanent connection with a 5s reconnect loop, `crates/kanna-server/src/main.rs`). Cloud Run bills request-based services for the full duration a request is in flight, and a WebSocket is one long request — so a single online desktop keeps one full instance (1 vCPU / 512 MiB) billing 24/7. Measured billable instance time: ~1.0 instance-sec/sec in `kanna-build`, ~0.67 in `kanna-staging`.

An always-on single-instance WebSocket hub is the workload Cloud Run prices worst and a VM prices best. The e2-micro free tier (us-central1) covers it.

## Architecture

```
phone ──wss://relay.kanna.build──┐
                                 ▼
                       [kanna-relay-vm: e2-micro, us-central1, Debian 12]
                       Caddy (:80/:443, automatic Let's Encrypt)
                                 │ reverse_proxy
                                 ▼
                       relay container (:8080) ← existing image, unchanged
                                 │
desktop ──wss://relay.kanna.build┘      Firestore (ADC via metadata server)
```

- **Hostname:** `relay.kanna.build`. A record at the user's DNS provider → static IPv4. DNS is managed outside GCP (no Cloud DNS zones exist); the record is added manually once the static IP is provisioned.
- **VM:** `kanna-relay-vm`, e2-micro, Debian 12, 30 GB standard PD, us-central1, in project `kanna-build`. Free tier. Static external IPv4 (worst case ~$4/mo if the free-tier IP exemption doesn't apply — accepted).
- **TLS:** Caddy with automatic Let's Encrypt issuance/renewal for `relay.kanna.build`. Caddy proxies WebSocket upgrades natively. No cert maintenance.
- **Relay service:** code, Dockerfile, and `cloudbuild.yaml` unchanged. Image built via `gcloud builds submit` to Artifact Registry (us-central1 — same-region pulls are free), run via Docker Compose with `FIREBASE_PROJECT_ID=kanna-build`.
- **Credentials:** dedicated service account on the VM with `roles/datastore.user` (Firestore) and `roles/artifactregistry.reader` (image pulls). `firebase-admin` picks up Application Default Credentials from the metadata server — zero relay code changes.
- **Firewall:** allow tcp:80,443 to the VM (tag `kanna-relay`). SSH via standard `gcloud compute ssh` (IAP/OS Login defaults).
- **Resilience:** `restart: always` on both compose services; VM auto-restarts on host maintenance; Caddy auto-renews certs. Single instance — same availability profile as today's `maxScale: 1`.

## Repo changes

| Path | Change |
|---|---|
| `services/relay/deploy/compose.yaml` | New — caddy + relay services, restart policies, env |
| `services/relay/deploy/Caddyfile` | New — `relay.kanna.build` site, `reverse_proxy relay:8080` |
| `services/relay/deploy/provision.sh` | New — one-time: enable APIs, create SA + IAM bindings, static IP, firewall rule, VM with startup script (installs Docker, writes compose stack, `docker compose up -d`) |
| `tools/kd/src/runtime/cloud-deploy.ts` | `--relay` production path: keep `gcloud builds submit` step; replace `gcloud run deploy` with: `gcloud compute scp` the `services/relay/deploy/` files to the VM (so Caddyfile/compose changes ship with deploys, repo stays the source of truth), then `gcloud compute ssh kanna-relay-vm -- docker compose pull && docker compose up -d`. `--staging --relay` becomes an explicit error: "staging relay is retired; use the local relay via emulators". New one-time `kd cloud relay provision` command wrapping `provision.sh`. |
| `apps/desktop/src-tauri/src/commands/mobile.rs:438` | `PRODUCTION_RELAY_URL` → `wss://relay.kanna.build` (and the test at `:1390`) |
| `apps/desktop/src/services/desktopRelayTerminal.ts:4` | `PRODUCTION_CLOUD_TRANSPORT_URL` → `wss://relay.kanna.build` |
| `apps/mobile/src/appModel.ts:32` | `PRODUCTION_RELAY_URL` → `wss://relay.kanna.build` |

## Staging teardown

- Delete the `kanna-relay` Cloud Run service from `kanna-staging` (`gcloud run services delete kanna-relay --project kanna-staging --region us-central1`).
- `createpairingcode` (staging and production) stays — Cloud Functions bill $0 when idle.
- `kd cloud deploy --staging --relay` errors so the staging relay can't silently come back.
- Dev desktops currently pointing at the staging relay will sit in their 5s reconnect loop afterward — harmless; dev should use the local relay (`ws://127.0.0.1:18080`).

## Cutover plan (hard cutover, same day — sole user is the maintainer)

1. Run `kd cloud relay provision` → VM, SA, static IP, firewall created. Note the IP.
2. Add the A record `relay.kanna.build → <static IP>` at the DNS provider; wait for propagation.
3. `kd cloud deploy --production --relay` → image built, VM pulls and starts the stack. Caddy obtains the cert on first request.
4. Verify: `curl https://relay.kanna.build/health` returns connection count; wss smoke test (desktop connects, phone pairs, terminal roundtrip).
5. Land the client URL changes; rebuild desktop + mobile; full phone↔desktop E2E against the VM.
6. Delete `kanna-relay` from `kanna-build` and `kanna-staging`.

Rollback during cutover: the Cloud Run services are not deleted until step 6, so reverting the URL constants restores the old path at any earlier step.

## Error handling

- **VM reboot / host maintenance:** compose `restart: always` + VM auto-restart bring the stack back without intervention; clients reconnect via the existing 5s loop.
- **Cert issuance failure:** Caddy retries with backoff; `/health` over plain HTTP on :80 stays available for diagnosis.
- **Image pull failure during deploy:** `docker compose pull` failing leaves the running stack untouched (pull-then-up ordering); deploy command surfaces the error.
- **IP change:** static IP, so none expected. If the IP is ever released, re-provisioning and a DNS update recover it; clients need no change (hostname-based).

## Testing

- **Relay unit tests:** unchanged — relay code is untouched.
- **kd deploy tests:** unit tests for the new command construction (production → ssh deploy, staging → error) alongside the existing `cloud-deploy` tests.
- **Compose smoke test (local):** `docker compose up` of the deploy stack with Caddy's internal CA to validate the Caddyfile proxies WebSocket upgrades to the relay container.
- **E2E gap (documented per repo E2E policy):** true end-to-end against a real VM with public DNS and Let's Encrypt is not CI-able — it requires live GCP resources, DNS control, and ACME rate-limit exposure. What would make it testable: an ephemeral GCP project with delegated DNS and a staging ACME endpoint, driven from CI. Until then, the manual cutover checklist (steps 4–5 above) is the end-to-end verification, plus the narrower tests listed.

## Out of scope

- Gating the desktop's relay connection on having paired devices (separate cost/efficiency improvement — the always-open connection is fine on a flat-cost VM).
- Staging relay replacement (local relay via emulators covers dev).
- Multi-instance/high-availability relay.
