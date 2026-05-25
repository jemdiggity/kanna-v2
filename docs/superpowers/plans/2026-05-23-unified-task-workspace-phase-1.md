# Unified Task Workspace Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract local, LAN, and cloud task merge/dedupe policy into a tested workspace model and make the desktop sidebar consume that model so each logical task appears once.

**Architecture:** Add a pure `apps/desktop/src/workspace/` layer that normalizes local tasks, cloud snapshots, and LAN snapshots into `WorkspaceTask` and `WorkspaceRepo` view models. `App.vue` should stop directly concatenating `store.items` with remote snapshots and instead consume the workspace builder output for sidebar lists and navigation. Existing terminal routing can remain in `MainPanel` for this phase, but the selected task should come from workspace-normalized data.

**Tech Stack:** Vue 3, Pinia, TypeScript, Vitest, existing desktop E2E harness, Firebase emulator, LAN transfer sidecar.

---

## Scope Check

The approved design covers a multi-phase workspace architecture.
This plan implements Phase 1 only:

- pure workspace types and builder,
- dedupe for local/cloud/LAN task copies,
- repo grouping by local repo or remote hash,
- capability flags sufficient for sidebar and terminal selection,
- `App.vue` consumption for sidebar lists and navigation,
- focused unit and E2E sanity checks.

This plan does not implement the later capability-driven action adapter, cloud subscription enforcement, mobile parity, or full transfer expansion.

## File Structure

- Create `apps/desktop/src/workspace/types.ts`: normalized workspace type definitions and route/capability enums.
- Create `apps/desktop/src/workspace/buildWorkspace.ts`: pure builder that accepts local repos/tasks plus remote snapshots and emits workspace repos/tasks.
- Create `apps/desktop/src/workspace/buildWorkspace.test.ts`: unit coverage for dedupe, repo grouping, route preference, and closed-task suppression.
- Modify `apps/desktop/src/App.vue`: replace direct local/remote sidebar concatenation with `buildWorkspace`.
- Modify `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`: keep and tighten cloud duplicate sanity checks.
- Modify `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`: keep and tighten LAN duplicate sanity checks.

## Task 1: Workspace Types

**Files:**
- Create: `apps/desktop/src/workspace/types.ts`

- [ ] **Step 1: Create workspace type definitions**

Create `apps/desktop/src/workspace/types.ts`:

```ts
import type { PipelineItem, Repo } from "@kanna/db";
import type {
  DesktopCloudRepo,
  DesktopCloudSnapshot,
  DesktopCloudTerminalRef,
} from "../services/desktopCloudTaskIndex";

export type WorkspaceSourceKind = "local" | "cloud" | "lan";
export type WorkspaceRepoSource = "local-only" | "remote-only" | "mixed";
export type WorkspaceReachability = "local" | "reachable" | "offline" | "unknown" | "stale";
export type WorkspaceTerminalRouteKind = "local" | "cloud" | "lan" | "none";

export interface WorkspaceOwner {
  kind: "local" | "remote";
  id: string;
  label?: string | null;
}

export interface WorkspaceTerminalRoute {
  kind: WorkspaceTerminalRouteKind;
  localSessionId?: string;
  remoteRef?: DesktopCloudTerminalRef;
}

export interface WorkspaceCapabilities {
  canOpenTerminal: boolean;
  canSendInput: boolean;
  canClose: boolean;
  canCreateSiblingTask: boolean;
  canPushToMachine: boolean;
  canPullFromMachine: boolean;
  canOpenDiff: boolean;
  canOpenInIde: boolean;
}

export interface WorkspaceRepo {
  key: string;
  localRepoId: string | null;
  remoteRepoIds: string[];
  name: string;
  path: string | null;
  remoteUrl: string | null;
  remoteUrlHash: string | null;
  defaultBranch: string | null;
  source: WorkspaceRepoSource;
}

export interface WorkspaceTaskSource {
  kind: WorkspaceSourceKind;
  taskId: string;
  repoId: string;
  updatedAt: string;
  terminalRef?: DesktopCloudTerminalRef;
}

export interface WorkspaceTask {
  id: string;
  logicalTaskKey: string;
  localTaskId: string | null;
  remoteTaskIds: string[];
  repoKey: string;
  item: PipelineItem;
  owner: WorkspaceOwner;
  sources: WorkspaceTaskSource[];
  reachability: WorkspaceReachability;
  capabilities: WorkspaceCapabilities;
  terminal: WorkspaceTerminalRoute;
}

export interface LocalRepoWithRemote {
  repo: Repo;
  remoteUrlHash: string | null;
  remoteUrl?: string | null;
}

export interface BuildWorkspaceInput {
  localRepos: LocalRepoWithRemote[];
  localItems: PipelineItem[];
  cloudSnapshot: DesktopCloudSnapshot;
  lanSnapshot: DesktopCloudSnapshot;
}

export interface BuildWorkspaceResult {
  repos: WorkspaceRepo[];
  tasks: WorkspaceTask[];
}

export type RemoteRepo = DesktopCloudRepo;
```

