/**
 * Mock Tauri APIs for browser-mode development/testing.
 * When running outside the Tauri webview (e.g. via Playwright or plain browser),
 * this provides in-memory fallbacks so the app is fully interactive.
 */

export const isTauri = !!(window as any).__TAURI_INTERNALS__;

type MockTauriEventPayload = Record<string, unknown>;
type MockTauriEventHandler = (event: { payload: MockTauriEventPayload }) => void;

const mockEventHandlers = new Map<string, Set<MockTauriEventHandler>>();

function emitMockEvent(event: string, payload: MockTauriEventPayload) {
  for (const handler of mockEventHandlers.get(event) ?? []) {
    handler({ payload });
  }
}

function scheduleMockTerminalOutput(sessionId: string) {
  queueMicrotask(() => {
    emitMockEvent("terminal_output", {
      session_id: sessionId,
      data: Array.from(new TextEncoder().encode(`mock output for ${sessionId}`)),
    });
  });
}

// Mock invoke for Tauri commands
const invokeHandlers: Record<string, (...args: any[]) => any> = {
  list_sessions: () => [],
  spawn_session: () => ({}),
  attach_session_with_snapshot: (args?: { sessionId?: string }) => {
    if (args?.sessionId) {
      const sessionId = args.sessionId;
      queueMicrotask(() => {
        emitMockEvent("terminal_snapshot", {
          session_id: sessionId,
          snapshot: {
            version: 1,
            rows: 24,
            cols: 80,
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: true,
            vt: `mock restored scrollback for ${sessionId}`,
          },
        });
        scheduleMockTerminalOutput(sessionId);
      });
    }
    return {};
  },
  detach_session: () => ({}),
  get_session_recovery_state: () => null,
  send_input: () => ({}),
  send_agent_input: () => ({}),
  resize_session: () => ({}),
  signal_session: () => ({}),
  kill_session: () => ({}),
  git_diff: () => "",
  git_default_branch: () => "main",
  git_repository_state: () => ({ defaultBranch: "main", hasCommits: true }),
  git_current_branch: () => null,
  git_list_base_branches: () => ["origin/main", "main"],
  git_list_remote_base_branches: () => ["origin/main", "origin/release/x"],
  git_branch_upstream: () => null,
  git_remote_url: () => "https://github.com/example/repo.git",
  git_clone: () => ({}),
  git_init: () => ({}),
  git_worktree_add: () => ({}),
  git_worktree_remove: () => ({}),
  git_worktree_list: () => [],
  git_log: () => [],
  git_graph: () => ({
    commits: [
      { hash: "abc1234567890", short_hash: "abc1234", message: "feat: add commit graph", author: "Dev", timestamp: Date.now() / 1000, parents: ["def5678901234"], refs: ["main", "origin/main"] },
      { hash: "def5678901234", short_hash: "def5678", message: "fix: resolve issue", author: "Dev", timestamp: Date.now() / 1000 - 3600, parents: ["ghi9012345678"], refs: [] },
      { hash: "ghi9012345678", short_hash: "ghi9012", message: "initial commit", author: "Dev", timestamp: Date.now() / 1000 - 7200, parents: [], refs: ["v0.0.1"] },
    ],
    head_commit: "abc1234567890",
  }),
  git_push: () => ({}),
  list_transfer_peers: () => [],
  ensure_cloud_transfer_proxy: (args: { peerId?: string }) => ({
    peerId: args.peerId ?? "mock-cloud-peer",
    endpoint: "127.0.0.1:44550",
  }),
  remove_cloud_transfer_proxy: () => ({}),
  clear_cloud_transfer_proxies: () => ({}),
  set_transfer_task_snapshot: () => ({ ok: true }),
  list_transfer_task_snapshots: () => [],
  observe_transfer_peer_session: () => ({ ok: true }),
  unobserve_transfer_peer_session: () => ({ ok: true }),
  prepare_outgoing_transfer: (args: { payload?: { phase?: string } }) => {
    if (args?.payload?.phase === "preflight") {
      return {
        transferId: "mock-transfer-1",
        sourcePeerId: "mock-local-peer",
        targetHasRepo: false,
      };
    }
    return { ok: true };
  },
  stage_transfer_artifact: () => ({
    transferId: "mock-transfer-1",
    artifactId: "mock-artifact-1",
  }),
  fetch_transfer_artifact: () => ({
    transferId: "mock-transfer-1",
    artifactId: "mock-artifact-1",
    path: "/tmp/mock-transfer-1.bundle",
  }),
  materialize_transfer_artifact: () => true,
  locate_claude_transcript: () => null,
  claim_transfer_event_consumer: () => ({
    authoritative: true,
    consumerIncarnation: "mock-consumer-incarnation",
  }),
  release_transfer_event_consumer: () => true,
  finalize_outgoing_transfer: (args: { transferId?: string }) => ({
    transferId: args.transferId ?? "mock-transfer-1",
    payload: {
      target_peer_id: "mock-target-peer",
      task: {
        source_peer_id: "mock-source-peer",
        source_task_id: "mock-task-source",
        resume_session_id: null,
        prompt: "Mock transfer",
        stage: "in progress",
        branch: "task-mock",
        workflow: "default",
        display_name: null,
        base_ref: "main",
        agent_type: "pty",
        agent_provider: "claude",
      },
      repo: {
        mode: "reuse-local",
        remote_url: null,
        path: "/tmp/mock-repo",
        name: "mock-repo",
        default_branch: "main",
        bundle: null,
      },
      recovery: null,
      artifacts: [],
    },
    finalizedCleanly: true,
  }),
  complete_outgoing_transfer_finalization: (args: { transferId?: string }) => ({
    transferId: args.transferId ?? "mock-transfer-1",
  }),
  acknowledge_incoming_transfer_commit: () => ({ ok: true }),
  mark_incoming_transfer_ack_completed: () => ({ ok: true }),
  mark_incoming_transfer_event_recorded: () => ({ ok: true }),
  mark_outgoing_transfer_commit_applied: () => ({ ok: true }),
  nack_outgoing_transfer_commit: () => ({ ok: true }),
  file_exists: () => true,
  read_text_file: () => "",
  read_image_file_data_url: () => "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
  get_app_data_dir: () => "/tmp/kanna-mock-data",
  get_claude_usage: () => "",
  copy_file: () => ({}),
  remove_file: () => ({}),
  ensure_directory: () => ({}),
  list_dir: () => [],
  read_dir_entries: () => [
    { name: "src", is_dir: true },
    { name: "components", is_dir: true },
    { name: "composables", is_dir: true },
    { name: "stores", is_dir: true },
    { name: "App.vue", is_dir: false },
    { name: "main.ts", is_dir: false },
  ],
  which_binary: () => "/usr/local/bin/claude",
  run_script: () => "",
  append_log: () => ({}),
  read_clipboard_image_png: () => null,
  ensure_mobile_server: () => ({}),
  mobile_server_status: () => ({
    state: "running",
    desktopId: "desktop-mock-current",
    desktopName: "Mock Desktop",
    version: "0.0.0",
    environment: "development",
    serverVersion: "0.0.0",
    lanHost: "127.0.0.1",
    lanPort: 48120,
    pairingCode: null,
  }),
  create_mobile_pairing_session: () => ({
    desktopId: "desktop-mock-current",
    desktopName: "Mock Desktop",
    code: "ABC123",
    pairingPayload: "KANNA1:DESKTOP-MOCK-CURRENT:ABC123",
    expiresAtUnixMs: Date.now() + 300_000,
  }),
  // Claude agent SDK commands
  spawn_agent_session: () => ({ session_id: "mock-session" }),
  send_agent_message: () => ({}),
  abort_agent_session: () => ({}),
  destroy_agent_session: () => ({}),
  // Test harness commands (mirror the Rust test-harness feature)
  test_list_agent_sessions: () => [],
  test_get_agent_session: () => ({ session_id: "", buffer_len: 0, finished: true }),
  test_peek_agent_buffer: () => [],
  test_daemon_connected: () => ({ connected: false }),
  test_daemon_sessions: () => ({ type: "SessionList", sessions: [] }),
  test_state_snapshot: () => ({
    agent_sessions: [],
    daemon: { connected: false },
  }),
};

export function mockInvoke(cmd: string, args?: any): any {
  const handler = invokeHandlers[cmd];
  if (handler) return handler(args);
  console.warn(`[tauri-mock] unhandled invoke: ${cmd}`, args);
  return {};
}

// Mock listen — returns a no-op unlisten function
export function mockListen(event: string, handler: (event: any) => void): Promise<() => void> {
  const handlers = mockEventHandlers.get(event) ?? new Set<MockTauriEventHandler>();
  handlers.add(handler as MockTauriEventHandler);
  mockEventHandlers.set(event, handlers);
  return Promise.resolve(() => {
    const current = mockEventHandlers.get(event);
    current?.delete(handler as MockTauriEventHandler);
    if (current && current.size === 0) {
      mockEventHandlers.delete(event);
    }
  });
}

export async function mockEmit(event: string, payload?: unknown): Promise<void> {
  emitMockEvent(event, typeof payload === "object" && payload !== null ? payload as MockTauriEventPayload : {});
}

// Mock dialog open — prompts via browser prompt()
export async function mockDialogOpen(_opts?: any): Promise<string | null> {
  return window.prompt("Enter directory path (browser mock):", "/Users/jeremyhale/Documents/work/jemdiggity/kanna");
}
