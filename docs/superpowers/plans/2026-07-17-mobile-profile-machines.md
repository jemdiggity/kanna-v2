# Mobile Profile and Machines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile profile drawer's conflicting connection controls with a dedicated, deduplicated Machines experience, automatic LAN/cloud routing, and signed-in-or-out QR/code pairing.

**Architecture:** Keep account identity in `AccountSheet`, derive a pure `MobileMachine` inventory from cloud descriptors plus local manual trust, and route every operation by target `desktopId`. Add a real single-use pairing claim to `kanna-server`; desktop renders its versioned payload as QR, while mobile discovers the matching Bonjour endpoint, claims it, and persists manual trust.

**Tech Stack:** React Native 0.86, Expo SDK 57, `expo-camera`, TypeScript/Vitest, Vue 3/Vitest, Tauri v2/Rust, Axum, Bonjour/mDNS, `qrcode` 1.5.4, pnpm.

---

## Scope Check

The desktop pairing surface, server claim contract, mobile trust store, inventory UI, and automatic router are coupled parts of one user flow. Splitting them into separately shipped plans would leave intermediate states where QR codes cannot be claimed or machines appear but cannot route, so this plan delivers them together behind existing app boundaries.

This Kanna stage leaves commits to the later pipeline post. The checkpoints below verify focused slices with `git diff` and targeted tests; do not create local commits while executing this plan.

## File Structure

### Pairing server and desktop

- Modify `crates/kanna-server/src/pairing.rs` — active session state, versioned payload, claim validation, rate limiting, and atomic trusted-device persistence.
- Modify `crates/kanna-server/src/http_api/state.rs` — store `ActivePairingSession` and stop leaking pairing secrets through status.
- Modify `crates/kanna-server/src/http_api/pairing.rs` — create and claim handlers with explicit status mapping.
- Modify `crates/kanna-server/src/http_api/router.rs` — register the claim route.
- Modify `crates/kanna-server/src/http_api/tests/core_routes.rs` — HTTP claim contract coverage.
- Modify `crates/kanna-server/src/http_api/tests/revision_status.rs` — status secrecy regression coverage.
- Modify `apps/desktop/src-tauri/src/commands/mobile/mod.rs` — return the pairing payload directly from the privileged Tauri command.
- Modify `apps/desktop/package.json` and `pnpm-lock.yaml` — add the vendored/browser-bundled QR renderer.
- Create `apps/desktop/src/utils/pairingQr.ts` — turn a pairing payload into a QR data URL.
- Create `apps/desktop/src/utils/pairingQr.test.ts` — QR helper contract.
- Modify `apps/desktop/src/components/MobileAccessPanel.vue` — render QR and code for one session.
- Modify `apps/desktop/src/components/__tests__/MobileAccessPanel.test.ts` — QR/code UI coverage.
- Modify `apps/desktop/src/components/PreferencesPanel.vue` — retain the privileged pairing response and pass its payload to the panel.

### Mobile native/configuration and pairing

- Modify `apps/mobile/package.json` and `pnpm-lock.yaml` — install the SDK-compatible `expo-camera` package.
- Modify `apps/mobile/app.config.ts` — add the camera config plugin and permission copy.
- Modify `apps/mobile/src/mobileEnvironments.json` — bump every native runtime to `2.1.0`.
- Modify `apps/mobile/src/mobileAppConfig.test.ts` — camera plugin and runtime coverage.
- Create `apps/mobile/src/lib/pairing/pairingPayload.ts` — parse and validate the versioned QR payload.
- Create `apps/mobile/src/lib/pairing/pairingPayload.test.ts` — parser coverage.
- Create `apps/mobile/src/lib/pairing/machinePairing.ts` — discover candidates, submit claims, validate identity, and return trusted records.
- Create `apps/mobile/src/lib/pairing/machinePairing.test.ts` — signed-out code/QR, duplicate, expiry, and reachability coverage.
- Modify `apps/mobile/src/lib/api/types.ts` — pairing request/response types.
- Modify `apps/mobile/src/state/sessionPersistence.ts` — persist a stable mobile device ID and existing manual machine records.
- Modify `apps/mobile/src/state/sessionPersistence.test.ts` — migration and device ID coverage.
- Modify `apps/mobile/src/state/sessionStore.ts` — expose device identity and manual-pairing removal.
- Modify `apps/mobile/src/state/sessionStore.test.ts` — store mutation coverage.

### Mobile inventory, routing, and UI

- Create `apps/mobile/src/state/machineInventory.ts` — pure source normalization and presentation.
- Create `apps/mobile/src/state/machineInventory.test.ts` — deduplication, origin, availability, and sorting coverage.
- Modify `apps/mobile/src/lib/discovery/trustedBonjour.ts` — authorize LAN identity from either account or manual trust.
- Modify `apps/mobile/src/lib/discovery/trustedBonjour.test.ts` — account-trusted LAN coverage.
- Modify `apps/mobile/src/lib/sources/cloudLanClient.ts` — report per-source desktop refresh warnings while retaining cached successful data.
- Modify `apps/mobile/src/lib/sources/cloudLanClient.test.ts` — partial cloud/LAN desktop refresh coverage.
- Modify `apps/mobile/src/appModel.ts` — wire pairing service and account-known LAN trust into automatic routing.
- Modify `apps/mobile/src/appModel.cloudFallback.test.ts` — account LAN preference and cloud fallback coverage.
- Modify `apps/mobile/src/state/mobileController.ts` — pair/remove controller operations and machine refresh.
- Modify `apps/mobile/src/state/mobileController.test.ts` — controller persistence and deduplication coverage.
- Create `apps/mobile/src/components/MachinePairingSheet.tsx` — QR scanner, code form, permission, and error states.
- Create `apps/mobile/src/components/MachinePairingSheet.test.tsx` — pairing sheet behavior.
- Rename `apps/mobile/src/screens/DesktopsScreen.tsx` to `apps/mobile/src/screens/MachinesScreen.tsx` — full inventory screen with add/remove controls and no selection.
- Create `apps/mobile/src/screens/MachinesScreen.test.tsx` — inventory UI coverage.
- Modify `apps/mobile/src/components/AccountSheet.tsx` — identity/sign-in plus Machines entry only.
- Modify `apps/mobile/src/components/AccountSheet.test.tsx` — remove obsolete connection assertions and cover Machines for both auth states.
- Modify `apps/mobile/src/screens/MoreScreen.tsx` — move Force Cloud into developer diagnostics.
- Modify `apps/mobile/src/screens/moreCommands.ts` and `apps/mobile/src/screens/moreCommands.test.ts` — remove pairing and desktop-switch commands.
- Modify `apps/mobile/src/App.tsx` and `apps/mobile/src/App.component.test.tsx` — orchestrate profile-to-Machines navigation and contextual return.
- Modify `apps/mobile/src/appShell.ts` and `apps/mobile/src/appShell.test.ts` — call the internal `desktops` route Machines and suppress the global header there.
- Modify `apps/mobile/src/e2eTestIds.ts`, `apps/mobile/src/e2eTestIds.test.ts`, and `apps/mobile/e2e/helpers/selectors.ts` — replace connection selectors with machine/pairing selectors.
- Modify `apps/mobile/e2e/specs/smoke/profile-connection.e2e.ts` and `.test.ts` — smoke the profile-to-Machines flow.
- Modify cloud/hybrid/relay E2E specs that use obsolete profile connection selectors.