- [ ] **Step 2: Commit type shell**

Run:

```bash
git add apps/desktop/src/workspace/types.ts
git commit -m "feat: add workspace task types"
```

Expected: commit succeeds.

## Task 2: Workspace Builder Unit Tests

**Files:**
- Create: `apps/desktop/src/workspace/buildWorkspace.test.ts`
- Create: `apps/desktop/src/workspace/buildWorkspace.ts`

- [ ] **Step 1: Add failing unit tests**

Create `apps/desktop/src/workspace/buildWorkspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PipelineItem, Repo } from "@kanna/db";
import { buildWorkspace } from "./buildWorkspace";

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-local",
    path: "/repo",
    name: "kanna",
    default_branch: "main",
    hidden: 0,
    sort_order: 0,
    created_at: "2026-05-23T00:00:00.000Z",
    last_opened_at: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-local",
    repo_id: "repo-local",
    prompt: "Build workspace",
    pipeline: "default",
    stage: "in progress",
    tags: "[\"in progress\"]",
    pr_number: null,
    pr_url: null,
    branch: "task-local",
    activity: "working",
    activity_changed_at: "2026-05-23T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    display_name: null,
    issue_number: null,
    issue_title: null,
    closed_at: null,
    agent_session_id: null,
    base_ref: "origin/main",
    agent_provider: "codex",
    agent_type: "sdk",
    previous_stage: null,
    stage_result: null,
    teardown_started_at: null,
    last_output_preview: null,
    active_post_action: null,
    created_at: "2026-05-23T00:00:00.000Z",
    updated_at: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

function emptySnapshot() {
  return { repos: [], items: [], terminalRefs: {} };
}

describe("buildWorkspace", () => {
  it("keeps a local task as a single local-owned workspace task", () => {
    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash", remoteUrl: "git@example.com:kanna.git" }],
      localItems: [item()],
      cloudSnapshot: emptySnapshot(),
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "local:task-local",
      localTaskId: "task-local",
      remoteTaskIds: [],
      repoKey: "local:repo-local",
      owner: { kind: "local" },
      reachability: "local",
      terminal: { kind: "local", localSessionId: "task-local" },
      capabilities: {
        canOpenTerminal: true,
        canClose: true,
        canPushToMachine: true,
        canPullFromMachine: false,
      },
    });
  });

  it("dedupes a cloud copy of a local task and keeps the local task identity", () => {
    const local = item({ id: "task-1", branch: "task-1" });
    const cloud = item({
      id: "cloud:repo-local:task-1",
      repo_id: "repo-local",
      branch: "task-1",
      display_name: "Build workspace (desktop-a)",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash", remoteUrl: "git@example.com:kanna.git" }],
      localItems: [local],
      cloudSnapshot: {
        repos: [],
        items: [cloud],
        terminalRefs: {
          "cloud:repo-local:task-1": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-1",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "local:task-1",
      localTaskId: "task-1",
      remoteTaskIds: ["cloud:repo-local:task-1"],
      terminal: { kind: "local", localSessionId: "task-1" },
    });
  });

  it("shows one remote task when LAN and cloud advertise the same owner task", () => {
    const cloudItem = item({ id: "cloud:remote-repo:task-2", repo_id: "cloud:remote-repo" });
    const lanItem = item({ id: "cloud:lan:peer-a:remote-repo:task-2", repo_id: "cloud:remote-repo" });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [{
          id: "cloud:remote-repo",
          path: "cloud",
          name: "kanna",
          remote_url: "git@example.com:kanna.git",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-05-23T00:00:00.000Z",
          last_opened_at: "2026-05-23T00:00:00.000Z",
        }],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-2": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-2",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: {
        repos: [],
        items: [lanItem],
        terminalRefs: {
          "cloud:lan:peer-a:remote-repo:task-2": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-2",
            transport: "lan",
          },
        },
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].remoteTaskIds.sort()).toEqual([
      "cloud:lan:peer-a:remote-repo:task-2",
      "cloud:remote-repo:task-2",
    ]);
    expect(result.tasks[0]).toMatchObject({
      reachability: "reachable",
      terminal: {
        kind: "lan",
        remoteRef: {
          ownerDesktopId: "desktop-a",
          ownerLocalTaskId: "task-2",
          transport: "lan",
        },
      },
    });
  });

  it("hides a stale remote task when the matching local task is closed", () => {
    const closed = item({
      id: "task-closed",
      branch: "task-closed",
      stage: "done",
      closed_at: "2026-05-23T00:10:00.000Z",
    });
    const staleCloud = item({
      id: "cloud:repo-local:task-closed",
      repo_id: "repo-local",
      branch: "task-closed",
      stage: "in progress",
      closed_at: null,
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash" }],
      localItems: [closed],
      cloudSnapshot: {
        repos: [],
        items: [staleCloud],
        terminalRefs: {
          "cloud:repo-local:task-closed": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-closed",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toEqual([]);
  });

  it("groups a remote task under a matching local repo by remote URL hash", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-3",
      repo_id: "cloud:remote-repo",
      branch: "task-3",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo({ id: "repo-local" }), remoteUrlHash: "same-hash" }],
      localItems: [],
      cloudSnapshot: {
        repos: [{
          id: "cloud:remote-repo",
          path: "cloud",
          name: "kanna",
          remote_url: "git@example.com:kanna.git",
          remoteUrlHash: "same-hash",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-05-23T00:00:00.000Z",
          last_opened_at: "2026-05-23T00:00:00.000Z",
        } as never],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-3": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-3",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]).toMatchObject({
      key: "local:repo-local",
      localRepoId: "repo-local",
      source: "mixed",
    });
    expect(result.tasks[0].repoKey).toBe("local:repo-local");
  });
});
```

