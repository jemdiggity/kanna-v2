# Relay VM Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the `kanna-relay` WebSocket service from Cloud Run to a free-tier e2-micro GCE VM behind Caddy TLS at `wss://relay.kanna.build`, and retire both Cloud Run relay services.

**Architecture:** The existing relay Docker image (unchanged) runs via Docker Compose on a Debian 12 e2-micro VM in `kanna-build`/us-central1, fronted by Caddy with automatic Let's Encrypt. `kd cloud deploy --production --relay` keeps building the image via Cloud Build, then scp's the deploy stack and ssh-runs `docker compose pull && up -d`. Staging relay deploys become a hard error. Spec: `docs/superpowers/specs/2026-06-11-relay-vm-migration-design.md`.

**Tech Stack:** GCE (gcloud CLI), Docker Compose, Caddy 2, Cloud Build/Artifact Registry (gcr.io), TypeScript (kd, vitest), Rust (one constant + test).

---

### Task 1: Relay VM deploy stack files

**Goal:** Add the Compose stack, Caddyfile, and on-VM deploy script that run the relay behind Caddy TLS.

**Files:**
- Create: `services/relay/deploy/compose.yaml`
- Create: `services/relay/deploy/Caddyfile`
- Create: `services/relay/deploy/vm-deploy.sh`

**Acceptance Criteria:**
- [ ] `docker compose -f services/relay/deploy/compose.yaml config` parses without error
- [ ] `bash -n services/relay/deploy/vm-deploy.sh` exits 0
- [ ] Caddyfile serves `relay.kanna.build` and proxies to `relay:8080`

**Verify:** `docker compose -f services/relay/deploy/compose.yaml config --quiet && bash -n services/relay/deploy/vm-deploy.sh && echo OK` → `OK`

**Steps:**

- [ ] **Step 1: Write `services/relay/deploy/compose.yaml`**

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

  relay:
    image: gcr.io/kanna-build/kanna-relay:latest
    restart: always
    environment:
      FIREBASE_PROJECT_ID: kanna-build
    expose:
      - "8080"

volumes:
  caddy-data:
  caddy-config:
```

- [ ] **Step 2: Write `services/relay/deploy/Caddyfile`**

```
relay.kanna.build {
	reverse_proxy relay:8080
}
```

(Caddy proxies WebSocket upgrades natively; no extra directives needed. `caddy-data` volume persists the Let's Encrypt cert across container restarts.)

- [ ] **Step 3: Write `services/relay/deploy/vm-deploy.sh`** (runs ON the VM as root via `gcloud compute ssh ... sudo bash vm-deploy.sh`)

```bash
#!/usr/bin/env bash
# Runs on kanna-relay-vm as root. Pulls the latest relay image and restarts the stack.
set -euo pipefail
cd "$(dirname "$0")"