## Task 1: Build a Real Single-Use Pairing Claim in `kanna-server`

**Files:**
- Modify: `crates/kanna-server/src/pairing.rs`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/pairing.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `crates/kanna-server/src/http_api/tests/revision_status.rs`

- [ ] **Step 1: Write failing domain tests for payloads and claims**

Add tests in `crates/kanna-server/src/pairing.rs` using a temp pairing-store path:

```rust
fn test_config(desktop_id: &str) -> Config {
    let store = std::env::temp_dir().join(format!(
        "kanna-pairing-plan-{}-{}.json",
        desktop_id,
        std::process::id()
    ));
    let _ = std::fs::remove_file(&store);
    Config {
        relay_url: "wss://relay.example".into(),
        device_token: "device-token".into(),
        firebase_project_id: "kanna-local".into(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".into(),
        db_path: "/tmp/kanna.db".into(),
        kanna_cli_path: None,
        desktop_id: desktop_id.into(),
        desktop_secret: Some("desktop-secret".into()),
        desktop_name: "Studio Mac".into(),
        server_version: Some("test-version".into()),
        lan_host: "0.0.0.0".into(),
        lan_port: 48_120,
        pairing_store_path: store.to_string_lossy().into_owned(),
    }
}

#[test]
fn pairing_payload_is_versioned_and_contains_identity() {
    let config = test_config("desktop-1");
    let active = create_pairing_session_at(&config, 1_000).unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(&active.session.pairing_payload).unwrap();

    assert_eq!(payload["type"], "kanna.machine-pairing");
    assert_eq!(payload["version"], 1);
    assert_eq!(payload["desktopId"], "desktop-1");
    assert_eq!(payload["code"], active.session.code);
}

#[test]
fn successful_claim_is_single_use_and_persists_device() {
    let config = test_config("desktop-1");
    let mut active = Some(create_pairing_session_at(&config, 1_000).unwrap());
    let code = active.as_ref().unwrap().session.code.clone();

    let claimed = claim_pairing_session_at(
        &config,
        &mut active,
        PairingClaimRequest {
            code,
            device_id: "phone-1".into(),
            device_name: "Kanna Mobile".into(),
        },
        2_000,
    )
    .unwrap();

    assert_eq!(claimed.desktop_id, "desktop-1");
    assert!(active.is_none());
    let store = PairingStore::load(Path::new(&config.pairing_store_path)).unwrap();
    assert!(store.is_trusted("desktop-1", "phone-1"));
}

#[test]
fn invalid_claims_are_rate_limited_without_consuming_valid_session() {
    let config = test_config("desktop-1");
    let mut active = Some(create_pairing_session_at(&config, 1_000).unwrap());

    for _ in 0..MAX_FAILED_CLAIMS {
        let error = claim_pairing_session_at(
            &config,
            &mut active,
            PairingClaimRequest {
                code: "BAD000".into(),
                device_id: "phone-1".into(),
                device_name: "Kanna Mobile".into(),
            },
            2_000,
        )
        .unwrap_err();
        assert!(matches!(error, PairingClaimError::InvalidCode | PairingClaimError::RateLimited));
    }

    assert_eq!(
        claim_pairing_session_at(
            &config,
            &mut active,
            PairingClaimRequest {
                code: "BAD000".into(),
                device_id: "phone-1".into(),
                device_name: "Kanna Mobile".into(),
            },
            2_000,
        ),
        Err(PairingClaimError::RateLimited)
    );
}

#[test]
fn expired_claim_consumes_the_stale_session() {
    let config = test_config("desktop-1");
    let mut active = Some(create_pairing_session_at(&config, 1_000).unwrap());
    let code = active.as_ref().unwrap().session.code.clone();

    assert_eq!(
        claim_pairing_session_at(
            &config,
            &mut active,
            PairingClaimRequest {
                code,
                device_id: "phone-1".into(),
                device_name: "Kanna Mobile".into(),
            },
            1_000 + PAIRING_TTL_MS + 1,
        ),
        Err(PairingClaimError::Expired)
    );
    assert!(active.is_none());
}
```

- [ ] **Step 2: Run the domain tests and confirm the missing API failure**

Run: `cargo test -p kanna-server pairing::tests -- --nocapture`

Expected: FAIL because `ActivePairingSession`, `PairingClaimRequest`, `PairingClaimError`, and the deterministic helpers do not exist.

- [ ] **Step 3: Implement the pairing domain**

Refactor `crates/kanna-server/src/pairing.rs` around these public shapes and constants:

```rust
pub const PAIRING_TTL_MS: u64 = 5 * 60 * 1_000;
pub const MAX_FAILED_CLAIMS: u8 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingSession {
    pub code: String,
    pub pairing_payload: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub expires_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ActivePairingSession {
    pub session: PairingSession,
    pub failed_claims: u8,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingClaimRequest {
    pub code: String,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingClaimResponse {
    pub desktop_id: String,
    pub desktop_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingClaimError {
    NoActiveSession,
    InvalidRequest,
    InvalidCode,
    Expired,
    RateLimited,
    Persistence(String),
}
```

Generate `pairing_payload` with `serde_json::to_string` over this exact value:

```rust
serde_json::json!({
    "type": "kanna.machine-pairing",
    "version": 1,
    "desktopId": config.desktop_id,
    "code": code,
})
```

Make `PairingStore::save`, `add_trusted_device`, and `is_trusted` production methods. `add_trusted_device` must upsert by `device_id` rather than append duplicates, and `save` must write a sibling temp file followed by `std::fs::rename` so a crash cannot truncate the trust store.

Implement `claim_pairing_session_at` so it:

1. rejects blank/oversized device identity fields;
2. normalizes the submitted code with `trim().to_ascii_uppercase()`;
3. expires and clears stale sessions;
4. increments `failed_claims` on a mismatch and returns `RateLimited` at the limit;
5. persists the trusted device;
6. clears the session only after persistence succeeds.

Keep `create_pairing_session` and `claim_pairing_session` as wall-clock wrappers around deterministic `_at` helpers.

- [ ] **Step 4: Add failing HTTP tests**

In `core_routes.rs`, create a session, claim it, and retry it:

```rust
let create = app.clone().oneshot(
    Request::post("/v1/pairing/sessions").body(Body::empty()).unwrap()
).await.unwrap();
let create_body = axum::body::to_bytes(create.into_body(), usize::MAX)
    .await
    .unwrap();
let pairing: PairingSession = serde_json::from_slice(&create_body).unwrap();

let claim = app.clone().oneshot(
    Request::post("/v1/pairing/sessions/claim")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::json!({
            "code": pairing.code,
            "deviceId": "phone-1",
            "deviceName": "Kanna Mobile"
        }).to_string()))
        .unwrap()
).await.unwrap();
assert_eq!(claim.status(), StatusCode::OK);

let replay = app.oneshot(
    Request::post("/v1/pairing/sessions/claim")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"code":"000000","deviceId":"phone-1","deviceName":"Kanna Mobile"}"#))
        .unwrap()
).await.unwrap();
assert_eq!(replay.status(), StatusCode::CONFLICT);
```

In `revision_status.rs`, replace the old pairing-code exposure assertion with:

```rust
assert_eq!(status_body["pairingCode"], serde_json::Value::Null);
```

- [ ] **Step 5: Implement the claim route and status mapping**

Change `AppState.pairing_session` to `Arc<Mutex<Option<ActivePairingSession>>>`. Make `mobile_server_status()` always call `build_mobile_server_status(&self.config, None)`.

Add to `http_api/pairing.rs`:

```rust
pub(super) async fn claim_pairing_session(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PairingClaimRequest>,
) -> Result<Json<PairingClaimResponse>, (StatusCode, String)> {
    let mut active = state.pairing_session.lock().await;
    pairing_domain::claim_pairing_session(&state.config, &mut active, request)
        .map(Json)
        .map_err(|error| match error {
            PairingClaimError::InvalidRequest | PairingClaimError::InvalidCode =>
                (StatusCode::BAD_REQUEST, error.to_string()),
            PairingClaimError::Expired => (StatusCode::GONE, error.to_string()),
            PairingClaimError::RateLimited =>
                (StatusCode::TOO_MANY_REQUESTS, error.to_string()),
            PairingClaimError::NoActiveSession =>
                (StatusCode::CONFLICT, error.to_string()),
            PairingClaimError::Persistence(message) =>
                (StatusCode::INTERNAL_SERVER_ERROR, message),
        })
}
```

Register `POST /v1/pairing/sessions/claim` in `router.rs`. The create handler stores the `ActivePairingSession` and returns `active.session`.

- [ ] **Step 6: Run server verification**

Run: `cargo test -p kanna-server pairing::tests -- --nocapture`

Run: `cargo test -p kanna-server http_api::tests::core_routes -- --nocapture`

Run: `cargo test -p kanna-server http_api::tests::revision_status -- --nocapture`

Expected: PASS.

- [ ] **Step 7: Review the server checkpoint**

Run: `git diff --check && git diff -- crates/kanna-server/src/pairing.rs crates/kanna-server/src/http_api`

Expected: no whitespace errors; diff contains no status-path pairing secret and no direct writes that can truncate the pairing store.

## Task 2: Render the Pairing QR on Desktop

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mobile/mod.rs`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/src/utils/pairingQr.ts`
- Create: `apps/desktop/src/utils/pairingQr.test.ts`
- Modify: `apps/desktop/src/components/MobileAccessPanel.vue`
- Modify: `apps/desktop/src/components/__tests__/MobileAccessPanel.test.ts`
- Modify: `apps/desktop/src/components/PreferencesPanel.vue`

- [ ] **Step 1: Write the failing privileged-command and component expectations**

Change the Rust manager test for `create_mobile_pairing_session` to expect both the code and `pairingPayload` from the POST response, without re-reading `/v1/status`.

Extend `MobileAccessPanel.test.ts`:

```ts
it("renders the QR generated from the same session as the short code", async () => {
  const wrapper = mount(MobileAccessPanel, {
    props: {
      desktopName: "Studio Mac",
      serverStatus: "running",
      pairingCode: "ABC123",
      pairingPayload: '{"type":"kanna.machine-pairing","version":1,"desktopId":"desktop-1","code":"ABC123"}'
    }
  });

  await flushPromises();
  expect(wrapper.get('[data-testid="mobile-access-pairing-qr"]').attributes("src"))
    .toBe("data:image/png;base64,qr");
  expect(wrapper.get('[data-testid="mobile-access-pairing-code"]').text())
    .toBe("ABC123");
});
```

Mock `../../utils/pairingQr` to return `data:image/png;base64,qr`.

- [ ] **Step 2: Run tests and confirm failures**

Run: `pnpm --dir apps/desktop test MobileAccessPanel pairingQr`

Expected: FAIL because the prop/helper and QR element do not exist.

- [ ] **Step 3: Add the pure browser QR renderer**

Run: `pnpm --dir apps/desktop add qrcode@1.5.4`

Create `pairingQr.ts`:

```ts
import QRCode from "qrcode";

export async function renderPairingQr(payload: string): Promise<string> {
  if (!payload.trim()) throw new Error("Pairing payload is empty.");
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 240,
    color: { dark: "#08111EFF", light: "#FFFFFFFF" }
  });
}
```

If `qrcode` type declarations are unavailable, add a narrow declaration at `apps/desktop/src/types/qrcode.d.ts` for the `toDataURL(text, options): Promise<string>` call instead of adding an unpinned global package.

- [ ] **Step 4: Return the pairing session from Tauri directly**

Replace the code-only `PairingSessionPayload` with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairingSession {
    pub code: String,
    pub pairing_payload: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub expires_at_unix_ms: u64,
}
```

Make `MobileServerManager::create_pairing_session()` and the Tauri command return `MobilePairingSession`. Do not call `snapshot()` after creation; that endpoint intentionally no longer returns the code.

- [ ] **Step 5: Render code and QR in the desktop panel**

Add a nullable `pairingPayload` prop. Watch it and assign `pairingQrUrl` from `renderPairingQr`; clear both URL and error when the payload becomes null. Render:

```vue
<div v-if="pairingCode" class="pairing-session">
  <img
    v-if="pairingQrUrl"
    :src="pairingQrUrl"
    alt="Mobile pairing QR code"
    class="pairing-qr"
    data-testid="mobile-access-pairing-qr"
  />
  <div class="pairing-code">
    <span class="label">Pairing code</span>
    <code data-testid="mobile-access-pairing-code">{{ pairingCode }}</code>
    <span class="expiry">Expires in five minutes</span>
  </div>
</div>
```

In `PreferencesPanel.vue`, store `pairingPayload` beside `pairingCode`, populate both from `create_mobile_pairing_session`, and pass both props. Clear both when a new request fails.

- [ ] **Step 6: Run desktop verification**

Run: `pnpm --dir apps/desktop test MobileAccessPanel pairingQr`

Expected: PASS.

Run: `cargo test -p kanna-desktop commands::mobile -- --nocapture`

Expected: PASS (use `./kd test rust` later if the package filter is not exposed by the workspace).

## Task 3: Add the Native QR Scanner Configuration

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/mobile/app.config.ts`
- Modify: `apps/mobile/src/mobileEnvironments.json`
- Modify: `apps/mobile/src/mobileAppConfig.test.ts`