- [ ] **Step 2: Add a temporary empty builder**

Create `apps/desktop/src/workspace/buildWorkspace.ts`:

```ts
import type { BuildWorkspaceInput, BuildWorkspaceResult } from "./types";

export function buildWorkspace(_input: BuildWorkspaceInput): BuildWorkspaceResult {
  return { repos: [], tasks: [] };
}
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts
```

Expected: tests fail because the builder returns empty arrays.

## Task 3: Workspace Builder Implementation

**Files:**
- Modify: `apps/desktop/src/workspace/buildWorkspace.ts`
- Test: `apps/desktop/src/workspace/buildWorkspace.test.ts`

- [ ] **Step 1: Implement repo normalization and task dedupe**

Replace `apps/desktop/src/workspace/buildWorkspace.ts` with:

```ts
import type { PipelineItem } from "@kanna/db";
import type {
  BuildWorkspaceInput,
  BuildWorkspaceResult,
  LocalRepoWithRemote,
  RemoteRepo,
  WorkspaceCapabilities,
  WorkspaceRepo,
  WorkspaceTask,
  WorkspaceTaskSource,
  WorkspaceTerminalRoute,
} from "./types";

interface Candidate {
  item: PipelineItem;
  source: WorkspaceTaskSource;
  repoKey: string;
  logicalKey: string;
}

export function buildWorkspace(input: BuildWorkspaceInput): BuildWorkspaceResult {
  const repoContext = buildRepoContext(input.localRepos, [
    ...input.cloudSnapshot.repos,
    ...input.lanSnapshot.repos,
  ]);
  const closedLocalKeys = buildClosedLocalKeys(input.localItems, repoContext.localRepoKeyById);
  const candidates = [
    ...input.localItems
      .filter((item) => item.stage !== "done" && !item.closed_at)
      .map((item) => localCandidate(item, repoContext.localRepoKeyById)),
    ...remoteCandidates(input.cloudSnapshot.items, input.cloudSnapshot.terminalRefs, "cloud", repoContext, closedLocalKeys),
    ...remoteCandidates(input.lanSnapshot.items, input.lanSnapshot.terminalRefs, "lan", repoContext, closedLocalKeys),
  ].filter((candidate): candidate is Candidate => candidate !== null);

  const tasksByKey = new Map<string, WorkspaceTask>();
  for (const candidate of candidates) {
    const existing = tasksByKey.get(candidate.logicalKey);
    const next = existing
      ? mergeWorkspaceTask(existing, candidate)
      : createWorkspaceTask(candidate);
    tasksByKey.set(candidate.logicalKey, next);
  }

  return {
    repos: repoContext.repos,
    tasks: [...tasksByKey.values()].sort((a, b) =>
      b.item.created_at.localeCompare(a.item.created_at),
    ),
  };
}

function buildRepoContext(localRepos: LocalRepoWithRemote[], remoteRepos: RemoteRepo[]) {
  const reposByKey = new Map<string, WorkspaceRepo>();
  const localRepoKeyById = new Map<string, string>();
  const localRepoKeyByRemoteHash = new Map<string, string>();
  const remoteRepoKeyById = new Map<string, string>();

  for (const entry of localRepos) {
    const key = `local:${entry.repo.id}`;
    localRepoKeyById.set(entry.repo.id, key);
    if (entry.remoteUrlHash) localRepoKeyByRemoteHash.set(entry.remoteUrlHash, key);
    reposByKey.set(key, {
      key,
      localRepoId: entry.repo.id,
      remoteRepoIds: [],
      name: entry.repo.name,
      path: entry.repo.path,
      remoteUrl: entry.remoteUrl ?? null,
      remoteUrlHash: entry.remoteUrlHash,
      defaultBranch: entry.repo.default_branch,
      source: "local-only",
    });
  }

  for (const repo of remoteRepos) {
    const remoteUrlHash = readRemoteUrlHash(repo);
    const matchedLocalKey = remoteUrlHash ? localRepoKeyByRemoteHash.get(remoteUrlHash) : undefined;
    const key = matchedLocalKey ?? `remote:${repo.id}`;
    remoteRepoKeyById.set(repo.id, key);
    const existing = reposByKey.get(key);
    if (existing) {
      if (!existing.remoteRepoIds.includes(repo.id)) existing.remoteRepoIds.push(repo.id);
      existing.source = existing.localRepoId ? "mixed" : "remote-only";
      existing.remoteUrl ??= repo.remote_url ?? null;
      existing.remoteUrlHash ??= remoteUrlHash;
      continue;
    }
    reposByKey.set(key, {
      key,
      localRepoId: null,
      remoteRepoIds: [repo.id],
      name: repo.name,
      path: null,
      remoteUrl: repo.remote_url ?? null,
      remoteUrlHash,
      defaultBranch: repo.default_branch,
      source: "remote-only",
    });
  }

  return {
    repos: [...reposByKey.values()],
    localRepoKeyById,
    remoteRepoKeyById,
  };
}

function localCandidate(
  item: PipelineItem,
  localRepoKeyById: Map<string, string>,
): Candidate | null {
  const repoKey = localRepoKeyById.get(item.repo_id);
  if (!repoKey) return null;
  const logicalKey = `${repoKey}:owner-local:${item.id}`;
  return {
    item,
    repoKey,
    logicalKey,
    source: {
      kind: "local",
      taskId: item.id,
      repoId: item.repo_id,
      updatedAt: item.updated_at,
    },
  };
}

function remoteCandidates(
  items: PipelineItem[],
  terminalRefs: BuildWorkspaceInput["cloudSnapshot"]["terminalRefs"],
  kind: "cloud" | "lan",
  repoContext: ReturnType<typeof buildRepoContext>,
  closedLocalKeys: Set<string>,
): Array<Candidate | null> {
  return items.map((item) => {
    if (item.stage === "done" || item.closed_at) return null;
    const repoKey = repoContext.remoteRepoKeyById.get(item.repo_id)
      ?? repoContext.localRepoKeyById.get(item.repo_id)
      ?? `remote:${item.repo_id}`;
    const terminalRef = terminalRefs[item.id];
    const ownerLocalTaskId = terminalRef?.ownerLocalTaskId ?? stripRemoteTaskPrefix(item.id);
    const closedKey = `${repoKey}:owner-local:${ownerLocalTaskId}`;
    if (closedLocalKeys.has(closedKey)) return null;
    return {
      item,
      repoKey,
      logicalKey: `${repoKey}:owner:${terminalRef?.ownerDesktopId ?? "unknown"}:${ownerLocalTaskId}`,
      source: {
        kind,
        taskId: item.id,
        repoId: item.repo_id,
        updatedAt: item.updated_at,
        terminalRef,
      },
    };
  });
}

function buildClosedLocalKeys(
  items: PipelineItem[],
  localRepoKeyById: Map<string, string>,
): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.stage !== "done" && !item.closed_at) continue;
    const repoKey = localRepoKeyById.get(item.repo_id);
    if (repoKey) keys.add(`${repoKey}:owner-local:${item.id}`);
  }
  return keys;
}

function createWorkspaceTask(candidate: Candidate): WorkspaceTask {
  const isLocal = candidate.source.kind === "local";
  const remoteRef = candidate.source.terminalRef;
  return {
    id: isLocal ? `local:${candidate.item.id}` : candidate.item.id,
    logicalTaskKey: candidate.logicalKey,
    localTaskId: isLocal ? candidate.item.id : null,
    remoteTaskIds: isLocal ? [] : [candidate.item.id],
    repoKey: candidate.repoKey,
    item: candidate.item,
    owner: isLocal
      ? { kind: "local", id: "local" }
      : { kind: "remote", id: remoteRef?.ownerDesktopId ?? "unknown" },
    sources: [candidate.source],
    reachability: isLocal ? "local" : remoteRef ? "reachable" : "unknown",
    capabilities: capabilitiesFor(candidate),
    terminal: terminalRouteFor(candidate),
  };
}

function mergeWorkspaceTask(existing: WorkspaceTask, candidate: Candidate): WorkspaceTask {
  const sources = [...existing.sources, candidate.source];
  if (candidate.source.kind === "local") {
    return {
      ...existing,
      id: `local:${candidate.item.id}`,
      localTaskId: candidate.item.id,
      item: candidate.item,
      owner: { kind: "local", id: "local" },
      sources,
      reachability: "local",
      capabilities: capabilitiesFor(candidate),
      terminal: { kind: "local", localSessionId: candidate.item.id },
    };
  }

  const remoteTaskIds = existing.remoteTaskIds.includes(candidate.item.id)
    ? existing.remoteTaskIds
    : [...existing.remoteTaskIds, candidate.item.id];
  const bestRoute = chooseBestRoute([...sources]);
  return {
    ...existing,
    remoteTaskIds,
    sources,
    terminal: bestRoute,
    reachability: existing.reachability === "local" ? "local" : bestRoute.kind === "none" ? "unknown" : "reachable",
    capabilities: existing.localTaskId
      ? existing.capabilities
      : capabilitiesFor(candidate),
  };
}

function chooseBestRoute(sources: WorkspaceTaskSource[]): WorkspaceTerminalRoute {
  const local = sources.find((source) => source.kind === "local");
  if (local) return { kind: "local", localSessionId: local.taskId };
  const lan = sources.find((source) => source.kind === "lan" && source.terminalRef);
  if (lan?.terminalRef) return { kind: "lan", remoteRef: lan.terminalRef };
  const cloud = sources.find((source) => source.kind === "cloud" && source.terminalRef);
  if (cloud?.terminalRef) return { kind: "cloud", remoteRef: cloud.terminalRef };
  return { kind: "none" };
}

function terminalRouteFor(candidate: Candidate): WorkspaceTerminalRoute {
  if (candidate.source.kind === "local") {
    return { kind: "local", localSessionId: candidate.item.id };
  }
  if (candidate.source.terminalRef) {
    return {
      kind: candidate.source.kind,
      remoteRef: candidate.source.terminalRef,
    };
  }
  return { kind: "none" };
}

function capabilitiesFor(candidate: Candidate): WorkspaceCapabilities {
  const isLocal = candidate.source.kind === "local";
  const hasTerminal = isLocal || Boolean(candidate.source.terminalRef);
  return {
    canOpenTerminal: hasTerminal,
    canSendInput: hasTerminal,
    canClose: isLocal || hasTerminal,
    canCreateSiblingTask: true,
    canPushToMachine: isLocal,
    canPullFromMachine: !isLocal,
    canOpenDiff: isLocal,
    canOpenInIde: isLocal,
  };
}

function readRemoteUrlHash(repo: RemoteRepo): string | null {
  const candidate = repo as RemoteRepo & { remoteUrlHash?: string | null };
  return candidate.remoteUrlHash ?? null;
}

function stripRemoteTaskPrefix(id: string): string {
  const parts = id.split(":");
  return parts[parts.length - 1] || id;
}
```

