# Agent Provider Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Rust definition authoritative for agent provider identity and stable metadata, generate the TypeScript registry from it, and align provider selection across server and frontend compatibility paths.

**Architecture:** `kanna-agent-protocol` owns provider identity, executable mapping, default session type, and headless capability. Its existing `ts-rs` workflow emits committed TypeScript types plus a runtime registry. The daemon and server reuse the Rust definition; TypeScript consumers reuse the generated registry; a shared fixture locks selection precedence and availability behavior across languages.

**Tech Stack:** Rust, Serde, ts-rs, TypeScript, Vitest, JSON Schema, Cargo, Bazel.

---

### Task 1: Define and Generate the Shared Provider Registry

**Files:**
- Create: `crates/kanna-agent-protocol/src/providers.rs`
- Create: `crates/kanna-agent-protocol/tests/providers.rs`
- Modify: `crates/kanna-agent-protocol/src/lib.rs`
- Modify: `packages/agent-protocol/src/index.ts`
- Generate: `packages/agent-protocol/src/generated/AgentProvider.ts`
- Generate: `packages/agent-protocol/src/generated/AgentSessionType.ts`
- Generate: `packages/agent-protocol/src/generated/AgentProviderSpec.ts`
- Generate: `packages/agent-protocol/src/generated/AgentProviderRegistry.ts`

- [ ] **Step 1: Add failing provider contract tests**

Create `crates/kanna-agent-protocol/tests/providers.rs`:

```rust
use kanna_agent_protocol::{agent_provider_specs, AgentProvider, AgentSessionType};
use std::str::FromStr;

#[test]
fn registry_covers_every_provider_once() {
    let specs = agent_provider_specs();
    assert_eq!(specs.len(), AgentProvider::ALL.len());
    for provider in AgentProvider::ALL {
        assert_eq!(specs.iter().filter(|spec| spec.id == provider).count(), 1);
    }
}

#[test]
fn provider_metadata_matches_runtime_contracts() {
    assert_eq!(AgentProvider::Antigravity.executable(), "agy");
    assert_eq!(AgentProvider::Copilot.default_session_type(), AgentSessionType::Pty);
    assert_eq!(AgentProvider::Opencode.default_session_type(), AgentSessionType::Agent);
    assert!(AgentProvider::Claude.supports_headless());
    assert!(AgentProvider::Codex.supports_headless());
    assert!(AgentProvider::Opencode.supports_headless());
    assert!(!AgentProvider::Antigravity.supports_headless());
}

#[test]
fn provider_strings_round_trip() {
    for provider in AgentProvider::ALL {
        assert_eq!(AgentProvider::from_str(provider.as_str()).unwrap(), provider);
        assert_eq!(serde_json::from_str::<AgentProvider>(
            &serde_json::to_string(&provider).unwrap()
        ).unwrap(), provider);
    }
    assert!(AgentProvider::from_str("future-agent").is_err());
}
```

- [ ] **Step 2: Verify the tests are red**

```bash
cargo test -p kanna-agent-protocol --test providers -- --nocapture
```

Expected: compilation fails because the provider types and registry do not exist.

- [ ] **Step 3: Implement the Rust source of truth**

Create `crates/kanna-agent-protocol/src/providers.rs` with these public shapes and metadata:

```rust
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum AgentProvider {
    Claude,
    Copilot,
    Codex,
    Opencode,
    Antigravity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum AgentSessionType {
    Pty,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct AgentProviderSpec {
    pub id: AgentProvider,
    pub executable: String,
    pub default_session_type: AgentSessionType,
    pub supports_headless: bool,
}
```

Implement:

```rust
impl AgentProvider {
    pub const ALL: [Self; 5] = [
        Self::Claude,
        Self::Copilot,
        Self::Codex,
        Self::Opencode,
        Self::Antigravity,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Copilot => "copilot",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Antigravity => "antigravity",
        }
    }

    pub const fn executable(self) -> &'static str {
        match self {
            Self::Antigravity => "agy",
            _ => self.as_str(),
        }
    }

    pub const fn default_session_type(self) -> AgentSessionType {
        match self {
            Self::Claude | Self::Codex | Self::Opencode => AgentSessionType::Agent,
            Self::Copilot | Self::Antigravity => AgentSessionType::Pty,
        }
    }

    pub const fn supports_headless(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Opencode)
    }
}

impl AgentSessionType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pty => "pty",
            Self::Agent => "agent",
        }
    }
}

impl fmt::Display for AgentProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for AgentProvider {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL.into_iter()
            .find(|provider| provider.as_str() == value)
            .ok_or_else(|| format!("unsupported agent provider: {value}"))
    }
}

pub fn agent_provider_specs() -> Vec<AgentProviderSpec> {
    AgentProvider::ALL.into_iter().map(|provider| AgentProviderSpec {
        id: provider,
        executable: provider.executable().to_string(),
        default_session_type: provider.default_session_type(),
        supports_headless: provider.supports_headless(),
    }).collect()
}
```

Export all three types and `agent_provider_specs` from `crates/kanna-agent-protocol/src/lib.rs`.

- [ ] **Step 4: Extend the existing generation test**

Under `#[cfg(all(test, feature = "typescript"))]`, add this generation test in `providers.rs`:

```rust
#[test]
fn export_bindings_provider_registry() {
    let output_dir = std::env::var("TS_RS_EXPORT_DIR")
        .expect("TS_RS_EXPORT_DIR must be set by the protocol generator");
    let specs_json = serde_json::to_string_pretty(&agent_provider_specs()).unwrap();
    let source = format!(
        r#"// Generated from crates/kanna-agent-protocol. Do not edit manually.
import type {{ AgentProvider }} from "./AgentProvider";
import type {{ AgentProviderSpec }} from "./AgentProviderSpec";

export const AGENT_PROVIDER_SPECS = {specs_json}
  as const satisfies readonly AgentProviderSpec[];
export const AGENT_PROVIDERS: readonly AgentProvider[] =
  AGENT_PROVIDER_SPECS.map(({{ id }}) => id);

export function isAgentProvider(value: unknown): value is AgentProvider {{
  return typeof value === "string"
    && AGENT_PROVIDERS.includes(value as AgentProvider);
}}

export function getAgentProviderSpec(provider: AgentProvider): AgentProviderSpec {{
  const spec = AGENT_PROVIDER_SPECS.find((candidate) => candidate.id === provider);
  if (!spec) throw new Error(`Unknown agent provider: ${{provider}}`);
  return spec;
}}
"#,
    );
    std::fs::write(
        std::path::Path::new(&output_dir).join("AgentProviderRegistry.ts"),
        source,
    )
    .unwrap();
}
```

Do not add another generator dependency.

- [ ] **Step 5: Regenerate and export the TypeScript API**

```bash
./scripts/generate-agent-protocol-types.sh
```

Add to `packages/agent-protocol/src/index.ts`:

```ts
export type { AgentProvider } from "./generated/AgentProvider";
export type { AgentProviderSpec } from "./generated/AgentProviderSpec";
export type { AgentSessionType } from "./generated/AgentSessionType";
export {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_SPECS,
  getAgentProviderSpec,
  isAgentProvider,
} from "./generated/AgentProviderRegistry";
```

- [ ] **Step 6: Verify and commit the registry**

```bash
cargo test -p kanna-agent-protocol
./scripts/check-agent-protocol-types.sh
pnpm --filter @kanna/agent-protocol test
cargo fmt -p kanna-agent-protocol -- --check
```

Expected: Rust tests, generated freshness, TypeScript typecheck, and formatting pass.

```bash
git add crates/kanna-agent-protocol packages/agent-protocol
git commit -m "feat: centralize agent provider metadata"
```

### Task 2: Reuse the Registry and Align Rust Resolution

**Files:**
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/kanna-server/src/task_creator/provider.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/commands.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Create: `crates/kanna-agent-protocol/src/provider_resolution_cases.json`
- Modify: `crates/kanna-agent-protocol/BUILD.bazel`