# gcr.io pull auth: exchange the VM service account's metadata token for a docker login.
TOKEN=$(curl -fsS -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
echo "$TOKEN" | docker login -u oauth2accesstoken --password-stdin https://gcr.io

docker compose pull
docker compose up -d
docker image prune -f
docker compose ps
```

- [ ] **Step 4: Verify and commit**

Run: `docker compose -f services/relay/deploy/compose.yaml config --quiet && bash -n services/relay/deploy/vm-deploy.sh && echo OK`
Expected: `OK`

```bash
git add services/relay/deploy/
git commit -m "feat(relay): add VM deploy stack (compose + caddy + vm-deploy)"
```

---

### Task 2: Provision script for the relay VM

**Goal:** One-time idempotent script that creates the service account, static IP, firewall rule, and e2-micro VM.

**Files:**
- Create: `services/relay/deploy/provision.sh`

**Acceptance Criteria:**
- [ ] `bash -n services/relay/deploy/provision.sh` exits 0
- [ ] Script is idempotent (every `create` tolerates already-exists)
- [ ] Script prints the static IP and the DNS instruction at the end

**Verify:** `bash -n services/relay/deploy/provision.sh && echo OK` → `OK`

**Steps:**

- [ ] **Step 1: Write `services/relay/deploy/provision.sh`**

```bash
#!/usr/bin/env bash
# One-time provisioning of the kanna-relay VM in kanna-build.
# Idempotent: safe to re-run; existing resources are kept.
set -euo pipefail

PROJECT="${KANNA_RELAY_PROJECT:-kanna-build}"
REGION="${KANNA_CLOUD_RUN_REGION:-us-central1}"
ZONE="${KANNA_RELAY_VM_ZONE:-us-central1-a}"
VM_NAME="${KANNA_RELAY_VM_NAME:-kanna-relay-vm}"
SA_ID="kanna-relay-vm"
SA="${SA_ID}@${PROJECT}.iam.gserviceaccount.com"

echo "==> Enabling Compute API"
gcloud services enable compute.googleapis.com --project "$PROJECT"

echo "==> Service account"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_ID" --project "$PROJECT" --display-name "Kanna relay VM"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/datastore.user --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/artifactregistry.reader --condition=None >/dev/null

echo "==> Static IP"
gcloud compute addresses describe kanna-relay-ip --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || gcloud compute addresses create kanna-relay-ip --project "$PROJECT" --region "$REGION"
IP=$(gcloud compute addresses describe kanna-relay-ip --project "$PROJECT" --region "$REGION" --format='value(address)')

echo "==> Firewall"
gcloud compute firewall-rules describe kanna-relay-allow-web --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute firewall-rules create kanna-relay-allow-web \
       --project "$PROJECT" --direction INGRESS --action ALLOW \
       --rules tcp:80,tcp:443 --target-tags kanna-relay --source-ranges 0.0.0.0/0

echo "==> VM"
gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1 \
  || gcloud compute instances create "$VM_NAME" \
       --project "$PROJECT" --zone "$ZONE" \
       --machine-type e2-micro \
       --image-family debian-12 --image-project debian-cloud \
       --boot-disk-size 30GB --boot-disk-type pd-standard \
       --address "$IP" \
       --tags kanna-relay \
       --service-account "$SA" \
       --scopes cloud-platform \
       --metadata startup-script='#!/bin/bash
set -e
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi'

echo ""
echo "Provisioned. Static IP: $IP"
echo "Next: add DNS A record  relay.kanna.build -> $IP  at your DNS provider,"
echo "then run: ./kd cloud deploy --production --relay"
```

- [ ] **Step 2: Make executable, verify, commit**

Run: `chmod +x services/relay/deploy/provision.sh services/relay/deploy/vm-deploy.sh && bash -n services/relay/deploy/provision.sh && echo OK`
Expected: `OK`

```bash
git add services/relay/deploy/provision.sh services/relay/deploy/vm-deploy.sh
git commit -m "feat(relay): add one-time VM provisioning script"
```

---

### Task 3: Retarget `kd cloud deploy --relay` to the VM, error on staging, add provision command

**Goal:** Production relay deploys go to the VM (scp + ssh); staging relay deploys error; `kd cloud relay-provision` wraps provision.sh. TDD against the existing mock-runner test pattern.

**Files:**
- Modify: `tools/kd/src/runtime/cloud-deploy.ts` (`deployRelayCloud`, `RelayDeployResult`)
- Modify: `tools/kd/src/tasks/registry.ts` (new `cloud.relay-provision` task, near `cloud.deploy` at ~line 729)
- Test: `tools/kd/tests/cloud-deploy.test.ts`

**Acceptance Criteria:**
- [ ] `deployRelayCloud` with `environment: "production"` runs, in order: relay build → `gcloud builds submit` (unchanged) → ssh `rm -rf ~/kanna-relay && mkdir -p ~/kanna-relay` (deterministic destination — avoids scp's exists/not-exists directory semantics) → scp the three deploy files into `~/kanna-relay/` → ssh `sudo bash ~/kanna-relay/vm-deploy.sh`
- [ ] `deployRelayCloud` with `environment: "staging"` rejects with "staging relay is retired"
- [ ] Result's `relayUrl` is `wss://relay.kanna.build` (overridable via `KANNA_RELAY_HOSTNAME`)
- [ ] `cloud.relay-provision` registry task executes `bash services/relay/deploy/provision.sh`
- [ ] `cd tools/kd && pnpm test` passes; `pnpm exec tsc --noEmit` clean

**Verify:** `cd tools/kd && pnpm exec tsc --noEmit && pnpm test -- cloud-deploy` → all tests pass

**Steps:**

- [ ] **Step 1: Rewrite the relay test cases in `tools/kd/tests/cloud-deploy.test.ts`**

Replace the existing `"deploys the relay to Cloud Run and returns the wss URL"` test with:

```typescript
  it("deploys the relay to the VM over scp+ssh and returns the hostname URL", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kd-cloud-deploy-"));
    const calls: Array<{ command: string; args: string[]; cwd?: string; streamOutput?: boolean }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({
          command,
          args,
          cwd: options?.cwd,
          ...(options?.streamOutput === undefined ? {} : { streamOutput: options.streamOutput })
        });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    try {
      const result = await deployRelayCloud({
        repoRoot,
        env: { KANNA_FIREBASE_PRODUCTION_PROJECT: "prod-project" },
        runner,
        environment: "production"
      });

      expect(result).toEqual({
        projectId: "prod-project",
        vmName: "kanna-relay-vm",
        zone: "us-central1-a",
        image: "gcr.io/prod-project/kanna-relay",
        relayUrl: "wss://relay.kanna.build"
      });
      expect(calls).toEqual([
        {
          command: "pnpm",
          args: ["--dir", "services/relay", "build"],
          cwd: repoRoot
        },
        {
          command: "gcloud",
          args: [
            "builds",
            "submit",
            ".",
            "--project",
            "prod-project",
            "--config",
            "services/relay/cloudbuild.yaml",
            "--substitutions",
            "_IMAGE=gcr.io/prod-project/kanna-relay"
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "ssh",
            "kanna-relay-vm",
            "--project",
            "prod-project",
            "--zone",
            "us-central1-a",
            "--command",
            "rm -rf ~/kanna-relay && mkdir -p ~/kanna-relay"
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "scp",
            "services/relay/deploy/compose.yaml",
            "services/relay/deploy/Caddyfile",
            "services/relay/deploy/vm-deploy.sh",
            "kanna-relay-vm:~/kanna-relay/",
            "--project",
            "prod-project",
            "--zone",
            "us-central1-a"
          ],
          cwd: repoRoot,
          streamOutput: true
        },
        {
          command: "gcloud",
          args: [
            "compute",
            "ssh",
            "kanna-relay-vm",
            "--project",
            "prod-project",
            "--zone",
            "us-central1-a",
            "--command",
            "sudo bash ~/kanna-relay/vm-deploy.sh"
          ],
          cwd: repoRoot,
          streamOutput: true
        }
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses staging relay deploys", async () => {
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      deployRelayCloud({
        repoRoot: "/repo",
        env: { KANNA_FIREBASE_STAGING_PROJECT: "kanna-staging" },
        runner,
        environment: "staging"
      })
    ).rejects.toThrow("staging relay is retired");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/kd && pnpm test -- cloud-deploy`
Expected: FAIL — `deployRelayCloud` still issues `gcloud run deploy` and accepts staging.

- [ ] **Step 3: Rewrite `deployRelayCloud` in `tools/kd/src/runtime/cloud-deploy.ts`**

Replace `RelayDeployResult` (lines 27–34) and `deployRelayCloud` (lines 129–223) with:

```typescript
export interface RelayDeployResult {
  projectId: string;
  vmName: string;
  zone: string;
  image: string;
  relayUrl: string;
}

export async function deployRelayCloud(input: CloudDeployInput): Promise<RelayDeployResult> {
  assertCloudDeployEnvironment(input.environment);
  if (input.environment === "staging") {
    throw new Error(
      "staging relay is retired; use the local relay via emulators (ws://127.0.0.1:18080)."
    );
  }

  const projectId = resolveFirebaseProject(input.repoRoot, input.env, input.environment);
  const vmName = input.env.KANNA_RELAY_VM_NAME?.trim() || "kanna-relay-vm";
  const zone = input.env.KANNA_RELAY_VM_ZONE?.trim() || "us-central1-a";
  const hostname = input.env.KANNA_RELAY_HOSTNAME?.trim() || "relay.kanna.build";
  const image = `gcr.io/${projectId}/kanna-relay`;

  const build = await input.runner.run("pnpm", ["--dir", "services/relay", "build"], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (build.exitCode !== 0) {
    throw new Error(build.stderr || build.stdout || "Relay build failed.");
  }

  const submit = await input.runner.run(
    "gcloud",
    [
      "builds",
      "submit",
      ".",
      "--project",
      projectId,
      "--config",
      "services/relay/cloudbuild.yaml",
      "--substitutions",
      `_IMAGE=${image}`
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (submit.exitCode !== 0) {
    throw new Error(submit.stderr || submit.stdout || "Relay Cloud Build submit failed.");
  }

  // Ship the deploy stack (compose.yaml, Caddyfile, vm-deploy.sh) so the repo
  // stays the source of truth for what runs on the VM. The destination is
  // recreated first: scp's directory semantics differ depending on whether
  // the destination already exists, so copy named files into a fresh dir.
  const prep = await input.runner.run(
    "gcloud",
    [
      "compute",
      "ssh",
      vmName,
      "--project",
      projectId,
      "--zone",
      zone,
      "--command",
      "rm -rf ~/kanna-relay && mkdir -p ~/kanna-relay"
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (prep.exitCode !== 0) {
    throw new Error(prep.stderr || prep.stdout || "Relay VM deploy-dir prep failed.");
  }

  const scp = await input.runner.run(
    "gcloud",
    [
      "compute",
      "scp",
      "services/relay/deploy/compose.yaml",
      "services/relay/deploy/Caddyfile",
      "services/relay/deploy/vm-deploy.sh",
      `${vmName}:~/kanna-relay/`,
      "--project",
      projectId,
      "--zone",
      zone
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (scp.exitCode !== 0) {
    throw new Error(scp.stderr || scp.stdout || "Relay deploy file transfer failed.");
  }

  const ssh = await input.runner.run(
    "gcloud",
    [
      "compute",
      "ssh",
      vmName,
      "--project",
      projectId,
      "--zone",
      zone,
      "--command",
      "sudo bash ~/kanna-relay/vm-deploy.sh"
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (ssh.exitCode !== 0) {
    throw new Error(ssh.stderr || ssh.stdout || "Relay VM deploy failed.");
  }

  return { projectId, vmName, zone, image, relayUrl: `wss://${hostname}` };
}
```

Note: `KANNA_RELAY_SERVICE_NAME` and the region-based Cloud Run path are gone; `KANNA_CLOUD_RUN_REGION` remains used only by provision.sh for the static IP region.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/kd && pnpm test -- cloud-deploy`
Expected: PASS (all tests, including the untouched Firebase-functions ones).

