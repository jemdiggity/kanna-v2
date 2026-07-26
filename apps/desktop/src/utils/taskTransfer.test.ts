import { describe, expect, it } from "vitest";
import type { OutgoingTransferPayload } from "./taskTransfer";
import {
  buildOutgoingTransferPayload,
  parseIncomingTransferRequest,
  parseTaskPullRequestedEvent,
  resolveIncomingTransferBaseBranch,
} from "./taskTransfer";

function buildPayload(overrides: Partial<OutgoingTransferPayload> = {}): OutgoingTransferPayload {
  const {
    task: taskOverrides,
    repo: repoOverrides,
    ...topLevelOverrides
  } = overrides;

  return {
    target_peer_id: "peer-target",
    target_desktop_id: null,
    task: {
      cloud_task_id: "task-source",
      source_peer_id: "peer-source",
      source_desktop_id: null,
      source_task_id: "task-source",
      prompt: "Fix handoff",
      stage: "in progress",
      active_post_action: null,
      branch: "task-source",
      pipeline: "default",
      display_name: null,
      base_ref: "origin/main",
      agent_type: "pty",
      agent_provider: "claude",
      ...taskOverrides,
    },
    repo: {
      mode: "clone-remote",
      remote_url: "git@github.com:jemdiggity/kanna.git",
      path: null,
      name: "repo-1",
      default_branch: "main",
      bundle: null,
      ...repoOverrides,
    },
    recovery: null,
    ...topLevelOverrides,
  };
}

describe("resolveIncomingTransferBaseBranch", () => {
  it("uses the transferred base_ref for clone-remote imports", () => {
    const payload = buildPayload({
      repo: { mode: "clone-remote" },
    });

    expect(resolveIncomingTransferBaseBranch(payload)).toBe("origin/main");
  });

  it("uses the transferred base_ref for reuse-local imports", () => {
    const payload = buildPayload({
      repo: {
        mode: "reuse-local",
        path: "/tmp/repo-1",
      },
    });

    expect(resolveIncomingTransferBaseBranch(payload)).toBe("origin/main");
  });

  it("prefers the transferred task branch for bundle-backed imports", () => {
    const payload = buildPayload({
      repo: {
        mode: "bundle-repo",
        remote_url: null,
        bundle: {
          artifact_id: "artifact-1",
          filename: "transfer.bundle",
          ref_name: "refs/heads/task-source",
        },
      },
    });

    expect(resolveIncomingTransferBaseBranch(payload)).toBe("task-source");
  });

  it("falls back to base_ref when a bundle-backed import has no task branch", () => {
    const payload = buildPayload({
      task: {
        branch: null,
      },
      repo: {
        mode: "bundle-repo",
        remote_url: null,
        bundle: {
          artifact_id: "artifact-1",
          filename: "transfer.bundle",
          ref_name: "refs/heads/main",
        },
      },
    });

    expect(resolveIncomingTransferBaseBranch(payload)).toBe("origin/main");
  });
});

describe("buildOutgoingTransferPayload", () => {
  it("preserves stable cloud identity and authenticated desktop ids", () => {
    const payload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-a",
      sourceDesktopId: "desktop-a",
      sourceTaskId: "local-a",
      targetPeerId: "peer-b",
      targetDesktopId: "desktop-b",
      item: {
        id: "local-a",
        cloud_task_id: "cloud-stable",
        prompt: "Transfer ownership",
        stage: "in progress",
        branch: "task-local-a",
        pipeline: "default",
        display_name: null,
        base_ref: "main",
        agent_type: "pty",
        agent_provider: "claude",
        agent_session_id: null,
      },
      repoRemoteUrl: null,
      recovery: null,
      targetHasRepo: true,
      bundle: null,
    });

    expect(payload.task.cloud_task_id).toBe("cloud-stable");
    expect(payload.task.source_desktop_id).toBe("desktop-a");
    expect(payload.target_desktop_id).toBe("desktop-b");
  });

  it("falls back to the local task id and leaves LAN desktop ids null", () => {
    const payload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-a",
      sourceTaskId: "local-a",
      targetPeerId: "peer-b",
      item: {
        id: "local-a",
        cloud_task_id: null,
        prompt: "Transfer ownership",
        stage: "in progress",
        branch: "task-local-a",
        pipeline: "default",
        display_name: null,
        base_ref: "main",
        agent_type: "pty",
        agent_provider: "claude",
        agent_session_id: null,
      },
      repoRemoteUrl: null,
      recovery: null,
      targetHasRepo: true,
      bundle: null,
    });

    expect(payload.task.cloud_task_id).toBe("local-a");
    expect(payload.task.source_desktop_id).toBeNull();
    expect(payload.target_desktop_id).toBeNull();
  });
});