- [ ] **Step 1: Add shared resolution fixtures and failing Rust coverage**

Create `crates/kanna-agent-protocol/src/provider_resolution_cases.json`:

```json
[
  {
    "name": "explicit wins",
    "explicit": ["codex"],
    "stage": ["claude"],
    "agent": ["copilot"],
    "fallback": ["opencode"],
    "available": ["codex", "claude"],
    "expected": "codex"
  },
  {
    "name": "stage wins over agent and fallback",
    "stage": ["codex", "claude"],
    "agent": ["copilot"],
    "fallback": ["opencode"],
    "available": ["claude", "copilot", "opencode"],
    "expected": "claude"
  },
  {
    "name": "agent wins over fallback",
    "agent": ["copilot"],
    "fallback": ["claude"],
    "available": ["copilot", "claude"],
    "expected": "copilot"
  },
  {
    "name": "fallback is last",
    "fallback": ["opencode"],
    "available": ["opencode"],
    "expected": "opencode"
  },
  {
    "name": "selected source never falls through",
    "stage": ["codex"],
    "agent": ["claude"],
    "available": ["claude"],
    "error": "None of the configured agent providers are available: codex."
  },
  {
    "name": "missing sources fail",
    "available": ["claude"],
    "error": "No agent provider configured for this request."
  }
]
```

Expose the fixture from `providers.rs` so Cargo and Bazel share the same source input:

```rust
pub const PROVIDER_RESOLUTION_CASES_JSON: &str =
    include_str!("provider_resolution_cases.json");
```

Re-export the constant from `lib.rs`. Add this test scaffolding to `crates/kanna-server/src/task_creator/tests/core.rs`:

```rust
#[derive(serde::Deserialize)]
struct ProviderResolutionCase {
    name: String,
    #[serde(default)]
    explicit: Vec<String>,
    #[serde(default)]
    stage: Vec<String>,
    #[serde(default)]
    agent: Vec<String>,
    #[serde(default)]
    fallback: Vec<String>,
    #[serde(default)]
    available: Vec<String>,
    expected: Option<String>,
    error: Option<String>,
}

fn joined(values: &[String]) -> Option<String> {
    (!values.is_empty()).then(|| values.join(","))
}

#[test]
fn provider_resolution_cases_match_shared_contract() {
    let cases: Vec<ProviderResolutionCase> = serde_json::from_str(
        kanna_agent_protocol::PROVIDER_RESOLUTION_CASES_JSON,
    ).unwrap();

    for case in cases {
        let agent = (!case.agent.is_empty()).then(|| AgentDefinition {
            prompt: String::new(),
            agent_providers: case.agent.clone(),
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
        });
        let available = case.available.clone();
        let result = resolve_agent_provider_with(
            joined(&case.explicit).as_deref(),
            joined(&case.stage).as_deref(),
            agent.as_ref(),
            joined(&case.fallback).as_deref(),
            |provider| available.iter().any(|value| value == provider.as_str()),
        );

        match (case.expected, case.error) {
            (Some(expected), None) => assert_eq!(result.unwrap().as_str(), expected, "{}", case.name),
            (None, Some(error)) => assert_eq!(result.unwrap_err(), error, "{}", case.name),
            _ => panic!("invalid provider fixture: {}", case.name),
        }
    }
}

#[test]
fn provider_resolution_rejects_unknown_values() {
    assert_eq!(
        resolve_agent_provider_with(
            Some("future-agent"), None, None, None, |_| true,
        ).unwrap_err(),
        "unsupported agent provider: future-agent",
    );
}
```

- [ ] **Step 2: Verify resolution coverage is red**

```bash
cargo test -p kanna-server provider_resolution_cases -- --nocapture
```

Expected: compilation fails because the injectable precedence-aware resolver does not exist.

- [ ] **Step 3: Re-export the shared daemon wire type**

Replace the daemon-local enum in `crates/daemon/src/protocol.rs` with:

```rust
pub use kanna_agent_protocol::{
    AgentEvent as NeutralAgentEvent,
    AgentProvider,
    PermissionDecision,
};
```