- [ ] **Step 5: Register `cloud.relay-provision` in `tools/kd/src/tasks/registry.ts`**

Add after the `cloud.deploy` task entry (~line 760):

```typescript
  {
    id: "cloud.relay-provision",
    description: "One-time provisioning of the kanna-relay VM (SA, static IP, firewall, e2-micro).",
    inputSchema: emptyInputSchema,
    execute: async () => {
      const context = await resolveDefaultContext(process.env);
      return runBuiltCommand(
        "bash",
        ["services/relay/deploy/provision.sh"],
        context.repoRoot,
        context.env
      );
    }
  },
```

(`emptyInputSchema`, `resolveDefaultContext`, and `runBuiltCommand` are already imported/defined in registry.ts — same pattern as `test.app-update-bundle`.)

- [ ] **Step 6: Full kd check and commit**

Run: `cd tools/kd && pnpm exec tsc --noEmit && pnpm test`
Expected: clean typecheck, all tests pass.

```bash
git add tools/kd/src/runtime/cloud-deploy.ts tools/kd/src/tasks/registry.ts tools/kd/tests/cloud-deploy.test.ts
git commit -m "feat(kd): deploy relay to GCE VM, retire staging relay, add relay-provision"
```

---

### Task 4: Point clients at wss://relay.kanna.build