- [ ] **Step 2: Run workspace unit tests**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts
```

Expected: all `buildWorkspace` tests pass.

- [ ] **Step 3: Commit builder**

Run:

```bash
git add apps/desktop/src/workspace
git commit -m "feat: build unified workspace task model"
```

Expected: commit succeeds.

## Task 4: App.vue Consumes Workspace Model

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/workspace/buildWorkspace.test.ts`

- [ ] **Step 1: Import workspace builder**

In `apps/desktop/src/App.vue`, add imports near the existing cloud task index imports:

```ts
import { buildWorkspace } from "./workspace/buildWorkspace";
import type { WorkspaceTask } from "./workspace/types";
```

- [ ] **Step 2: Replace ad hoc visible remote computations**

Replace the current `remoteSnapshot`, `localSidebarItemKeys`, `visibleRemoteItems`, `sidebarRepos`, and `sidebarItems` block with:

```ts
const remoteSnapshot = computed<DesktopCloudSnapshot>(() => ({
  repos: [...cloudSnapshot.value.repos, ...lanSnapshot.value.repos],
  items: [...cloudSnapshot.value.items, ...lanSnapshot.value.items],
  terminalRefs: { ...cloudSnapshot.value.terminalRefs, ...lanSnapshot.value.terminalRefs },
}));
const workspace = computed(() => buildWorkspace({
  localRepos: localReposForCloudMatching.value,
  localItems: store.items,
  cloudSnapshot: cloudSnapshot.value,
  lanSnapshot: lanSnapshot.value,
}));
const workspaceTasksByItemId = computed(() => {
  const entries: Array<[string, WorkspaceTask]> = [];
  for (const task of workspace.value.tasks) {
    entries.push([task.item.id, task]);
    if (task.localTaskId) entries.push([task.localTaskId, task]);
    for (const remoteTaskId of task.remoteTaskIds) entries.push([remoteTaskId, task]);
  }
  return new Map(entries);
});
const sidebarRepos = computed(() => workspace.value.repos.map((repo) => ({
  id: repo.key,
  path: repo.path ?? "cloud",
  name: repo.name,
  remote_url: repo.remoteUrl,
  default_branch: repo.defaultBranch ?? "main",
  hidden: 0,
  sort_order: 0,
  created_at: "",
  last_opened_at: "",
})));
const sidebarItems = computed(() => workspace.value.tasks.map((task) => ({
  ...task.item,
  id: task.item.id,
  repo_id: task.repoKey,
})));
```