This preserves `kanna_daemon::protocol::AgentProvider` for existing consumers while removing the duplicate definition.

- [ ] **Step 4: Refactor the server provider module**

Replace server-local provider/session enums with:

```rust
pub(super) use kanna_agent_protocol::{AgentProvider, AgentSessionType};
use std::str::FromStr;
```

Make `resolve_agent_type` use `provider.default_session_type()` when no explicit `pty`, `agent`, `sdk`, or `chat` value is supplied. Delete `provider_binary_name`; in `commands.rs` build the command with `provider.executable().to_string()`, and use the same method for availability checks.

Change the resolver signature to express precedence directly:

```rust
pub(super) fn resolve_agent_provider(
    explicit_provider: Option<&str>,
    stage_provider: Option<&str>,
    agent: Option<&AgentDefinition>,
    fallback_provider: Option<&str>,
) -> Result<AgentProvider, String> {
    resolve_agent_provider_with(
        explicit_provider,
        stage_provider,
        agent,
        fallback_provider,
        |provider| binary_available(provider.executable()),
    )
}
```

The testable helper selects the first non-empty source in `explicit`, `stage`, `agent.agent_providers`, `fallback` order, parses every selected candidate with `AgentProvider::from_str`, returns the first available candidate, and otherwise returns exactly:

```rust
pub(super) fn resolve_agent_provider_with(
    explicit_provider: Option<&str>,
    stage_provider: Option<&str>,
    agent: Option<&AgentDefinition>,
    fallback_provider: Option<&str>,
    is_available: impl Fn(AgentProvider) -> bool,
) -> Result<AgentProvider, String> {
    let string_source = explicit_provider
        .filter(|value| !value.trim().is_empty())
        .or_else(|| stage_provider.filter(|value| !value.trim().is_empty()));

    let raw_candidates = if let Some(source) = string_source {
        source.split(',').map(str::trim).filter(|value| !value.is_empty())
            .map(str::to_string).collect::<Vec<_>>()
    } else if let Some(agent) = agent.filter(|agent| !agent.agent_providers.is_empty()) {
        agent.agent_providers.clone()
    } else if let Some(source) = fallback_provider.filter(|value| !value.trim().is_empty()) {
        source.split(',').map(str::trim).filter(|value| !value.is_empty())
            .map(str::to_string).collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    if raw_candidates.is_empty() {
        return Err("No agent provider configured for this request.".to_string());
    }

    let candidates = raw_candidates.iter()
        .map(|candidate| AgentProvider::from_str(candidate))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(provider) = candidates.iter().copied().find(|provider| is_available(*provider)) {
        return Ok(provider);
    }

    Err(format!(
        "None of the configured agent providers are available: {}.",
        candidates.iter().map(|provider| provider.as_str()).collect::<Vec<_>>().join(", ")
    ))
}
```

An empty source set returns `No agent provider configured for this request.`. Do not consult a lower-precedence source after selecting a non-empty source.

- [ ] **Step 5: Correct every server call site**

Use the new argument order in `task_creator/mod.rs`:

| Flow | Explicit | Stage | Agent | Fallback |
|---|---|---|---|---|
| `prepare_rerun_stage_for_api` | `None` | current stage | definition | stored task provider |
| `prepare_stage_run_spawn` | supplied override | target stage | definition | `None` |
| `create_dormant_task_for_api` | request provider | initial stage | definition | user default |
| `prepare_start_dormant_task_for_api` | `None` | stored stage | definition | stored task provider |
| `resolve_task_spawn` | request override | stage unless a custom agent was explicitly selected | definition | user default unless a custom agent was explicitly selected |

Use `AgentProvider::from_str` in `read_default_agent_provider_setting`; preserve the existing fallback to Claude for an invalid persisted setting.

- [ ] **Step 6: Include the fixture in Bazel Rust sources**

Change each `srcs` glob in `crates/kanna-agent-protocol/BUILD.bazel` from:

```python
glob(["src/**/*.rs"])
```

to:

```python
glob(["src/**/*.rs", "src/**/*.json"])
```