- [ ] **Step 1: Write failing app-config assertions**

Add to `mobileAppConfig.test.ts`:

```ts
it("configures QR-only camera access and a new native runtime", () => {
  const config = createExpoConfig({ KANNA_APP_ENV: "dev" });
  expect(config.plugins).toContainEqual([
    "expo-camera",
    {
      cameraPermission: "Allow Kanna to scan machine pairing QR codes.",
      barcodeScannerEnabled: true,
      recordAudioAndroid: false
    }
  ]);
  expect(config.runtimeVersion).toBe("2.1.0");
});
```

Update existing runtime expectations from `2.0.0` to `2.1.0` for dev, staging, and production.

- [ ] **Step 2: Run the config test and confirm failure**

Run: `pnpm --dir apps/mobile test src/mobileAppConfig.test.ts`

Expected: FAIL because the camera plugin is absent and runtime remains `2.0.0`.

- [ ] **Step 3: Install the SDK-matched camera module**

Run: `pnpm --dir apps/mobile exec expo install expo-camera`

Expected: `apps/mobile/package.json` and `pnpm-lock.yaml` change to the Expo SDK 57-compatible version.

- [ ] **Step 4: Configure permissions and runtime compatibility**

Broaden `ExpoConfig.plugins` to `Array<string | [string, Record<string, unknown>]>`, then insert:

```ts
[
  "expo-camera",
  {
    cameraPermission: "Allow Kanna to scan machine pairing QR codes.",
    barcodeScannerEnabled: true,
    recordAudioAndroid: false
  }
]
```

Set all three `runtimeVersion` values in `mobileEnvironments.json` to `2.1.0`.

- [ ] **Step 5: Run mobile config and native identity tests**

Run: `pnpm --dir apps/mobile test src/mobileAppConfig.test.ts src/nativeIdentityPlugin.test.ts`

Expected: PASS.