- [ ] **Step 3: Update cloud selection lookup to use workspace task ids**

Replace `selectedCloudItem` with:

```ts
const selectedCloudItem = computed(() => {
  const selectedItemId = selectedCloudItemId.value ?? store.selectedItemId;
  if (!selectedItemId) return null;
  const task = workspaceTasksByItemId.value.get(selectedItemId);
  if (!task || task.owner.kind === "local") return null;
  if (task.item.repo_id === (selectedCloudRepoId.value ?? store.selectedRepoId)) return task.item;
  if (task.repoKey === (selectedCloudRepoId.value ?? store.selectedRepoId)) return task.item;
  return null;
});
```

- [ ] **Step 4: Update terminal ref resolution**

Replace `mainPanelCloudTerminalRef` with:

```ts
const mainPanelCloudTerminalRef = computed(() => {
  const selectedItemId = selectedCloudItemId.value ?? store.selectedItemId;
  if (!selectedItemId) return null;
  const task = workspaceTasksByItemId.value.get(selectedItemId);
  return task?.terminal.remoteRef ?? null;
});
```

- [ ] **Step 5: Keep sidebar helper on workspace output**

Replace `visibleSidebarItemsForRepo` with:

```ts
function visibleSidebarItemsForRepo(repoId: string, options: { currentRepoScope?: boolean } = {}) {
  if (options.currentRepoScope && repoId === store.selectedRepoId && !repoId.startsWith("remote:")) {
    return sidebarItems.value.filter((item) => item.repo_id === repoId);
  }
  return sidebarItems.value.filter((item) => item.repo_id === repoId && item.stage !== "done");
}
```

