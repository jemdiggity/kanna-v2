# Mobile Cloud Bonjour Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove URL-based mobile runtime discovery and make mobile discover tasks from cloud plus trusted Bonjour LAN peers.

**Architecture:** Mobile gets a source-driven client: cloud is active when signed in, and LAN is active only for trusted desktops resolved through Bonjour. kd stops injecting mobile server URLs, and non-cloud E2E seeds trust by desktop id while requiring Bonjour to discover the endpoint at runtime.

**Tech Stack:** React Native/Expo, Swift iOS native module, NetServiceBrowser, Vitest, Appium/WebdriverIO, kd TypeScript runtime

---

## File Structure

- Modify `apps/mobile/src/appModel.ts`: remove `baseUrl` runtime discovery and compose cloud, trusted Bonjour LAN, and disconnected sources.
- Create `apps/mobile/src/lib/discovery/bonjour.ts`: typed JS interface around native Bonjour events plus test fakes.
- Create `apps/mobile/src/lib/discovery/trustedBonjour.ts`: match discovered services to persisted trusted desktops and validate `/v1/status`.
- Create `apps/mobile/src/lib/discovery/trustedBonjour.test.ts`: trust matching and validation coverage.
- Create `apps/mobile/ios/KannaMobile/KannaBonjourModule.swift`: iOS Bonjour browser using `NetServiceBrowser`.
- Create `apps/mobile/ios/KannaMobile/KannaBonjourModule.m`: React Native extern bridge for the Swift module.
- Modify `apps/mobile/ios/KannaMobile/Info.plist`: declare local network permission and Bonjour service type.
- Modify `apps/mobile/src/state/sessionPersistence.ts`: keep trusted peer records compatible, no URL seed requirement.
- Modify `apps/mobile/src/App.test.tsx`: prove signed-out mobile does not call localhost and signed-in cloud works without LAN URL.
- Modify `tools/kd/src/runtime/dev-plan.ts`: stop injecting `EXPO_PUBLIC_KANNA_SERVER_URL`.
- Modify `tools/kd/tests/dev-plan.test.ts`: assert the mobile command has no server URL env.
- Modify `apps/mobile/e2e/helpers/metro.ts`: stop keying Metro reuse on desktop server URL.
- Modify `apps/mobile/e2e/run.ts`: remove direct server URL setup; add trusted-peer seeding before launch for non-cloud smoke.
- Create `apps/mobile/src/e2eTrustSeed.ts`: dev/test-only deep-link handler that writes trusted desktop context through the app persistence layer.
- Create `apps/mobile/e2e/helpers/trust-seed.ts`: open the E2E trust seed deep link before the smoke assertions.
- Modify `apps/mobile/e2e/helpers/desktop.ts`: resolve desktop id from `/v1/status` only for trust seeding and preflight, not app runtime URL discovery.

## Task 1: Remove Runtime Mobile Server URL Resolution

**Files:**
- Modify: `apps/mobile/src/appModel.ts`
- Modify: `apps/mobile/src/App.test.tsx`

- [ ] **Step 1: Write failing tests for no URL bootstrap**

Add these tests to `apps/mobile/src/App.test.tsx`:

```ts
it("does not call localhost when signed out with no trusted desktops", async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error("runtime URL fallback must not be used");
  }) as FetchLike;
  const model = createAppModel({
    fetchImpl,
    persistence: {
      load: vi.fn().mockResolvedValue({
        selectedDesktopId: null,
        selectedRepoId: null,
        selectedTaskId: null,
        activeView: "tasks",
        trustedDesktops: []
      }),
      save: vi.fn().mockResolvedValue(undefined)
    },
    authSession: {
      initialize: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(() => ({ status: "signedOut" })),
      subscribe: vi.fn(() => () => undefined),
      signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      getIdToken: vi.fn().mockResolvedValue(null)
    }
  });

  await model.initialize();

  expect(model.sessionStore.getState()).toMatchObject({
    connectionState: "idle",
    recentTasks: [],
    repoTasks: []
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("loads signed-in cloud tasks without a LAN base URL", async () => {
  const authSession = createSignedInAuthSession();
  const taskIndex = {
    listRecentTasks: vi.fn(async () => [
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        repoName: "Kanna",
        title: "Cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-1",
        ownerOnline: false
      }
    ])
  };
  const model = createAppModel({
    fetchImpl: vi.fn(async () => {
      throw new Error("LAN should not be called for cloud task bootstrap");
    }) as FetchLike,
    authSession,
    options: { relayUrl: "wss://relay.example", taskIndex }
  });

  await model.initialize();

  expect(model.sessionStore.getState()).toMatchObject({
    connectionMode: "remote",
    connectionState: "connected",
    recentTasks: [expect.objectContaining({ id: "cloud-task-1" })]
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir apps/mobile test src/App.test.tsx
```