**Goal:** Replace the hardcoded Cloud Run relay URL in all three clients (and the Rust test asserting it).

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mobile.rs:438` (`PRODUCTION_RELAY_URL`) and `:1390` (test assertion)
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts:4` (`PRODUCTION_CLOUD_TRANSPORT_URL`)
- Modify: `apps/mobile/src/appModel.ts:32` (`PRODUCTION_RELAY_URL`)

**Acceptance Criteria:**
- [ ] All three constants equal `wss://relay.kanna.build`
- [ ] `grep -rn "run.app" apps/ crates/ --include="*.rs" --include="*.ts"` finds no remaining relay URL references (excluding node_modules/.build)
- [ ] `cargo test relay_url` passes in `apps/desktop/src-tauri`
- [ ] `pnpm exec tsc --noEmit` clean in `apps/desktop` and `apps/mobile`

**Verify:** `cd apps/desktop/src-tauri && cargo test relay_url` → PASS, then `cd apps/desktop && pnpm exec tsc --noEmit && cd ../mobile && pnpm exec tsc --noEmit` → clean

**Steps:**

- [ ] **Step 1: Update the Rust test first (red)**

In `apps/desktop/src-tauri/src/commands/mobile.rs` (~line 1390), change the assertion:

```rust
        assert_eq!(
            super::relay_url_for_mode(false),
            "wss://relay.kanna.build"
        );
```