- [ ] **Step 7: Verify and commit Rust alignment**

```bash
cargo test -p kanna-agent-protocol
cargo test -p kanna-daemon --lib
cargo test -p kanna-server task_creator::tests -- --test-threads=1
cargo fmt --all -- --check
```

Expected: registry, daemon protocol, server task-creation, resolution fixtures, and formatting pass.

```bash
git add crates/kanna-agent-protocol/BUILD.bazel \
  crates/kanna-agent-protocol/src/provider_resolution_cases.json \
  crates/daemon/src/protocol.rs crates/kanna-server/src/task_creator
git commit -m "refactor: align Rust agent provider resolution"
```

### Task 3: Replace TypeScript Provider Definitions and Lists

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/core/src/config/agent-providers.ts`
- Modify: `packages/core/src/config/custom-tasks.ts`
- Modify: `packages/core/src/workflow/agent-loader.ts`
- Modify: `packages/core/src/workflow/workflow-loader.ts`
- Modify: `packages/core/src/workflow/workflow-loader.test.ts`
- Modify: `packages/core/src/workflow/workflow-types.ts`
- Modify: `packages/db/package.json`
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/types/kanna.ts`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Modify: `apps/desktop/src/components/MainPanel.vue`
- Modify: `apps/desktop/src/components/PreferencesPanel.vue`
- Modify: `apps/desktop/src/components/__tests__/MainPanel.test.ts`
- Modify: `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`
- Modify: `apps/desktop/src/components/__tests__/PreferencesPanel.theme.test.ts`
- Modify: `apps/desktop/src/stores/agent-provider.ts`
- Modify: `apps/desktop/src/stores/agent-provider.test.ts`
- Modify: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/components/NewTaskModal.vue`
- Modify: `apps/desktop/src/utils/agentChoiceUsage.ts`
- Modify: `apps/desktop/src/stores/e2eRealAgentOverride.ts`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/sessionPersistence.ts`
- Modify: `apps/mobile/src/components/CreateTaskComposer.tsx`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing TypeScript registry and fixture coverage**

In `apps/desktop/src/stores/agent-provider.test.ts`, import `AGENT_PROVIDERS`, `getAgentProviderSpec`, and `isAgentProvider` from `@kanna/agent-protocol`. Add:

```ts
it("exposes every provider with executable and session metadata", () => {
  expect(AGENT_PROVIDERS).toEqual([
    "claude", "copilot", "codex", "opencode", "antigravity",
  ]);
  expect(getAgentProviderSpec("antigravity").executable).toBe("agy");
  expect(getAgentProviderSpec("opencode").default_session_type).toBe("agent");
  expect(isAgentProvider("future-agent")).toBe(false);
});
```

Read and execute the shared cases in the same test file:

```ts
interface ProviderResolutionCase {
  name: string;
  explicit?: string[];
  stage?: string[];
  agent?: string[];
  fallback?: string[];
  available: string[];
  expected?: string;
  error?: string;
}

const resolutionCases = JSON.parse(readFileSync(resolve(
  process.cwd(),
  "../..",
  "crates/kanna-agent-protocol/src/provider_resolution_cases.json",
), "utf8")) as ProviderResolutionCase[];

it.each(resolutionCases)("matches shared resolution case: $name", (testCase) => {
  const known = (values?: string[]) => values?.filter(isAgentProvider);
  const selected = getPreferredAgentProviders({
    explicit: known(testCase.explicit),
    stage: known(testCase.stage),
    agent: known(testCase.agent),
    item: known(testCase.fallback),
  });
  const availability = Object.fromEntries(
    AGENT_PROVIDERS.map((provider) => [
      provider,
      testCase.available.includes(provider),
    ]),
  ) as AgentProviderAvailability;

  if (testCase.expected) {
    expect(resolveAgentProvider(selected, availability)).toBe(testCase.expected);
  } else {
    expect(() => resolveAgentProvider(selected, availability)).toThrow(testCase.error);
  }
});
```

Add `readFileSync`, `resolve`, and the generated provider imports used by this code.