Expected: FAIL because `createAppModel` still accepts positional `baseUrl` and signed-out bootstrap still calls the LAN client.

- [ ] **Step 3: Replace positional base URL app model with options**

In `apps/mobile/src/appModel.ts`, replace the `createAppModel` signature with:

```ts
export interface CreateAppModelInput {
  fetchImpl?: FetchLike;
  persistence?: SessionPersistence;
  authSession?: MobileAuthSession;
  options?: AppModelOptions;
}

export function createAppModel(input: CreateAppModelInput = {}): AppModel {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const authSession = input.authSession ?? createConfiguredMobileAuthSession();
  const options = input.options ?? {};
  const sessionStore = createSessionStore();
  const resolveClient = () =>
    createClientForMode({
      authSession,
      createRelayClient: options.createRelayClient ?? createRelayDesktopClient,
      fetchImpl,
      getSelectedDesktopId: () => sessionStore.getState().selectedDesktopId,
      getTrustedDesktops: () => sessionStore.getState().trustedDesktops,
      relayUrl: options.relayUrl ?? resolveRelayUrl(),
      taskIndex: options.taskIndex
    });
  let activeClient = resolveClient();
  const client = createDelegatingClient(() => activeClient);
  const controller = createMobileController(client, sessionStore, authSession);
  let persistencePromise: Promise<SessionPersistence> | null = input.persistence
    ? Promise.resolve(input.persistence)
    : null;
  // Keep the rest of the existing persistence/bootstrap logic.
}
```

Remove these functions and constants from runtime use:

```ts
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 48120;
const DEFAULT_SERVER_BASE_URL = `http://${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT}`;

function readReactNativeBundleUrl(): string | null { /* remove */ }
function inferServerBaseUrl(bundleUrl: string | null): string | null { /* remove */ }
export function resolveServerBaseUrl(...) { /* remove */ }
```

Keep `isLoopbackBaseUrl` only if a test-only helper still imports it; otherwise remove it in Task 2 after the trusted Bonjour source lands.

- [ ] **Step 4: Add disconnected client behavior**

Add this helper in `apps/mobile/src/appModel.ts`:

```ts
function createDisconnectedClient(): KannaClient {
  const unavailable = async () => {
    throw new Error("No trusted desktop is available. Sign in or pair a desktop.");
  };

  return {
    getStatus: async () => ({
      state: "stopped",
      desktopId: "none",
      desktopName: "No desktop",
      lanHost: "none",
      lanPort: 0,
      pairingCode: null
    }),
    listDesktops: async () => [],
    listRepos: async () => [],
    listRepoTasks: async () => [],
    listRecentTasks: async () => [],
    searchTasks: async () => [],
    createTask: unavailable,
    runMergeAgent: unavailable,
    advanceTaskStage: unavailable,
    closeTask: unavailable,
    sendTaskInput: unavailable,
    observeTaskTerminal(taskId, listener) {
      listener({
        type: "error",
        taskId,
        message: "No trusted desktop is available."
      });
      return { close() {} };
    },
    createPairingSession: unavailable
  };
}
```

Update `createClientForMode` so signed out with no trusted LAN source returns `createDisconnectedClient()` instead of `createLanTransport("http://127.0.0.1:48120", ...)`.

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --dir apps/mobile test src/App.test.tsx
```

Expected: PASS for the new tests and existing app model tests after updating old positional calls to the new object signature.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/appModel.ts apps/mobile/src/App.test.tsx
git commit -m "refactor(mobile): remove runtime server url bootstrap"
```

## Task 2: Add Trusted Bonjour LAN Source

**Files:**
- Create: `apps/mobile/src/lib/discovery/bonjour.ts`
- Create: `apps/mobile/src/lib/discovery/trustedBonjour.ts`
- Create: `apps/mobile/src/lib/discovery/trustedBonjour.test.ts`
- Modify: `apps/mobile/src/appModel.ts`

- [ ] **Step 1: Write trusted Bonjour tests**

Create `apps/mobile/src/lib/discovery/trustedBonjour.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveTrustedBonjourEndpoint } from "./trustedBonjour";
import type { BonjourService } from "./bonjour";

