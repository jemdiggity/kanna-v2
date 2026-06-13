# Multi-Environment (dev / staging / prod) — relay VM + kd tooling design

**Date:** 2026-06-13
**Status:** Design notes; kd-tooling implementation forked to a Kanna codex task.

## Goal

Sign-in and data flow must work across **dev (Firebase emulator + local relay), staging, and production**, over **both cloud (relay) and LAN** transports, with a **force-cloud override** for testing. This doc captures the confirmed environment identities and the relay/kd plan. The desktop/mobile app-side env model (per-env bundle IDs, `app.config.ts`, force-cloud flag) is a separate follow-up; THIS doc + the forked task cover the kd tool + relay infra.

## Confirmed environment identities (2026-06-13)

| Env | Firebase project | iOS bundle ID | Relay |
|---|---|---|---|
| dev | `kanna-local` (emulator) | `build.kanna.app.dev` | local `services/relay` with Firebase Auth/Firestore emulators and committed seeded test users via `kd dev up --emulators` |
| staging | `kanna-staging` | `build.kanna.app.staging` | **to provision** — VM `relay-staging.kanna.build` (mirror of prod) |
| production | `kanna-build` | `build.kanna.app` | GCE VM `relay.kanna.build` → `34.133.233.111` (live) |

- Staging iOS Firebase config committed at `apps/mobile/firebase/GoogleService-Info.staging.plist`; prod at `apps/mobile/firebase/GoogleService-Info.production.plist`.
- A stray `kanna-1f32f` plist exists in a download folder — unrelated/stale, ignore.

## Relay reality vs tooling (important)

- **Live prod relay is the GCE VM** (`relay.kanna.build` → `34.133.233.111`, Caddy TLS, Docker Compose, project `kanna-build`, us-central1-a). It escaped Cloud Run's ~$100/mo (a permanent WebSocket is one long billable request).
- **kd tooling is stale:** `tools/kd` `cloud-deploy.ts deployRelayCloud` still deploys the relay to **Cloud Run** (`gcloud run deploy`), and there is **no `relay-provision` command** and **no committed Caddyfile / docker-compose / startup script**. The prod VM was stood up by manual ops.
- Reusing the prod relay for staging is impossible: the relay verifies desktop secrets against the project's Firestore desktops collection-group, so a `kanna-staging`-authed desktop fails against the prod relay (which checks `kanna-build`). Staging needs its own relay.

## Staging relay plan (VM mirror of prod — decided)

1. Reserve a static IP in GCP project `kanna-staging` (or wherever the operator chooses).
2. Operator adds DNS: `relay-staging.kanna.build` **A** → `<reserved IP>` (GoDaddy; the value is only known after step 1).
3. Provision an e2-micro VM (us-central1-a), Docker + Caddy (Let's Encrypt for `relay-staging.kanna.build` — needs DNS resolving first), deploy the `services/relay` container configured for `kanna-staging` Firebase (real auth/Firestore, `NODE_ENV=production`, staging service-account credential).
4. Apps in staging point at `wss://relay-staging.kanna.build` via the env model.

The DNS record value (the IP) is gated on step 1; nothing can be added at GoDaddy until the IP is reserved.

## kd tooling requirements (forked task)

Build the missing/parameterized kd automation so relay provisioning + deploy is reproducible per environment, matching the VM reality:

- **Env→identity registry** (single source of truth in kd): `dev|staging|prod` → Firebase project id (`kanna-local`/`kanna-staging`/`kanna-build`), relay URL/domain, GCE VM name, iOS bundle id. Replace the prod-hardcoded scatter.
- **`kd cloud relay-provision --staging|--production`**: reserve static IP, create the e2-micro VM, firewall, startup script (Docker + Caddy). Commit the Caddyfile, docker-compose, and startup-script templates (currently absent). Parameterize domain + Firebase project per env.
- **`kd cloud deploy --staging|--production --relay`** retargeted to the **VM model** (ssh/scp compose + `docker compose up`, or container pull) instead of Cloud Run — or clearly support both with the VM as the default to match prod.
- **`kd mobile up --staging`**: currently throws (`cli.ts`); wire it to export `KANNA_APP_ENV=staging` + the staging Firebase + `EXPO_PUBLIC_KANNA_RELAY_URL=wss://relay-staging.kanna.build`.
- **Env export for desktop/server** staging: `KANNA_CLOUD_ENV=staging` → `kanna-staging` project + staging relay URL + staging identity.
- **No live execution in the task**: build + unit-test the command construction (mirror existing `dev-plan.test.ts` patterns); do NOT run billable gcloud, do NOT touch DNS, do NOT deploy. Produce an operator runbook (reserve IP → DNS A record → provision → deploy → wire apps).

## Out of scope here (follow-ups)

- App-side per-env model: convert `app.json` → `app.config.ts` keyed on `KANNA_APP_ENV` (bundle id, name, scheme, `googleServicesFile`, `EXPO_PUBLIC_FIREBASE_*`, relay URL).
- `KANNA_FORCE_CLOUD` override in `appModel.createClientForMode` + hidden dev toggle.
- Mobile cloud E2E (force-cloud, assert relay data flow).