- [ ] **Step 2: Verify TypeScript coverage is red**

```bash
pnpm --dir apps/desktop test -- src/stores/agent-provider.test.ts
```

Expected: imports or fixture-driven expectations fail until consumers use the generated contract.

- [ ] **Step 3: Re-export provider helpers from core and replace unions**

Add `"@kanna/agent-protocol": "workspace:*"` to `packages/core`, `packages/db`, and `apps/desktop` dependencies. Replace `packages/core/src/config/agent-providers.ts` identity declarations with:

```ts
import {
  AGENT_PROVIDERS,
  isAgentProvider,
  type AgentProvider,
} from "@kanna/agent-protocol";

export const VALID_AGENT_PROVIDERS = AGENT_PROVIDERS;
export { isAgentProvider };
export type KnownAgentProvider = AgentProvider;
```

Keep `splitAgentProviderValue` unchanged. Use `AgentProvider` for `CustomTaskConfig.agentProvider`, workflow stage/post/agent definition provider selections, `packages/db/src/schema.ts`, `apps/desktop/src/types/kanna.ts`, and mobile's `ComposerAgentProvider` alias:

```ts
export type ComposerAgentProvider = AgentProvider;
```

Re-export the desktop type so current relative imports remain source-compatible:

```ts
export type { AgentProvider } from "@kanna/agent-protocol";
import type { AgentProvider } from "@kanna/agent-protocol";
```

In `workflow-loader.ts`, validate raw workflow provider selections through the generated guard instead of casting arbitrary strings:

```ts
function parseAgentProviderSelection(
  value: unknown,
  location: string,
): AgentProvider | AgentProvider[] | undefined {
  if (value === undefined) return undefined;
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : null;
  if (!values || values.length === 0) {
    throw validationError(`${location} has an invalid agent_provider value`);
  }
  const invalid = values.filter((provider) => !isAgentProvider(provider));
  if (invalid.length > 0) {
    throw validationError(
      `${location} has unsupported agent_provider values: ${invalid.join(", ")}`,
    );
  }
  return typeof value === "string"
    ? values[0] as AgentProvider
    : values as AgentProvider[];
}
```

Use this helper for normal stages, posts, and folded legacy posts. Add a `workflow-loader.test.ts` case with `agent_provider: "future-agent"` and assert the unsupported-provider error before implementing the helper. After `agent-loader.ts` has rejected invalid tokens, assign its validated list as `AgentProvider[]` rather than retaining a `string[]` cast.

- [ ] **Step 4: Replace availability and validation duplication**

In `apps/desktop/src/stores/agent-provider.ts` use:

```ts
export type AgentProviderAvailability = Record<AgentProvider, boolean>;
```

In `sessions.ts`, replace the binary helper and fixed five-promise tuple with:

```ts
async function isAgentProviderAvailable(provider: AgentProvider): Promise<boolean> {
  return Boolean(await whichBinaryOptional(getAgentProviderSpec(provider).executable));
}

async function getAgentProviderAvailability(): Promise<AgentProviderAvailability> {
  const entries = await Promise.all(
    AGENT_PROVIDERS.map(async (provider) => [
      provider,
      await isAgentProviderAvailable(provider),
    ] as const),
  );
  return Object.fromEntries(entries) as AgentProviderAvailability;
}
```

Use generated `isAgentProvider` in `agentChoiceUsage.ts`, `e2eRealAgentOverride.ts`, `desktopCloudTaskIndex.ts`, and mobile persistence rather than local equality chains. Replace both desktop `firstSupportedAgentProvider` implementations in `App.vue` and `useAppTaskCreation.ts` with:

```ts
function firstSupportedAgentProvider(
  provider: AgentProvider | AgentProvider[] | string | string[] | undefined,
): AgentProvider | undefined {
  const providers = Array.isArray(provider) ? provider : [provider];
  return providers.find(isAgentProvider);
}
```

In `useAppLifecycle.ts`, replace the saved-provider equality chain with:

```ts
const savedAgentProvider = await getDesktopSetting("defaultAgentProvider");
if (isAgentProvider(savedAgentProvider)) {
  preferences.defaultAgentProvider = savedAgentProvider;
}
```

- [ ] **Step 5: Derive desktop and mobile choices from the registry**

In `NewTaskModal.vue`, replace the provider array, binary helper, and chat-mode helper with `AGENT_PROVIDERS`, `getAgentProviderSpec`, and:

```ts
const providers = [...AGENT_PROVIDERS];

function providerBinary(provider: AgentProvider): string {
  return getAgentProviderSpec(provider).executable;
}

function supportsChatMode(provider: AgentProvider): boolean {
  return getAgentProviderSpec(provider).supports_headless;
}
```

In `PreferencesPanel.vue`, derive normal and headless options and validate emitted values:

```ts
const providerOptions = AGENT_PROVIDERS;
const headlessProviderOptions = AGENT_PROVIDER_SPECS
  .filter((spec) => spec.supports_headless)
  .map((spec) => spec.id);

const defaultAgentSelection = computed(() => {
  const provider = props.preferences.defaultAgentProvider;
  return props.preferences.defaultAgentType === "agent"
    && getAgentProviderSpec(provider).supports_headless
    ? `${provider}-sdk`
    : provider;
});

function handleDefaultAgentChange(value: string) {
  const headless = value.endsWith("-sdk");
  const rawProvider = headless ? value.slice(0, -4) : value;
  if (!isAgentProvider(rawProvider)) return;
  emit("update", "defaultAgentProvider", rawProvider);
  emit("update", "defaultAgentType", headless ? "agent" : "pty");
}
```

Render both lists with `v-for`, using `${provider}-sdk` only for the headless list. This adds the already-supported OpenCode headless option without hardcoded provider checks.

In `MainPanel.vue`, keep installation instructions localized to that component but make every provider-specific mapping exhaustive and derive executable names/status checks from the registry:

```ts
interface AgentCardMetadata {
  nameKey: string;
  sortName: string;
  installCommand: string;
}

const AGENT_CARD_METADATA: Record<AgentProvider, AgentCardMetadata> = {
  claude: { nameKey: "mainPanel.agentClaudeName", sortName: "Claude Code", installCommand: "curl -fsSL https://claude.ai/install.sh | bash" },
  copilot: { nameKey: "mainPanel.agentCopilotName", sortName: "GitHub Copilot", installCommand: "curl -fsSL https://gh.io/copilot-install | bash" },
  codex: { nameKey: "mainPanel.agentCodexName", sortName: "OpenAI Codex", installCommand: "npm install -g @openai/codex" },
  opencode: { nameKey: "mainPanel.agentOpenCodeName", sortName: "OpenCode", installCommand: "curl -fsSL https://opencode.ai/install | bash" },
  antigravity: { nameKey: "mainPanel.agentAntigravityName", sortName: "Google Antigravity", installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
};

const statusByProvider: Record<AgentProvider, Ref<AgentCliStatus>> = {
  claude, copilot, codex, opencode, antigravity,
};

const agentCards = computed(() => AGENT_PROVIDERS.map((provider) => ({
  key: provider,
  ...AGENT_CARD_METADATA[provider],
  status: statusByProvider[provider].value,
})));

async function checkAllClis() {
  const statuses = await Promise.all(
    AGENT_PROVIDERS.map(async (provider) => [provider, await checkCli(provider)] as const),
  );
  for (const [provider, status] of statuses) statusByProvider[provider].value = status;
}
```

Make `checkCli` call `getAgentProviderSpec(provider).executable`; delete `AGENT_CLI_BINARIES` and use `AGENT_CARD_METADATA[provider].installCommand` when copying an install command.

In mobile `CreateTaskComposer.tsx`, preserve localized presentation through an exhaustive label map and derive options:

```ts
const AGENT_LABELS: Record<AgentProvider, string> = {
  claude: "Claude",
  copilot: "Copilot",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

const AGENT_OPTIONS = AGENT_PROVIDERS.map((provider) => ({
  provider,
  label: AGENT_LABELS[provider],
}));
```