const trustedDesktops = [
  {
    desktopId: "desktop-1",
    displayName: "Studio Mac",
    lanEndpoints: [],
    lastSeenAt: "2026-06-01T00:00:00.000Z"
  }
];

describe("trusted Bonjour discovery", () => {
  it("accepts a Bonjour endpoint when status desktop id matches trust", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ desktopId: "desktop-1" })
    }));
    const service: BonjourService = {
      name: "Studio Mac",
      type: "_kanna-mobile._tcp.",
      host: "studio.local",
      port: 48120,
      txt: { desktopId: "desktop-1" }
    };

    await expect(
      resolveTrustedBonjourEndpoint({
        fetchImpl,
        services: [service],
        trustedDesktops,
        selectedDesktopId: null
      })
    ).resolves.toEqual({
      baseUrl: "http://studio.local:48120",
      desktopId: "desktop-1",
      displayName: "Studio Mac"
    });
  });

  it("ignores untrusted Bonjour services without probing them", async () => {
    const fetchImpl = vi.fn();

    await expect(
      resolveTrustedBonjourEndpoint({
        fetchImpl,
        services: [
          {
            name: "Unknown Mac",
            type: "_kanna-mobile._tcp.",
            host: "unknown.local",
            port: 48120,
            txt: { desktopId: "desktop-2" }
          }
        ],
        trustedDesktops,
        selectedDesktopId: null
      })
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a trusted service when status reports a different desktop id", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ desktopId: "desktop-other" })
    }));

    await expect(
      resolveTrustedBonjourEndpoint({
        fetchImpl,
        services: [
          {
            name: "Studio Mac",
            type: "_kanna-mobile._tcp.",
            host: "studio.local",
            port: 48120,
            txt: { desktopId: "desktop-1" }
          }
        ],
        trustedDesktops,
        selectedDesktopId: "desktop-1"
      })
    ).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/mobile test src/lib/discovery/trustedBonjour.test.ts
```

Expected: FAIL because the discovery modules do not exist.

- [ ] **Step 3: Add Bonjour JS interface**

Create `apps/mobile/src/lib/discovery/bonjour.ts`:

```ts
import { NativeEventEmitter, NativeModules } from "react-native";

export interface BonjourService {
  name: string;
  type: string;
  host: string;
  port: number;
  txt: Record<string, string>;
}

export interface BonjourBrowser {
  getServices(): readonly BonjourService[];
  start(): void;
  stop(): void;
  subscribe(listener: () => void): () => void;
}

interface NativeBonjourModule {
  startBrowsing(): void;
  stopBrowsing(): void;
}