## Task 4: Parse Pairing QR Payloads and Claim Bonjour Candidates

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts`
- Create: `apps/mobile/src/lib/pairing/pairingPayload.ts`
- Create: `apps/mobile/src/lib/pairing/pairingPayload.test.ts`
- Create: `apps/mobile/src/lib/pairing/machinePairing.ts`
- Create: `apps/mobile/src/lib/pairing/machinePairing.test.ts`

- [ ] **Step 1: Write failing payload tests**

```ts
describe("parseMachinePairingPayload", () => {
  it("accepts the version-one desktop identity and code", () => {
    expect(parseMachinePairingPayload(JSON.stringify({
      type: "kanna.machine-pairing",
      version: 1,
      desktopId: "desktop-1",
      code: "abc123"
    }))).toEqual({ desktopId: "desktop-1", code: "ABC123" });
  });

  it.each([
    ["not-json", "invalid"],
    [JSON.stringify({ type: "other", version: 1 }), "invalid"],
    [JSON.stringify({ type: "kanna.machine-pairing", version: 2 }), "unsupported-version"]
  ])("rejects %s", (raw, reason) => {
    expect(() => parseMachinePairingPayload(raw)).toThrowError(
      expect.objectContaining({ reason })
    );
  });
});
```

- [ ] **Step 2: Write failing machine-claim tests**

Use `createStaticBonjourBrowser` with two services and a mocked `fetchImpl`:

```ts
it("claims a QR payload only against its matching desktop", async () => {
  const service = createMachinePairingService({
    bonjourBrowser: createStaticBonjourBrowser([
      { name: "one", type: "_kanna-mobile._tcp", host: "10.0.0.2", port: 48120, txt: { desktopId: "desktop-1" } },
      { name: "two", type: "_kanna-mobile._tcp", host: "10.0.0.3", port: 48120, txt: { desktopId: "desktop-2" } }
    ]),
    fetchImpl,
    getDeviceIdentity: () => ({ deviceId: "phone-1", deviceName: "Kanna Mobile" }),
    now: () => new Date("2026-07-17T00:00:00.000Z")
  });

  await expect(service.claimPayload(validPayload)).resolves.toMatchObject({
    desktopId: "desktop-2",
    displayName: "Studio Mac",
    lanEndpoints: [{ baseUrl: "http://10.0.0.3:48120" }]
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("claims a manual code while signed out", async () => {
  await expect(service.claimCode("abc123")).resolves.toMatchObject({
    desktopId: "desktop-1"
  });
});

it.each([
  [410, "expired"],
  [429, "rate-limited"]
])("maps HTTP %s to %s", async (status, reason) => {
  fetchImpl.mockResolvedValue(response(status, { error: reason }));
  await expect(service.claimCode("ABC123")).rejects.toMatchObject({ reason });
});
```

- [ ] **Step 3: Run tests and confirm missing-module failures**

Run: `pnpm --dir apps/mobile test src/lib/pairing/pairingPayload.test.ts src/lib/pairing/machinePairing.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement strict payload parsing**

`pairingPayload.ts` must export:

```ts
export interface MachinePairingPayload { desktopId: string; code: string }
export class PairingPayloadError extends Error {
  constructor(public readonly reason: "invalid" | "unsupported-version", message: string) {
    super(message);
  }
}

export function normalizePairingCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}
```

`parseMachinePairingPayload` must parse JSON, require the exact type, require version `1`, require a nonblank `desktopId`, and require `/^[0-9A-F]{6}$/` after normalization.

- [ ] **Step 5: Implement the pairing service**

Add API types:

```ts
export interface PairingClaimRequest {
  code: string;
  deviceId: string;
  deviceName: string;
}

export interface PairingClaimResponse {
  desktopId: string;
  desktopName: string;
}
```

`machinePairing.ts` must export `MachinePairingError` with reasons:

```ts
type MachinePairingFailure =
  | "invalid-code"
  | "expired"
  | "rate-limited"
  | "not-found"
  | "multiple-matches"
  | "identity-mismatch"
  | "unreachable";
```

For every candidate, POST to `${baseUrl}/v1/pairing/sessions/claim` with the normalized code and device identity. QR claims filter services by `txt.desktopId` before POSTing. Code claims settle all discovered candidates, require exactly one success, and never persist directly. Return a `TrustedDesktopRecord` with the candidate base URL and `now().toISOString()` only after the response `desktopId` matches the advertised identity.

- [ ] **Step 6: Run pairing-library verification**

Run: `pnpm --dir apps/mobile test src/lib/pairing/pairingPayload.test.ts src/lib/pairing/machinePairing.test.ts`

Expected: PASS.

## Task 5: Persist Mobile Device Identity and Manual Pairing Removal

**Files:**
- Modify: `apps/mobile/src/state/sessionPersistence.ts`
- Modify: `apps/mobile/src/state/sessionPersistence.test.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/sessionStore.test.ts`

- [ ] **Step 1: Write failing persistence tests**

```ts
it("loads old contexts without inventing a device id during parsing", async () => {
  storage.getItem.mockResolvedValue(JSON.stringify(existingV1Context));
  await expect(persistence.load()).resolves.toMatchObject({ mobileDeviceId: null });
});

it("roundtrips the stable mobile device id", async () => {
  await persistence.save({ ...context, mobileDeviceId: "mobile-a1b2" });
  const saved = JSON.parse(storage.setItem.mock.calls[0][1]);
  expect(saved.mobileDeviceId).toBe("mobile-a1b2");
});
```

Add store tests:

```ts
it("creates a device id once and persists it", () => {
  const store = createSessionStore();
  expect(store.ensureMobileDeviceId(() => "mobile-generated")).toBe("mobile-generated");
  expect(store.ensureMobileDeviceId(() => "mobile-other")).toBe("mobile-generated");
  expect(store.getPersistedContext().mobileDeviceId).toBe("mobile-generated");
});

it("removes only the requested manual trust record", () => {
  store.setTrustedDesktops([trustedOne, trustedTwo]);
  store.removeTrustedDesktop("desktop-1");
  expect(store.getState().trustedDesktops).toEqual([trustedTwo]);
});
```

- [ ] **Step 2: Run persistence/store tests and confirm failure**

Run: `pnpm --dir apps/mobile test src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts`

Expected: FAIL because `mobileDeviceId`, `ensureMobileDeviceId`, and `removeTrustedDesktop` do not exist.

- [ ] **Step 3: Implement the migration-safe fields and methods**

Add `mobileDeviceId: string | null` to `PersistedSessionContext` and `SessionState`. Parse it only when it is a nonblank string; old contexts produce `null`.

Add to the store interface and implementation:

```ts
ensureMobileDeviceId(generate: () => string): string;
removeTrustedDesktop(desktopId: string): void;
```

`ensureMobileDeviceId` must publish only when generating. `removeTrustedDesktop` must publish only when the list changes. Include `mobileDeviceId` in hydration and `getPersistedContext`.

Use the existing session persistence subscription so pairing and removal are durably saved before UI success is reported.

- [ ] **Step 4: Run persistence/store verification**

Run: `pnpm --dir apps/mobile test src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts`

Expected: PASS.

## Task 6: Normalize Machines and Enable Account-Trusted LAN Routing

**Files:**
- Create: `apps/mobile/src/state/machineInventory.ts`
- Create: `apps/mobile/src/state/machineInventory.test.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/sessionStore.test.ts`
- Modify: `apps/mobile/src/lib/discovery/trustedBonjour.ts`
- Modify: `apps/mobile/src/lib/discovery/trustedBonjour.test.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`
- Modify: `apps/mobile/src/appModel.ts`
- Modify: `apps/mobile/src/appModel.cloudFallback.test.ts`

- [ ] **Step 1: Write failing inventory tests**

Cover account-only, manual-only, and dual-origin records:

```ts
expect(buildMachineInventory({
  accountDesktops: [
    { id: "desktop-1", name: "Cloud Name", online: true, mode: "remote", reachableViaRelay: true, connectionMode: "both" },
    { id: "desktop-2", name: "Remote Mac", online: false, mode: "remote", lastSeenAt: "2026-07-16T00:00:00Z" }
  ],
  manualDesktops: [
    { desktopId: "desktop-1", displayName: "Local Name", lanEndpoints: [endpoint], lastSeenAt: endpoint.lastSeenAt },
    { desktopId: "desktop-3", displayName: "Paired Mac", lanEndpoints: [], lastSeenAt: "2026-07-15T00:00:00Z" }
  ]
})).toEqual([
  expect.objectContaining({
    desktopId: "desktop-1",
    displayName: "Cloud Name",
    origins: { account: true, manual: true },
    availability: expect.objectContaining({ lan: true, cloud: true })
  }),
  expect.objectContaining({ desktopId: "desktop-2", origins: { account: true, manual: false } }),
  expect.objectContaining({ desktopId: "desktop-3", origins: { account: false, manual: true } })
]);
```

Also assert available records sort before offline records and names sort with `localeCompare`.

- [ ] **Step 2: Write failing account-LAN trust tests**

Change `resolveTrustedBonjourEndpoint` tests to pass `trustedDesktopIds`. Add:

```ts
it("accepts a Bonjour endpoint whose desktop id is trusted by the account", async () => {
  const endpoint = await resolveTrustedBonjourEndpoint({
    fetchImpl,
    services: [serviceFor("desktop-cloud")],
    trustedDesktopIds: ["desktop-cloud"],
    preferredDesktopId: null
  });
  expect(endpoint?.desktopId).toBe("desktop-cloud");
});
```

In `appModel.cloudFallback.test.ts`, add a signed-in account desktop, a matching Bonjour service, and assert task input uses LAN first; then remove the service and assert the next operation uses relay.

In `cloudLanClient.test.ts`, make cloud desktop refresh fail while LAN succeeds, then invert the failure. Assert the last successful record from the failed source remains in the merged result and an `onDesktopSourceWarnings` callback receives only the failed source message.

- [ ] **Step 3: Run tests and confirm failures**

Run: `pnpm --dir apps/mobile test src/state/machineInventory.test.ts src/lib/discovery/trustedBonjour.test.ts src/lib/sources/cloudLanClient.test.ts src/appModel.cloudFallback.test.ts`

Expected: FAIL because the selector and account trust path do not exist.

- [ ] **Step 4: Implement the pure machine selector**

Export:

```ts
export interface MobileMachine {
  desktopId: string;
  displayName: string;
  origins: { account: boolean; manual: boolean };
  availability: { lan: boolean; cloud: boolean; lastSeenAt: string | null };
  lanEndpoints: TrustedDesktopLanEndpoint[];
}

export function buildMachineInventory(input: {
  accountDesktops: readonly DesktopSummary[];
  manualDesktops: readonly TrustedDesktopRecord[];
}): MobileMachine[];

export function summarizeMachines(machines: readonly MobileMachine[]): {
  total: number;
  available: number;
};
```

Treat `connectionMode === "lan" | "both"` or `mode === "lan" && online` as LAN availability. Treat `reachableViaRelay === true` or `mode === "remote" && online` as cloud availability. Merge by exact `desktopId`, prefer the account display name, and keep manual endpoints.

Add `machineSourceWarnings: { account: string | null; local: string | null }` to `SessionState`, persistence-excluded store state, with a `setMachineSourceWarnings` mutation. It is runtime diagnostics, not durable user data.

- [ ] **Step 5: Generalize trusted Bonjour resolution**

Replace the `TrustedDesktopRecord[]` input with `trustedDesktopIds: readonly string[]`. A candidate is eligible only when its TXT `desktopId` is in that set and its `/v1/status` response returns the same ID. Keep `preferredDesktopId` only as an internal routing hint; do not expose selection in Machines.

- [ ] **Step 6: Feed account identities into the LAN router**

Inside the signed-in branch of `createClientForMode`, retain the last successful account desktop records:

```ts
let accountDesktopIds = new Set<string>();
const listCloudDesktopRecords = async () => {
  const records = await resolvedTaskIndex.listDesktops(authState.user.uid);
  accountDesktopIds = new Set(records.map((record) => record.desktopId));
  return records.map((record) => mapCloudDesktopRecord(record, lastActiveDesktopIds));
};
```

Pass a `getTrustedDesktopIds` callback to the LAN fallback that returns the union of `accountDesktopIds` and manual record IDs. Enable LAN whenever that union is nonempty and Force Cloud is off. Keep signed-out routing restricted to manual IDs.

Extend `createCloudLanClient` options with:

```ts
onDesktopSourceWarnings?(warnings: {
  account: string | null;
  local: string | null;
}): void;
```

Every `listDesktops` completion reports the individual rejected reads while continuing to return the existing cached/fulfilled merge. Wire this callback in `appModel.ts` to `sessionStore.setMachineSourceWarnings`; clear each source warning on its next successful read.

- [ ] **Step 7: Run routing and inventory verification**

Run: `pnpm --dir apps/mobile test src/state/machineInventory.test.ts src/lib/discovery/trustedBonjour.test.ts src/lib/sources/cloudLanClient.test.ts src/appModel.cloudFallback.test.ts`

Expected: PASS.

## Task 7: Wire Pairing and Removal Through the Controller

**Files:**
- Modify: `apps/mobile/src/appModel.ts`
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/api/client.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/state/mobileController.test.ts`

- [ ] **Step 1: Write failing controller tests**

```ts
it("pairs by code without auth and refreshes the normalized sources", async () => {
  auth.getState.mockReturnValue({ status: "signedOut" });
  pairingService.claimCode.mockResolvedValue(trustedDesktop);

  await controller.pairMachineByCode("ABC123");

  expect(store.getState().trustedDesktops).toContainEqual(trustedDesktop);
  expect(client.listDesktops).toHaveBeenCalled();
});

it("merges a QR claim into an existing desktop instead of duplicating", async () => {
  store.setTrustedDesktops([olderTrustedDesktop]);
  pairingService.claimPayload.mockResolvedValue(newerTrustedDesktop);
  await controller.pairMachineByPayload(validPayload);
  expect(store.getState().trustedDesktops).toHaveLength(1);
  expect(store.getState().trustedDesktops[0].lanEndpoints).toContainEqual(newEndpoint);
});

it("removes manual trust without deleting the account descriptor", async () => {
  store.setDesktops([accountDesktop]);
  store.setTrustedDesktops([trustedDesktop]);
  await controller.removeManualMachine("desktop-1");
  expect(store.getState().trustedDesktops).toEqual([]);
  expect(store.getState().desktops).toEqual([accountDesktop]);
});
```

- [ ] **Step 2: Run controller tests and confirm failure**

Run: `pnpm --dir apps/mobile test src/state/mobileController.test.ts`

Expected: FAIL because the controller methods and pairing service dependency do not exist.

- [ ] **Step 3: Add a pairing service dependency and stable device identity**

Extend controller options with `pairingService: MachinePairingService`. During model initialization, call:

```ts
const mobileDeviceId = sessionStore.ensureMobileDeviceId(() => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `mobile-${uuid}`;
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
});
```

Call this after `hydratePersistedContext()` and before `controller.bootstrap()`, then await `persistContext()` when a new ID was generated. Construct `createMachinePairingService` with a `getDeviceIdentity` callback that reads the hydrated ID, device name `Kanna Mobile`, the existing `bonjourBrowser`, and existing `fetchImpl`.

- [ ] **Step 4: Implement the controller operations**

Add:

```ts
async pairMachineByCode(code: string) {
  const trusted = await pairingService.claimCode(code);
  const previous = store.getState().trustedDesktops;
  store.upsertTrustedDesktop(trusted);
  try {
    await persistSessionContext();
  } catch (error) {
    store.setTrustedDesktops(previous);
    throw error;
  }
  replaceClientForTrustChange();
  await refreshDesktops({ force: true });
  return trusted.desktopId;
},
async pairMachineByPayload(payload: string) {
  const trusted = await pairingService.claimPayload(payload);
  const previous = store.getState().trustedDesktops;
  store.upsertTrustedDesktop(trusted);
  try {
    await persistSessionContext();
  } catch (error) {
    store.setTrustedDesktops(previous);
    throw error;
  }
  replaceClientForTrustChange();
  await refreshDesktops({ force: true });
  return trusted.desktopId;
},
async removeManualMachine(desktopId: string) {
  const previous = store.getState().trustedDesktops;
  store.removeTrustedDesktop(desktopId);
  try {
    await persistSessionContext();
  } catch (error) {
    store.setTrustedDesktops(previous);
    throw error;
  }
  replaceClientForTrustChange();
  await refreshDesktops({ force: true });
}
```

Expose a narrowly named model callback that replaces the active client after trust changes; do not route these actions through the obsolete `connectLocal()` method.

Delete `connectLocal()` from the controller. Delete `createPairingSession()` from the mobile `KannaTransport`/`KannaClient` interfaces and their LAN, remote, cloud-LAN, disconnected, and delegating implementations. The create-session endpoint remains server-side for the desktop's privileged Tauri command; mobile only calls the new claim endpoint discovered over Bonjour.

- [ ] **Step 5: Run controller/model verification**

Run: `pnpm --dir apps/mobile test src/state/mobileController.test.ts src/App.test.tsx`

Expected: PASS.

## Task 8: Build the Add Machine Sheet and Machines Screen

**Files:**
- Create: `apps/mobile/src/components/MachinePairingSheet.tsx`
- Create: `apps/mobile/src/components/MachinePairingSheet.test.tsx`
- Rename: `apps/mobile/src/screens/DesktopsScreen.tsx` to `apps/mobile/src/screens/MachinesScreen.tsx`
- Create: `apps/mobile/src/screens/MachinesScreen.test.tsx`

- [ ] **Step 1: Write failing pairing-sheet component tests**

Mock `expo-camera` with `CameraView: "CameraView"` and a controllable `useCameraPermissions`. Cover:

```ts
it("keeps code entry available when camera permission is denied", () => {
  cameraPermission.current = { granted: false, canAskAgain: false };
  const tree = renderSheet();
  expect(findByTestId(tree, "mobile.machine-pairing.code")).not.toBeNull();
  expect(findByTestId(tree, "mobile.machine-pairing.open-settings")).not.toBeNull();
});

it("submits only the first QR scan until pairing settles", async () => {
  const onPairPayload = vi.fn(() => pending.promise);
  const tree = renderSheet({ onPairPayload });
  const camera = findByType(tree, "CameraView");
  camera?.props?.onBarcodeScanned({ type: "qr", data: validPayload });
  camera?.props?.onBarcodeScanned({ type: "qr", data: validPayload });
  expect(onPairPayload).toHaveBeenCalledTimes(1);
});

it("normalizes and submits a six-character code", async () => {
  const onPairCode = vi.fn(async () => undefined);
  let tree = renderSheet({ onPairCode });
  findByTestId(tree, "mobile.machine-pairing.code")?.props?.onChangeText("abc 123");
  tree = renderSheet({ onPairCode });
  await findByTestId(tree, "mobile.machine-pairing.submit")?.props?.onPress();
  expect(onPairCode).toHaveBeenCalledWith("ABC123");
});
```

- [ ] **Step 2: Write failing Machines screen tests**

Cover Available/Offline grouping, origin labels, add, back, and conditional removal:

```ts
expect(textContent(tree)).toContain("Available");
expect(textContent(tree)).toContain("Offline");
expect(findAllByText(tree, "Jerome’s MacBook Pro")).toHaveLength(1);
expect(findByText(tree, "Account")).not.toBeNull();
expect(findByText(tree, "Paired")).not.toBeNull();
expect(findRemoveAction(accountOnlyMachine)).toBeNull();
expect(findRemoveAction(manualMachine)).not.toBeNull();
```

- [ ] **Step 3: Run component tests and confirm failures**

Run: `pnpm --dir apps/mobile test src/components/MachinePairingSheet.test.tsx src/screens/MachinesScreen.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement `MachinePairingSheet`**

Use a transparent bottom-sheet `Modal` and `KeyboardAvoidingView`. Keep local state for `code`, `mode`, `submitting`, `scanLocked`, and `error`. Render code entry in every permission state. Render `CameraView` only after the user chooses Scan and permission is granted:

```tsx
<CameraView
  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
  onBarcodeScanned={scanLocked ? undefined : ({ data }) => submitPayload(data)}
  style={styles.camera}
  testID={MOBILE_E2E_IDS.machinePairingCamera}
/>
```

Use `Linking.openSettings()` when permission cannot be requested again. Translate `MachinePairingError.reason` into the exact recovery copy from the design: expired/start again, not-found/same network, rate-limited/start a new session, unreachable/check both apps.

- [ ] **Step 5: Implement `MachinesScreen`**

Accept:

```ts
interface MachinesScreenProps {
  machines: MobileMachine[];
  sourceWarnings: { account: string | null; local: string | null };
  pairingVisible: boolean;
  onBack(): void;
  onOpenPairing(): void;
  onClosePairing(): void;
  onPairCode(code: string): Promise<void>;
  onPairPayload(payload: string): Promise<void>;
  onRemoveManual(desktopId: string): Promise<void>;
}
```

Render a self-contained header with Back, `Machines`, and Add. Split `machines` by `availability.lan || availability.cloud`. Use `Alert.alert` before removal and explain dual-origin retention in the confirmation message. Do not accept `selectedDesktopId` or `onSelectDesktop` props.

Render account and local source warnings as separate non-blocking banners above the inventory. Never replace or hide rows from the unaffected/cached source.

- [ ] **Step 6: Run UI component verification**

Run: `pnpm --dir apps/mobile test src/components/MachinePairingSheet.test.tsx src/screens/MachinesScreen.test.tsx`

Expected: PASS.

## Task 9: Simplify Profile and Move Developer Diagnostics

**Files:**
- Modify: `apps/mobile/src/components/AccountSheet.tsx`
- Modify: `apps/mobile/src/components/AccountSheet.test.tsx`
- Modify: `apps/mobile/src/screens/MoreScreen.tsx`
- Modify: `apps/mobile/src/screens/moreCommands.ts`
- Modify: `apps/mobile/src/screens/moreCommands.test.ts`

- [ ] **Step 1: Replace connection tests with identity/Machines tests**

Delete tests for `getConnectionStatusPresentation`, connection cards, Connect on Local Network, and account Force Cloud. Add:

```ts
it.each(["signedOut", "signedIn"] as const)(
  "keeps Machines reachable while %s",
  (status) => {
    const tree = renderAccountSheet({ auth: authFor(status), machineCount: 3, availableMachineCount: 2 });
    expect(findByTestId(tree, "mobile.account-machines")).not.toBeNull();
    expect(textContent(tree)).toContain("3 machines · 2 available");
  }
);

it("does not render connection or manual transport controls", () => {
  const tree = renderAccountSheet();
  expect(findByTestId(tree, "mobile.account-connection-status")).toBeNull();
  expect(findByText(tree, "Connect on Local Network")).toBeNull();
});
```

Update More tests to expect Force Cloud only when the dev flag is true and to expect no Start Pairing/Switch Desktop commands.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --dir apps/mobile test src/components/AccountSheet.test.tsx src/screens/moreCommands.test.ts`

Expected: FAIL against the current connection-oriented drawer and command palette.

- [ ] **Step 3: Simplify `AccountSheet` props and rendering**

Remove `connectionState`, `desktopName`, `errorMessage`, `pairingCode`, `forceCloudEnabled`, `showDevForceCloudToggle`, `onConnectLocal`, and `onForceCloudChange`.

Add:

```ts
machineCount: number;
availableMachineCount: number;
onOpenMachines(): void;
```

Render the Machines row after the profile header for both auth states. Preserve email/password behavior and password-reset-on-close/sign-out coverage. Use singular copy for one machine and `No machines added` for zero.

- [ ] **Step 4: Move Force Cloud to More developer diagnostics**

Add optional `showDeveloperDiagnostics`, `forceCloudEnabled`, and `onForceCloudChange` props to `MoreScreen`. Render a Developer card only when enabled. Reuse the existing accessible checked-state behavior and test ID under a renamed `mobile.developer.force-cloud` selector.

Remove `pair` and `desktops` from `MoreCommandAction`, `buildMoreCommandSections`, and the More handler switch.

- [ ] **Step 5: Run profile/More verification**

Run: `pnpm --dir apps/mobile test src/components/AccountSheet.test.tsx src/screens/moreCommands.test.ts src/screens/moreUpdateInfo.test.ts`

Expected: PASS.

## Task 10: Integrate Machines Into the App Shell

**Files:**
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/App.component.test.tsx`
- Modify: `apps/mobile/src/appShell.ts`
- Modify: `apps/mobile/src/appShell.test.ts`

- [ ] **Step 1: Write failing shell integration tests**

Update mocks from `DesktopsScreen` to `MachinesScreen`. Assert:

```ts
it("opens Machines from Profile and returns to the originating root view", () => {
  // activeView starts as recent
  accountSheet.props.onOpenMachines();
  expect(controller.showView).toHaveBeenCalledWith("desktops");
  expect(findAllByType(tree, "MachinesScreen")).toHaveLength(1);
  machinesScreen.props.onBack();
  expect(controller.showView).toHaveBeenLastCalledWith("recent");
});

it("passes one deduplicated inventory to Profile and Machines", () => {
  expect(accountSheet.props.machineCount).toBe(1);
  expect(machinesScreen.props.machines).toHaveLength(1);
});
```

Add `shouldShowTopBar(false, "desktops") === false` and `getShellTitle("desktops") === "Machines"` expectations.

- [ ] **Step 2: Run shell tests and confirm failure**

Run: `pnpm --dir apps/mobile test src/App.component.test.tsx src/appShell.test.ts`

Expected: FAIL because App still renders selectable Desktops and passes connection props to AccountSheet.

- [ ] **Step 3: Derive the machine inventory once**

In `App.tsx`:

```ts
const machines = useMemo(
  () => buildMachineInventory({
    accountDesktops: state.desktops,
    manualDesktops: state.trustedDesktops
  }),
  [state.desktops, state.trustedDesktops]
);
const machineSummary = useMemo(() => summarizeMachines(machines), [machines]);
```

Track `machinesReturnView` and `machinePairingVisible` in local state. When Profile opens Machines, save any non-`desktops` active view, close Profile, and call `controller.showView("desktops")`.

- [ ] **Step 4: Render Machines as a full self-owned screen**

Replace `DesktopsScreen` with `MachinesScreen`. Do not render the global top bar while `activeView === "desktops"`; the Machines screen supplies its own back/add header. Wire pairing methods to the controller and close the sheet only after a successful claim. Wire removal to `removeManualMachine`.

Pass machine counts and `onOpenMachines` to `AccountSheet`. Pass Force Cloud dev props to `MoreScreen`.

Pass `state.machineSourceWarnings` to `MachinesScreen` so partial source failures remain visible without replacing inventory.

- [ ] **Step 5: Run App/shell verification**

Run: `pnpm --dir apps/mobile test src/App.component.test.tsx src/appShell.test.ts src/App.test.tsx`

Expected: PASS.

## Task 11: Replace Obsolete Selectors and Update Mobile Smoke Coverage

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/src/e2eTestIds.test.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify: `apps/mobile/e2e/specs/smoke/profile-connection.e2e.ts`
- Modify: `apps/mobile/e2e/specs/smoke/profile-connection.test.ts`
- Modify: `apps/mobile/e2e/specs/cloud/cloud-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/specs/hybrid/hybrid-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/run.test.ts`

- [ ] **Step 1: Define the replacement selector contract in tests**

Replace connection/local-connect IDs with:

```ts
accountMachinesButton: "mobile.account-machines",
machinesScreen: "mobile.machines-screen",
machinesBackButton: "mobile.machines-back",
machinesAddButton: "mobile.machines-add",
machinePairingSheet: "mobile.machine-pairing.sheet",
machinePairingCodeInput: "mobile.machine-pairing.code",
machinePairingSubmit: "mobile.machine-pairing.submit",
machinePairingCamera: "mobile.machine-pairing.camera",
machinePairingOpenSettings: "mobile.machine-pairing.open-settings",
developerForceCloudToggle: "mobile.developer.force-cloud",
machineRow(desktopId: string): string {
  return `mobile.machine.${desktopId}`;
},
machineRemoveButton(desktopId: string): string {
  return `mobile.machine.${desktopId}.remove`;
}
```

- [ ] **Step 2: Run selector and smoke-unit tests and confirm failure**

Run: `pnpm --dir apps/mobile test src/e2eTestIds.test.ts e2e/specs/smoke/profile-connection.test.ts e2e/helpers/selectors.test.ts`

Expected: FAIL because tests reference the new selectors and behavior.

- [ ] **Step 3: Update the smoke helper around Profile → Machines**

Rename the helper assertions semantically while keeping the spec filename to avoid churn in runner registration:

```ts
export async function openMachinesFromProfile(ui: ProfileMachinesUi): Promise<void> {
  await openProfileSheet(ui);
  const machinesButton = await ui.getMachinesButton();
  await machinesButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await machinesButton.click();
  await (await ui.getMachinesScreen()).waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

export async function assertSignedOutMachineEntryPoints(ui: ProfileMachinesUi): Promise<void> {
  await openMachinesFromProfile(ui);
  const add = await ui.getMachinesAddButton();
  await add.click();
  await (await ui.getPairingCodeInput()).waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}
```

Keep password show/hide smoke coverage in Profile. Remove disconnected connection-title assertions. Update cloud/hybrid/relay callers to navigate through Machines only when they need machine UI; task flows must not use a global machine selection.

- [ ] **Step 4: Run all mobile unit tests**

Run: `pnpm --dir apps/mobile test`

Expected: PASS.

- [ ] **Step 5: Run the simulator-safe profile smoke when a dev app is available**

Run: `pnpm --dir apps/mobile run test:e2e:profile-disconnected`

Expected: Profile opens, Machines opens, Add Machine exposes code entry, and no obsolete Connect on Local Network control is expected. If the Appium simulator prerequisites are unavailable, record the exact preflight failure and rely on the unit/helper coverage; do not install or launch a physical device.

## Task 12: Full Verification and Cleanup

**Files:**
- Modify only files needed to resolve verification failures introduced by Tasks 1–11.

- [ ] **Step 1: Scan for obsolete product language and selectors**

Run:

```bash
rg -n "Connect on Local Network|Start Pairing|Switch Desktop|accountConnectionStatus|accountConnectLocalButton|accountForceCloudToggle" apps/mobile apps/desktop
```

Expected: no production UI or active test references. Historical docs may retain old terminology.

- [ ] **Step 2: Run format and type checks**

Run: `pnpm --dir apps/mobile typecheck`

Expected: PASS.

Run: `pnpm --dir apps/desktop build`

Expected: PASS.

- [ ] **Step 3: Run focused frontend suites**

Run: `pnpm --dir apps/mobile test`

Expected: PASS.

Run: `pnpm --dir apps/desktop test MobileAccessPanel pairingQr`

Expected: PASS.

- [ ] **Step 4: Run Rust verification**

Run: `cargo test -p kanna-server -- --nocapture`

Expected: PASS.

Run: `./kd test rust`

Expected: PASS.

- [ ] **Step 5: Run canonical repository tests**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 6: Inspect final native/runtime and packaging boundaries**

Run:

```bash
git diff --check
git status --short
git diff -- apps/mobile/app.config.ts apps/mobile/src/mobileEnvironments.json apps/mobile/package.json apps/desktop/package.json crates/kanna-server/src/pairing.rs
```

Expected: camera plugin and `2.1.0` runtime are present; QR generation is a bundled JS dependency; server writes no build-machine-specific paths; no `.superpowers/` mockup files are tracked.

- [ ] **Step 7: Perform final design-to-diff audit**

Confirm all success criteria from `docs/superpowers/specs/2026-07-17-mobile-profile-machines-design.md` are represented by passing tests: identity-only Profile, Machines available signed in/out, one row per `desktopId`, QR/code manual pairing, automatic account LAN fallback, manual-only removal, and partial-source preservation.

- [ ] **Step 8: Leave the worktree uncommitted for the Kanna pipeline**

Run: `git status --short`

Expected: the implementation and its design/plan are visible as worktree changes. Do not push, create a PR, or create a local commit in this manual stage.