Update the three component test files to assert all five PTY providers and all three headless-capable providers are rendered, OpenCode can be selected in agent mode, and MainPanel still exposes every installation card.

- [ ] **Step 6: Refresh dependencies and verify TypeScript consumers**

```bash
pnpm install --lockfile-only
pnpm --filter @kanna/agent-protocol test
pnpm --filter @kanna/core test
pnpm --filter @kanna/db test
pnpm --dir apps/desktop test -- src/stores/agent-provider.test.ts src/components/__tests__/NewTaskModal.test.ts
pnpm --dir apps/desktop build
pnpm --dir apps/mobile typecheck
```

Expected: registry fixtures, core/db tests, desktop tests/build, and mobile typecheck pass. OpenCode now receives the headless-agent choice already supported by its adapter.

- [ ] **Step 7: Commit TypeScript consumers**

```bash
git add packages/core packages/db apps/desktop apps/mobile pnpm-lock.yaml
git commit -m "refactor: consume generated agent provider registry"
```

### Task 4: Consolidate and Guard the Workflow Schema

**Files:**
- Modify: `.kanna/workflows/schema.json`
- Modify: `packages/core/src/workflow/qa-assets.test.ts`

- [ ] **Step 1: Add a failing schema parity test**

Import `AGENT_PROVIDERS` in `qa-assets.test.ts` and add:

```ts
it("keeps the workflow provider schema aligned with the generated registry", () => {
  const schema = JSON.parse(readRepoFile(".kanna/workflows/schema.json")) as {
    $defs?: { agentProvider?: { enum?: string[] } };
  };
  expect(schema.$defs?.agentProvider?.enum).toEqual([...AGENT_PROVIDERS]);
});
```

- [ ] **Step 2: Verify the schema test is red**

```bash
pnpm --dir packages/core exec vitest run src/workflow/qa-assets.test.ts
```

Expected: FAIL because the schema has no shared `$defs.agentProvider`.

- [ ] **Step 3: Consolidate the schema**

Add:

```json
"$defs": {
  "agentProvider": {
    "enum": ["claude", "copilot", "codex", "opencode", "antigravity"]
  },
  "agentProviderSelection": {
    "oneOf": [
      { "$ref": "#/$defs/agentProvider" },
      {
        "type": "array",
        "items": { "$ref": "#/$defs/agentProvider" },
        "minItems": 1
      }
    ]
  }
}
```

Replace both stage and post `agent_provider` definitions with:

```json
{ "$ref": "#/$defs/agentProviderSelection" }
```

- [ ] **Step 4: Verify and commit schema parity**

```bash
pnpm --dir packages/core test
./scripts/check-agent-protocol-types.sh
git diff --check
```

Expected: schema parity, core tests, generated freshness, and whitespace checks pass.

```bash
git add .kanna/workflows/schema.json packages/core/src/workflow/qa-assets.test.ts
git commit -m "test: guard workflow provider schema parity"
```

### Task 5: Verify the Cross-Language Boundary

- [ ] **Step 1: Run generated and focused suites**

```bash
cargo test -p kanna-agent-protocol
./scripts/check-agent-protocol-types.sh
cargo test -p kanna-server task_creator::tests -- --test-threads=1
cargo test -p kanna-daemon --lib
pnpm --filter @kanna/agent-protocol test
pnpm --filter @kanna/core test
pnpm --filter @kanna/db test
pnpm --dir apps/desktop test -- src/stores/agent-provider.test.ts src/components/__tests__/NewTaskModal.test.ts
pnpm --dir apps/mobile typecheck
```

Expected: all Rust and TypeScript provider contracts pass.

- [ ] **Step 2: Run build-system checks**

```bash
cargo fmt --all -- --check
pnpm --dir apps/desktop build
./kd build sidecars
git diff --check
```

Expected: formatting, desktop build, sidecar staging, and whitespace checks succeed. No hand-maintained TypeScript provider union or provider option list remains outside generated protocol output or an exhaustive provider-specific mapping.