Run: `cd apps/desktop/src-tauri && cargo test relay_url`
Expected: FAIL — constant still points at Cloud Run.

- [ ] **Step 2: Update the three constants (green)**

`apps/desktop/src-tauri/src/commands/mobile.rs:438`:

```rust
const PRODUCTION_RELAY_URL: &str = "wss://relay.kanna.build";
```

`apps/desktop/src/services/desktopRelayTerminal.ts:4`:

```typescript
export const PRODUCTION_CLOUD_TRANSPORT_URL = "wss://relay.kanna.build";
```

`apps/mobile/src/appModel.ts:32`:

```typescript
const PRODUCTION_RELAY_URL = "wss://relay.kanna.build";
```

- [ ] **Step 3: Verify and commit**

Run: `cd apps/desktop/src-tauri && cargo test relay_url`
Expected: PASS

Run: `cd apps/desktop && pnpm exec tsc --noEmit && cd ../mobile && pnpm exec tsc --noEmit`
Expected: no errors

Run: `grep -rn "kanna-relay-402613185450" apps/ crates/ packages/ tools/ 2>/dev/null | grep -v node_modules | grep -v .build`
Expected: no output

```bash
git add apps/desktop/src-tauri/src/commands/mobile.rs apps/desktop/src/services/desktopRelayTerminal.ts apps/mobile/src/appModel.ts
git commit -m "feat: point production relay clients at wss://relay.kanna.build"
```

---

### Task 5: Cutover — provision, DNS, deploy, end-to-end verification

**Goal:** Stand up the VM, serve the relay at `wss://relay.kanna.build`, and prove phone↔desktop works end to end before any teardown.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:** none (operational; uses scripts from Tasks 1–3)