describe("parseTaskPullRequestedEvent", () => {
  it("parses snake-case sidecar event payloads", () => {
    expect(parseTaskPullRequestedEvent({
      type: "task_pull_requested",
      request_id: "pull-1",
      requester_peer_id: "peer-destination",
      source_task_id: "task-source",
    })).toEqual({
      requestId: "pull-1",
      requesterPeerId: "peer-destination",
      sourceTaskId: "task-source",
    });
  });

  it("rejects incomplete event payloads", () => {
    expect(() => parseTaskPullRequestedEvent({
      request_id: "pull-1",
      requester_peer_id: "peer-destination",
    })).toThrow("source task id");
  });
});

describe("parseIncomingTransferRequest artifact validation", () => {
  function requestWithArtifact(artifact: Record<string, unknown>) {
    return {
      type: "incoming_transfer_request",
      transfer_id: "transfer-1",
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      payload: {
        target_peer_id: "peer-target",
        target_desktop_id: null,
        task: {
          cloud_task_id: "task-source",
          source_peer_id: "peer-source",
          source_desktop_id: null,
          source_task_id: "task-source",
          resume_session_id: "364643cc-5e6d-48fc-86ca-ca7764380900",
          prompt: "Fix handoff",
          stage: "in progress",
          branch: "task-source",
          pipeline: "default",
          display_name: null,
          base_ref: "origin/main",
          agent_type: "pty",
          agent_provider: "claude",
        },
        repo: {
          mode: "reuse-local",
          remote_url: null,
          path: "/tmp/repo-1",
          name: "repo-1",
          default_branch: "main",
          bundle: null,
        },
        recovery: null,
        artifacts: [artifact],
      },
    };
  }

  it.each([
    "../.ssh/authorized_keys",
    "/tmp/owned",
    ".claude/tasks/../../.ssh",
  ])("rejects peer artifact traversal path %s", (homeRelPath) => {
    expect(() => parseIncomingTransferRequest(requestWithArtifact({
      artifact_id: "artifact-1",
      filename: "claude-session.tar.gz",
      provider: "claude",
      kind: "session-archive",
      materialization: "extract-tar-gz",
      home_rel_path: homeRelPath,
    }))).toThrow(/artifact|path|session/i);
  });

  it("rejects an artifact whose provider does not match the resume provider", () => {
    expect(() => parseIncomingTransferRequest(requestWithArtifact({
      artifact_id: "artifact-1",
      filename: "copilot-session.tar.gz",
      provider: "copilot",
      kind: "session-archive",
      materialization: "extract-tar-gz",
      home_rel_path: ".copilot/session-state/364643cc-5e6d-48fc-86ca-ca7764380900",
    }))).toThrow(/provider/i);
  });

  it.each([
    ["source_peer_id", "peer-impersonated"],
    ["source_task_id", "task-impersonated"],
  ])("rejects an inner %s that does not match the authenticated envelope", (field, value) => {
    const request = requestWithArtifact({
      artifact_id: "artifact-1",
      filename: "claude-session.tar.gz",
      provider: "claude",
      kind: "session-archive",
      materialization: "extract-tar-gz",
      home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
    });
    (request.payload.task as Record<string, unknown>)[field] = value;

    expect(() => parseIncomingTransferRequest(request)).toThrow(/source identity|envelope/i);
  });

  it("rejects an artifact materialization outside the provider contract", () => {
    expect(() => parseIncomingTransferRequest(requestWithArtifact({
      artifact_id: "artifact-1",
      filename: "claude-session.tar.gz",
      provider: "claude",
      kind: "session-rollout",
      materialization: "copy-file",
      home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
    }))).toThrow(/artifact|materialization|kind/i);
  });

  it("accepts canonical legacy artifact metadata but keeps the destination provider-owned", () => {
    const request = parseIncomingTransferRequest(requestWithArtifact({
      artifact_id: "artifact-1",
      filename: "claude-session.tar.gz",
      provider: "claude",
      kind: "session-archive",
      materialization: "extract-tar-gz",
      home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
    }));

    expect(request.payload.artifacts).toEqual([{
      artifact_id: "artifact-1",
      filename: "claude-session.tar.gz",
      provider: "claude",
      kind: "session-archive",
      materialization: "extract-tar-gz",
      home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
    }]);
  });
});