- [ ] **Step 6: Run build**

Run:

```bash
pnpm --dir apps/desktop build
```

Expected: TypeScript and Vite build pass. Existing chunk-size warnings are acceptable.

- [ ] **Step 7: Commit App.vue integration**

Run:

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: drive sidebar from workspace model"
```

Expected: commit succeeds.

## Task 5: Cloud E2E Sanity Checks

**Files:**
- Modify: `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`

- [ ] **Step 1: Add sidebar workspace sanity helper**

In `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`, add this helper near `countLocalTasks`:

```ts
async function sidebarItemsForPrompt(client: typeof primary, prompt: string): Promise<Array<{
  id: string;
  prompt: string;
  repo_id: string;
  stage: string;
  isRemote: boolean;
}>> {
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.sidebarItems?.__v_isRef ? ctx.sidebarItems.value : ctx.sidebarItems;
    return JSON.parse(JSON.stringify(value.filter((item) => item.prompt === ${JSON.stringify(prompt)}).map((item) => ({
      id: item.id,
      prompt: item.prompt,
      repo_id: item.repo_id,
      stage: item.stage,
      isRemote: item.id.startsWith("cloud:") || item.id.startsWith("lan:"),
    }))));
  `);
}
```

- [ ] **Step 2: Assert owner sees only one task after cloud copy exists**

After `await waitForSidebarTask(primary, "Cloud sync visible task");`, add:

```ts
await waitForCloudTaskSnapshot(primary, "Cloud sync visible task");
expect(await countLocalTasks(primary)).toBe(1);
expect(await sidebarItemsForPrompt(primary, "Cloud sync visible task")).toEqual([
  expect.objectContaining({
    id: result,
    isRemote: false,
    stage: "in progress",
  }),
]);
```

- [ ] **Step 3: Assert secondary sees only one remote task and no local DB row**

After `await waitForSidebarTask(secondary, "Cloud sync visible task");`, add:

```ts
expect(await sidebarItemsForPrompt(secondary, "Cloud sync visible task")).toEqual([
  expect.objectContaining({
    id: expect.stringMatching(/^cloud:/),
    isRemote: true,
    stage: "in progress",
  }),
]);
expect(await countLocalTasks(secondary)).toBe(0);
```

- [ ] **Step 4: Run cloud E2E**

Run:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-task-sync.test.ts
```

Expected: test passes.

- [ ] **Step 5: Commit cloud E2E sanity checks**

Run:

```bash
git add apps/desktop/tests/e2e/real/cloud-task-sync.test.ts
git commit -m "test: cover cloud workspace task dedupe"
```

Expected: commit succeeds.

## Task 6: LAN E2E Sanity Checks

**Files:**
- Modify: `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`

- [ ] **Step 1: Add LAN sidebar sanity helper**

In `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`, add this helper after `countLocalTasksOnSecondary`:

```ts
async function sidebarItemsForPrompt(client: typeof primary, prompt: string): Promise<Array<{
  id: string;
  prompt: string;
  stage: string;
  isRemote: boolean;
}>> {
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.sidebarItems?.__v_isRef ? ctx.sidebarItems.value : ctx.sidebarItems;
    return JSON.parse(JSON.stringify(value.filter((item) => item.prompt === ${JSON.stringify(prompt)}).map((item) => ({
      id: item.id,
      prompt: item.prompt,
      stage: item.stage,
      isRemote: item.id.startsWith("cloud:") || item.id.startsWith("lan:"),
    }))));
  `);
}
```

- [ ] **Step 2: Assert LAN owner and peer each see one task**

After `await waitForSidebarTask("LAN visible task");`, add:

```ts
expect(await sidebarItemsForPrompt(primary, "LAN visible task")).toEqual([
  expect.objectContaining({
    id: createResult,
    isRemote: false,
    stage: "in progress",
  }),
]);
expect(await sidebarItemsForPrompt(secondary, "LAN visible task")).toEqual([
  expect.objectContaining({
    id: expect.stringMatching(/^cloud:lan:/),
    isRemote: true,
    stage: "in progress",
  }),
]);
```

- [ ] **Step 3: Run LAN E2E**

Run:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/local-transfer-task-sync.test.ts
```

Expected: test passes and still verifies LAN terminal streaming.

- [ ] **Step 4: Commit LAN E2E sanity checks**

Run:

```bash
git add apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts
git commit -m "test: cover LAN workspace task dedupe"
```

Expected: commit succeeds.

## Task 7: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts desktopCloudTaskIndex.test.ts desktopCloudPublisher.test.ts
```

Expected: all selected desktop unit tests pass.

- [ ] **Step 2: Run cloud E2E**

Run:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-task-sync.test.ts
```

Expected: test passes.

- [ ] **Step 3: Run LAN E2E**

Run:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/local-transfer-task-sync.test.ts
```

Expected: test passes.

- [ ] **Step 4: Run desktop build**

Run:

```bash
pnpm --dir apps/desktop build
```

Expected: TypeScript and Vite build pass. Existing chunk-size warnings are acceptable.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 6: Commit any verification-only fixes**

If verification required small fixes, commit them:

```bash
git add apps/desktop/src/workspace apps/desktop/src/App.vue apps/desktop/tests/e2e/real/cloud-task-sync.test.ts apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts
git commit -m "fix: stabilize workspace task model integration"
```

Expected: commit succeeds only if there are new changes.