**Acceptance Criteria:**
- [ ] `./kd cloud relay-provision` completes and prints the static IP
- [ ] DNS A record `relay.kanna.build → <static IP>` added by the user and resolving (`dig +short relay.kanna.build` returns the IP)
- [ ] `./kd cloud deploy --production --relay` completes
- [ ] `curl -fsS https://relay.kanna.build/health` returns HTTP 200 with the connection-count JSON (proves DNS + Let's Encrypt cert + proxy + relay container)
- [ ] Desktop build with the new URL connects (relay `/health` connection count increases; desktop log shows relay connected, no 5s reconnect loop)
- [ ] Phone↔desktop end-to-end: mobile app pairs and a terminal roundtrip succeeds over the VM relay

**Verify:** `curl -fsS https://relay.kanna.build/health` → HTTP 200 JSON, plus the manual phone↔desktop roundtrip above

**Steps:**

- [ ] **Step 1: Provision** — run `./kd cloud relay-provision`; capture the printed static IP.
- [ ] **Step 2: DNS (user action)** — user adds A record `relay.kanna.build → <IP>` at the DNS provider; wait until `dig +short relay.kanna.build` returns the IP.
- [ ] **Step 3: Deploy** — run `./kd cloud deploy --production --relay` (requires clean git worktree; Tasks 1–4 must be committed).
- [ ] **Step 4: Health check** — `curl -fsS https://relay.kanna.build/health` → 200. First request may take ~5s while Caddy obtains the cert.
- [ ] **Step 5: E2E** — rebuild desktop + mobile from this branch (`./kd dev up --mobile`), pair the phone, run a terminal roundtrip. Capture the relay `/health` connection count before/after desktop connect.

```json:metadata
{"files": [], "verifyCommand": "curl -fsS https://relay.kanna.build/health", "acceptanceCriteria": ["provision completes and prints static IP", "dig +short relay.kanna.build returns the static IP", "kd cloud deploy --production --relay completes", "curl -fsS https://relay.kanna.build/health returns HTTP 200", "desktop connects: /health connection count increases", "phone-desktop terminal roundtrip succeeds over VM relay"], "userGate": true, "tags": ["user-gate"], "requireEvidenceTokens": [["before-connect", "count=0", "provisioned"], ["after-connect", "connected", "roundtrip"]]}
```

---

### Task 6: Tear down the Cloud Run relay services

**Goal:** Delete `kanna-relay` from both `kanna-build` and `kanna-staging` once the VM relay is verified, ending the always-on Cloud Run billing.

**Files:** none (operational)

**Acceptance Criteria:**
- [ ] `gcloud run services delete kanna-relay --project kanna-staging --region us-central1 --quiet` succeeds
- [ ] `gcloud run services delete kanna-relay --project kanna-build --region us-central1 --quiet` succeeds
- [ ] `gcloud run services list` for each project no longer shows `kanna-relay` (only `createpairingcode`, and `upserttasksnapshot` in production, remain)
- [ ] Phone↔desktop still works after deletion (re-run the Task 5 health check + a pairing roundtrip)

**Verify:** `gcloud run services list --project kanna-build --region us-central1 && gcloud run services list --project kanna-staging --region us-central1` → no `kanna-relay` rows; `curl -fsS https://relay.kanna.build/health` → 200

**Steps:**

- [ ] **Step 1: Delete staging relay**

Run: `gcloud run services delete kanna-relay --project kanna-staging --region us-central1 --quiet`
Expected: `Deleted service [kanna-relay]`

- [ ] **Step 2: Delete production relay**

Run: `gcloud run services delete kanna-relay --project kanna-build --region us-central1 --quiet`
Expected: `Deleted service [kanna-relay]`

- [ ] **Step 3: Confirm**

Run: `gcloud run services list --project kanna-build --region us-central1; gcloud run services list --project kanna-staging --region us-central1`
Expected: no `kanna-relay` row in either project.

Run: `curl -fsS https://relay.kanna.build/health`
Expected: HTTP 200 — VM relay unaffected.

---

## Rollback

Until Task 6 runs, the Cloud Run services still exist: reverting the Task 4 commit restores the old relay path at any point. After Task 6, rollback is `kd cloud deploy` on a revert of Task 3 (the old Cloud Run deploy code) — or simply re-running the old `gcloud run deploy` by hand; the image remains in the registry.

## E2E coverage note (per repo policy)

True CI end-to-end for this change requires live GCP resources, public DNS control, and ACME issuance — not CI-able today. What would make it testable: an ephemeral GCP project with delegated DNS and Let's Encrypt staging endpoint driven from CI. In the meantime: kd unit tests assert the exact deploy command sequence (Task 3), the compose/Caddyfile parse checks (Task 1), and the manual cutover checklist (Task 5) is the end-to-end verification with captured evidence.