export function createBonjourBrowser(): BonjourBrowser {
  const nativeModule = NativeModules.KannaBonjourModule as NativeBonjourModule | undefined;
  if (!nativeModule) {
    return createStaticBonjourBrowser([]);
  }

  const services = new Map<string, BonjourService>();
  const listeners = new Set<() => void>();
  const emitter = new NativeEventEmitter(nativeModule as object);
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const subscription = emitter.addListener("kannaBonjourServiceChanged", (event) => {
    const service = normalizeBonjourService(event);
    if (!service) {
      return;
    }
    services.set(`${service.name}:${service.host}:${service.port}`, service);
    notify();
  });

  return {
    getServices: () => Array.from(services.values()),
    start: () => nativeModule.startBrowsing(),
    stop() {
      nativeModule.stopBrowsing();
      subscription.remove();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function createStaticBonjourBrowser(
  initialServices: readonly BonjourService[]
): BonjourBrowser {
  let services = [...initialServices];
  const listeners = new Set<() => void>();
  return {
    getServices: () => services,
    start() {},
    stop() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function normalizeBonjourService(event: unknown): BonjourService | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const record = event as Partial<BonjourService>;
  if (
    typeof record.name !== "string" ||
    typeof record.type !== "string" ||
    typeof record.host !== "string" ||
    typeof record.port !== "number"
  ) {
    return null;
  }
  return {
    name: record.name,
    type: record.type,
    host: record.host,
    port: record.port,
    txt: record.txt && typeof record.txt === "object" ? record.txt : {}
  };
}
```

- [ ] **Step 4: Add trusted Bonjour resolver**

Create `apps/mobile/src/lib/discovery/trustedBonjour.ts`:

```ts
import type { FetchLike } from "../transports/lanTransport";
import type { TrustedDesktopRecord } from "../../state/sessionPersistence";
import type { BonjourService } from "./bonjour";

export interface TrustedBonjourEndpoint {
  baseUrl: string;
  desktopId: string;
  displayName: string;
}

export async function resolveTrustedBonjourEndpoint(input: {
  fetchImpl: FetchLike;
  services: readonly BonjourService[];
  trustedDesktops: readonly TrustedDesktopRecord[];
  selectedDesktopId: string | null;
}): Promise<TrustedBonjourEndpoint | null> {
  for (const service of orderServices(input.services, input.selectedDesktopId)) {
    const desktopId = service.txt.desktopId;
    const trusted = input.trustedDesktops.find(
      (desktop) => desktop.desktopId === desktopId
    );
    if (!trusted) {
      continue;
    }

    const baseUrl = `http://${service.host}:${service.port}`;
    const status = await fetchStatus(baseUrl, input.fetchImpl);
    if (status?.desktopId !== trusted.desktopId) {
      continue;
    }

    return {
      baseUrl,
      desktopId: trusted.desktopId,
      displayName: trusted.displayName
    };
  }

  return null;
}

function orderServices(
  services: readonly BonjourService[],
  selectedDesktopId: string | null
): BonjourService[] {
  return [...services].sort((left, right) => {
    const leftSelected = left.txt.desktopId === selectedDesktopId ? 0 : 1;
    const rightSelected = right.txt.desktopId === selectedDesktopId ? 0 : 1;
    return leftSelected - rightSelected;
  });
}

async function fetchStatus(
  baseUrl: string,
  fetchImpl: FetchLike
): Promise<{ desktopId?: string } | null> {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/status`);
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body && typeof body === "object" ? (body as { desktopId?: string }) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Wire trusted Bonjour into app model**

Add `bonjourBrowser?: BonjourBrowser` to `AppModelOptions`, start it during `initialize()`, and replace the old trusted LAN resolver with:

```ts
const bonjourBrowser = options.bonjourBrowser ?? createBonjourBrowser();
bonjourBrowser.start();

const lanClient = createTrustedBonjourLanClient({
  bonjourBrowser,
  fetchImpl,
  getSelectedDesktopId,
  getTrustedDesktops
});
```

The `createTrustedBonjourLanClient` should call `resolveTrustedBonjourEndpoint`, then `createLanTransport(endpoint.baseUrl, fetchImpl)`. It must return `createDisconnectedClient()` behavior when no trusted Bonjour endpoint is available.

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --dir apps/mobile test src/lib/discovery/trustedBonjour.test.ts src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/appModel.ts apps/mobile/src/lib/discovery apps/mobile/src/App.test.tsx
git commit -m "feat(mobile): resolve lan peers through trusted bonjour"
```

## Task 3: Add iOS Bonjour Native Browser

**Files:**
- Create: `apps/mobile/ios/KannaMobile/KannaBonjourModule.swift`
- Create: `apps/mobile/ios/KannaMobile/KannaBonjourModule.m`
- Modify: `apps/mobile/ios/KannaMobile/Info.plist`
- Modify: `apps/mobile/ios/KannaMobile.xcodeproj/project.pbxproj`

- [ ] **Step 1: Add Info.plist local network keys**

Modify `apps/mobile/ios/KannaMobile/Info.plist` inside the top-level `<dict>`:

```xml
<key>NSBonjourServices</key>
<array>
  <string>_kanna-mobile._tcp</string>
</array>
<key>NSLocalNetworkUsageDescription</key>
<string>Kanna discovers trusted desktop apps on your local network.</string>
```

- [ ] **Step 2: Add Swift Bonjour module**

Create `apps/mobile/ios/KannaMobile/KannaBonjourModule.swift`:

```swift
import Foundation
import React

@objc(KannaBonjourModule)
class KannaBonjourModule: RCTEventEmitter, NetServiceBrowserDelegate, NetServiceDelegate {
  private let browser = NetServiceBrowser()
  private var services: [NetService] = []
  private var hasListeners = false

  override init() {
    super.init()
    browser.delegate = self
  }

  override static func requiresMainQueueSetup() -> Bool {
    false
  }

  override func supportedEvents() -> [String]! {
    ["kannaBonjourServiceChanged"]
  }

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
  }

  @objc func startBrowsing() {
    browser.searchForServices(ofType: "_kanna-mobile._tcp.", inDomain: "local.")
  }

  @objc func stopBrowsing() {
    browser.stop()
    services.removeAll()
  }

  func netServiceBrowser(
    _ browser: NetServiceBrowser,
    didFind service: NetService,
    moreComing: Bool
  ) {
    service.delegate = self
    services.append(service)
    service.resolve(withTimeout: 5)
  }

  func netServiceBrowser(
    _ browser: NetServiceBrowser,
    didRemove service: NetService,
    moreComing: Bool
  ) {
    services.removeAll { $0.name == service.name }
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    guard hasListeners else { return }
    sendEvent(withName: "kannaBonjourServiceChanged", body: [
      "name": sender.name,
      "type": sender.type,
      "host": sender.hostName ?? "",
      "port": sender.port,
      "txt": parseTxt(sender.txtRecordData())
    ])
  }

  private func parseTxt(_ data: Data?) -> [String: String] {
    guard let data else { return [:] }
    let raw = NetService.dictionary(fromTXTRecord: data)
    var result: [String: String] = [:]
    for (key, value) in raw {
      result[key] = String(data: value, encoding: .utf8) ?? ""
    }
    return result
  }
}
```

- [ ] **Step 3: Add Objective-C extern bridge**

Create `apps/mobile/ios/KannaMobile/KannaBonjourModule.m`:

```objc
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(KannaBonjourModule, RCTEventEmitter)
RCT_EXTERN_METHOD(startBrowsing)
RCT_EXTERN_METHOD(stopBrowsing)
@end
```

- [ ] **Step 4: Add files to Xcode project**

Open `apps/mobile/ios/KannaMobile.xcodeproj/project.pbxproj` and add both new files to the `KannaMobile` target sources group and `PBXSourcesBuildPhase`. Follow the existing `AppDelegate.swift` entry style. Verify with:

```bash
xcodebuild -workspace apps/mobile/ios/KannaMobile.xcworkspace -scheme KannaMobile -configuration Debug -sdk iphonesimulator -showBuildSettings >/dev/null
```

Expected: command exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/ios/KannaMobile/Info.plist apps/mobile/ios/KannaMobile/KannaBonjourModule.swift apps/mobile/ios/KannaMobile/KannaBonjourModule.m apps/mobile/ios/KannaMobile.xcodeproj/project.pbxproj
git commit -m "feat(mobile): add ios bonjour discovery bridge"
```

## Task 4: Stop kd from Injecting Mobile Server URLs

**Files:**
- Modify: `tools/kd/src/runtime/dev-plan.ts`
- Modify: `tools/kd/tests/dev-plan.test.ts`
- Modify: `tools/kd/src/runtime/mobile.ts` if no remaining runtime caller needs `resolveMobileServerUrl`

- [ ] **Step 1: Update kd tests first**

In `tools/kd/tests/dev-plan.test.ts`, replace:

```ts
expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_KANNA_SERVER_URL=http://192.168.1.5:48120");
```

with:

```ts
expect(plan.windows[3]?.command).not.toContain("EXPO_PUBLIC_KANNA_SERVER_URL");
```

Keep the relay and Firebase emulator assertions.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir tools/kd test tests/dev-plan.test.ts
```

Expected: FAIL because `buildDevPlan` still injects `EXPO_PUBLIC_KANNA_SERVER_URL`.

- [ ] **Step 3: Remove mobile server URL env injection**

In `tools/kd/src/runtime/dev-plan.ts`, change the mobile env block to:

```ts
const mobileEnv = shellEnvPrefix({
  EXPO_PUBLIC_KANNA_RELAY_URL: resolveRelayUrl(input),
  RCT_METRO_PORT: input.env.KANNA_MOBILE_PORT ?? "8081",
  ...mobileFirebaseEnv(input)
});
```

Keep `mobileServerUrl` only for emulator host derivation until Firebase emulator env can use a separate LAN host input.

- [ ] **Step 4: Run kd tests**

Run:

```bash
pnpm --dir tools/kd test tests/dev-plan.test.ts tests/cli.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/kd/src/runtime/dev-plan.ts tools/kd/tests/dev-plan.test.ts
git commit -m "chore(kd): stop injecting mobile server url"
```

## Task 5: Rework Non-Cloud Mobile E2E Around Trusted Bonjour

**Files:**
- Modify: `apps/mobile/e2e/run.ts`
- Modify: `apps/mobile/e2e/helpers/metro.ts`
- Modify: `apps/mobile/e2e/helpers/metro.test.ts`
- Create: `apps/mobile/e2e/helpers/trust-seed.ts`
- Modify: `apps/mobile/e2e/helpers/desktop.ts`
- Modify: `apps/mobile/e2e/helpers/desktop.test.ts`

- [ ] **Step 1: Update Metro helper tests**

In `apps/mobile/e2e/helpers/metro.test.ts`, replace URL-based reuse expectations with project-root-only reuse:

```ts
it("reuses an Expo server from the same project root", () => {
  expect(
    shouldReuseExpoServer(
      {
        commandLine: "node expo start",
        cwd: "/tmp/kanna/apps/mobile"
      },
      { projectRoot: "/tmp/kanna/apps/mobile" }
    )
  ).toBe(true);
});

it("does not reuse an Expo server from another project root", () => {
  expect(
    shouldReuseExpoServer(
      {
        commandLine: "node expo start",
        cwd: "/tmp/other/apps/mobile"
      },
      { projectRoot: "/tmp/kanna/apps/mobile" }
    )
  ).toBe(false);
});
```

- [ ] **Step 2: Run Metro tests to verify failure**

Run:

```bash
pnpm --dir apps/mobile test e2e/helpers/metro.test.ts
```

Expected: FAIL because `shouldReuseExpoServer` still requires `desktopServerUrl`.

- [ ] **Step 3: Remove URL env from Metro helper**

In `apps/mobile/e2e/helpers/metro.ts`, change `EnsureExpoServerOptions` to:

```ts
interface EnsureExpoServerOptions {
  metroPort: number;
  projectRoot: string;
}
```

Change `shouldReuseExpoServer` to:

```ts
export function shouldReuseExpoServer(
  existing: RunningExpoProcess,
  expected: { projectRoot: string }
): boolean {
  return existing.cwd === expected.projectRoot && existing.commandLine.includes("expo");
}
```

Change `spawn` env to remove `EXPO_PUBLIC_KANNA_SERVER_URL`:

```ts
env: {
  ...process.env,
  CI: "1",
  EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED: "1"
}
```

- [ ] **Step 4: Add in-app E2E trust seed handler**

Create `apps/mobile/src/e2eTrustSeed.ts`:

```ts
import { Linking } from "react-native";
import type { SessionPersistence } from "./state/sessionPersistence";

export function installE2eTrustSeedHandler(input: {
  getPersistence(): Promise<SessionPersistence>;
  reload(): Promise<void>;
}): () => void {
  const handleUrl = (url: string) => {
    void seedTrustedDesktopFromUrl(url, input);
  };
  const subscription = Linking.addEventListener("url", (event) => handleUrl(event.url));
  void Linking.getInitialURL().then((url) => {
    if (url) {
      handleUrl(url);
    }
  });
  return () => subscription.remove();
}

async function seedTrustedDesktopFromUrl(
  url: string,
  input: {
    getPersistence(): Promise<SessionPersistence>;
    reload(): Promise<void>;
  }
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "kanna:" || parsed.hostname !== "e2e-trust") {
    return;
  }
  const desktopId = parsed.searchParams.get("desktopId");
  const displayName = parsed.searchParams.get("displayName");
  if (!desktopId || !displayName) {
    return;
  }
  const persistence = await input.getPersistence();
  await persistence.save({
    selectedDesktopId: desktopId,
    selectedRepoId: null,
    selectedTaskId: null,
    activeView: "tasks",
    trustedDesktops: [
      {
        desktopId,
        displayName,
        lanEndpoints: [],
        lastSeenAt: new Date().toISOString()
      }
    ]
  });
  await input.reload();
}
```

In `apps/mobile/src/appModel.ts`, add `enableE2eTrustSeed?: boolean` to `AppModelOptions` and install this handler only when `options.enableE2eTrustSeed === true`. In `apps/mobile/src/App.tsx`, pass this option only when `process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1"`. The default must be false.

- [ ] **Step 5: Add Appium trust seed helper**

Create `apps/mobile/e2e/helpers/trust-seed.ts`:

```ts
import type { Browser } from "webdriverio";

export interface TrustedDesktopSeed {
  desktopId: string;
  displayName: string;
}

export async function seedTrustedDesktopThroughDeepLink(input: {
  driver: Browser;
  desktop: TrustedDesktopSeed;
}): Promise<void> {
  const url =
    `kanna://e2e-trust?desktopId=${encodeURIComponent(input.desktop.desktopId)}` +
    `&displayName=${encodeURIComponent(input.desktop.displayName)}`;
  await input.driver.execute("mobile: deepLink", { url });
}
```

This uses the app persistence layer and works for simulator and physical-device Appium sessions. It does not inject a server URL.

- [ ] **Step 6: Use desktop status only to seed trust**

In `apps/mobile/e2e/helpers/desktop.ts`, keep `assertDesktopServerReachable` for test harness preflight, and add:

```ts
export async function readDesktopIdentity(baseUrl: string): Promise<{
  desktopId: string;
  desktopName: string;
}> {
  const response = await fetch(`${baseUrl}/v1/status`);
  if (!response.ok) {
    throw new Error(`Desktop mobile server check failed for ${baseUrl}/v1/status: ${response.status}`);
  }
  const body = (await response.json()) as {
    desktopId?: string;
    desktopName?: string;
  };
  if (!body.desktopId || !body.desktopName) {
    throw new Error("Desktop status did not include desktopId and desktopName.");
  }
  return {
    desktopId: body.desktopId,
    desktopName: body.desktopName
  };
}
```

- [ ] **Step 7: Update E2E runner**

In `apps/mobile/e2e/run.ts`:

- remove both assignments to `process.env.EXPO_PUBLIC_KANNA_SERVER_URL`,
- keep `assertDesktopServerReachable(desktopServerUrl)` as harness preflight for smoke mode,
- call `readDesktopIdentity(desktopServerUrl)`,
- create the Appium session,
- open the trust seed deep link with the desktop id/name,
- call `ensureExpoServer({ metroPort: env.metroPort, projectRoot })`.

The smoke branch should include after `driver = await createMobileSession(...)`:

```ts
const desktopIdentity = await readDesktopIdentity(desktopServerUrl);
await seedTrustedDesktopThroughDeepLink({
  driver,
  desktop: {
    desktopId: desktopIdentity.desktopId,
    displayName: desktopIdentity.desktopName
  }
});
```

- [ ] **Step 8: Run E2E helper tests**

Run:

```bash
pnpm --dir apps/mobile test e2e/helpers/metro.test.ts e2e/helpers/desktop.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/e2eTrustSeed.ts apps/mobile/src/appModel.ts apps/mobile/e2e/run.ts apps/mobile/e2e/helpers/metro.ts apps/mobile/e2e/helpers/metro.test.ts apps/mobile/e2e/helpers/trust-seed.ts apps/mobile/e2e/helpers/desktop.ts apps/mobile/e2e/helpers/desktop.test.ts
git commit -m "test(mobile): seed trusted desktop for bonjour e2e"
```

## Task 6: Desktop Bonjour Advertisement for Mobile LAN

**Files:**
- Modify: `crates/kanna-server/Cargo.toml`
- Create: `crates/kanna-server/src/bonjour.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Test: `crates/kanna-server/src/bonjour.rs`

- [ ] **Step 1: Add mdns-sd dependency**

In `crates/kanna-server/Cargo.toml`, add:

```toml
mdns-sd = "0.19"
```

- [ ] **Step 2: Add service metadata unit tests**

Create `crates/kanna-server/src/bonjour.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_service_txt_contains_only_desktop_identity() {
        let txt = mobile_service_txt("desktop-1");
        assert_eq!(txt.get("desktopId").map(String::as_str), Some("desktop-1"));
        assert_eq!(txt.len(), 1);
    }

    #[test]
    fn mobile_service_type_is_stable() {
        assert_eq!(MOBILE_BONJOUR_SERVICE_TYPE, "_kanna-mobile._tcp.local.");
    }

    #[test]
    fn mobile_service_info_uses_desktop_name_and_port() {
        let info = build_mobile_service_info("Studio Mac", "desktop-1", 48120).unwrap();
        assert_eq!(info.get_type(), MOBILE_BONJOUR_SERVICE_TYPE);
        assert_eq!(info.get_fullname(), "Studio Mac._kanna-mobile._tcp.local.");
        assert_eq!(info.get_port(), 48120);
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
cargo test -p kanna-server bonjour
```

Expected: FAIL because the module is not wired and functions are missing.

- [ ] **Step 4: Implement mdns-sd advertisement**

In `crates/kanna-server/src/bonjour.rs`, add:

```rust
use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::collections::{HashMap, HashSet};

pub const MOBILE_BONJOUR_SERVICE_TYPE: &str = "_kanna-mobile._tcp.local.";

pub fn mobile_service_txt(desktop_id: &str) -> HashMap<String, String> {
    HashMap::from([("desktopId".to_string(), desktop_id.to_string())])
}

pub fn build_mobile_service_info(
    desktop_name: &str,
    desktop_id: &str,
    port: u16,
) -> Result<ServiceInfo, String> {
    let host_ipv4 = HashSet::from(["0.0.0.0".to_string()]);
    ServiceInfo::new(
        MOBILE_BONJOUR_SERVICE_TYPE,
        desktop_name,
        "local.",
        host_ipv4,
        port,
        Some(mobile_service_txt(desktop_id)),
    )
    .map_err(|error| format!("failed to build mobile Bonjour service: {error}"))
}

pub struct MobileBonjourAdvertisement {
    daemon: ServiceDaemon,
    fullname: String,
}

impl MobileBonjourAdvertisement {
    pub fn start(desktop_name: &str, desktop_id: &str, port: u16) -> Result<Self, String> {
        let daemon = ServiceDaemon::new()
            .map_err(|error| format!("failed to start mDNS daemon: {error}"))?;
        let service = build_mobile_service_info(desktop_name, desktop_id, port)?;
        let fullname = service.get_fullname().to_string();
        daemon
            .register(service)
            .map_err(|error| format!("failed to register mobile Bonjour service: {error}"))?;
        Ok(Self { daemon, fullname })
    }
}

impl Drop for MobileBonjourAdvertisement {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
    }
}
```

- [ ] **Step 5: Wire advertisement in server startup**

In `crates/kanna-server/src/main.rs`, add:

```rust
mod bonjour;
```

After config load and before awaiting the HTTP server forever, keep the advertisement handle alive:

```rust
let _mobile_bonjour = bonjour::MobileBonjourAdvertisement::start(
    &config.desktop_name,
    &config.desktop_id,
    config.lan_port,
)
.map_err(|error| {
    log::warn!("mobile Bonjour advertisement unavailable: {error}");
    error
})
.ok();
```

Do not unwrap this result. LAN HTTP must still run when Bonjour is blocked by platform permission or network state.

- [ ] **Step 6: Run Rust tests**

Run:

```bash
cargo test -p kanna-server bonjour
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/kanna-server/src/bonjour.rs crates/kanna-server/src/main.rs crates/kanna-server/Cargo.toml
git commit -m "feat(kanna-server): define mobile bonjour advertisement"
```

## Task 7: Full Verification

**Files:**
- Modify only if verification reveals focused defects.

- [ ] **Step 1: Run mobile tests**

Run:

```bash
pnpm --dir apps/mobile test src/App.test.tsx src/lib/discovery/trustedBonjour.test.ts src/lib/firebase/taskIndex.test.ts src/lib/transports/remoteTransport.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run mobile typecheck**

Run:

```bash
pnpm --dir apps/mobile typecheck
```

Expected: PASS.

- [ ] **Step 3: Run kd tests**

Run:

```bash
pnpm --dir tools/kd test tests/dev-plan.test.ts tests/cli.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run server tests**

Run:

```bash
cargo test -p kanna-server bonjour
```

Expected: PASS.

- [ ] **Step 5: Run non-cloud simulator smoke when local network permission can be granted**

Run:

```bash
./kd dev up --mobile --seed
pnpm --dir apps/mobile run test:e2e:smoke
```

Expected: PASS with tasks loaded through trusted Bonjour LAN. If iOS Local Network permission blocks automation, document the exact permission state and keep the unit/integration tests as the blocking evidence.

## Self-Review

- Spec coverage: cloud discovery, trusted-only Bonjour LAN, URL removal, kd cleanup, and non-cloud E2E trust seeding all have tasks.
- Placeholder scan: no TBD/TODO markers remain. Task 6 uses the existing workspace mDNS crate, `mdns-sd`, instead of leaving advertisement as a logging-only seam.
- Type consistency: `BonjourService`, `TrustedDesktopRecord`, and `FetchLike` names match existing mobile types and planned imports.
