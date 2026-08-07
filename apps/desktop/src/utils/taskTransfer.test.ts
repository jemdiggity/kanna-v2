import { describe, expect, it } from "vitest";
import type { OutgoingTransferPayload } from "./taskTransfer";
import {
  buildOutgoingTransferPayload,
  parseIncomingTransferRequest,
  parseTaskPullRequestedEvent,
  requiredSessionArtifactKind,
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
    return requestWithArtifacts([artifact]);
  }

  function requestWithArtifacts(artifacts: Record<string, unknown>[]) {
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
        artifacts,
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

  const CLAUDE_ARCHIVE = {
    artifact_id: "artifact-1",
    filename: "claude-session.tar.gz",
    provider: "claude",
    kind: "session-archive",
    materialization: "extract-tar-gz",
    home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
  };
  const CLAUDE_TRANSCRIPT = {
    artifact_id: "artifact-2",
    filename: "364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
    provider: "claude",
    kind: "session-transcript",
    materialization: "copy-file",
    home_rel_path:
      ".claude/projects/-Users-x--kanna-repos-r--kanna-worktrees-task-source/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
  };

  it("accepts a Claude conversation transcript shipped alongside the session archive", () => {
    const request = parseIncomingTransferRequest(
      requestWithArtifacts([CLAUDE_ARCHIVE, CLAUDE_TRANSCRIPT]),
    );

    expect(request.payload.artifacts).toEqual([CLAUDE_ARCHIVE, CLAUDE_TRANSCRIPT]);
  });

  it.each([
    "/Users/x/.claude/projects/slug/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
    ".claude/projects/../../.ssh/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
    ".claude/projects/a/b/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
    ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
  ])("rejects a transcript home_rel_path outside the Claude projects contract: %s", (homeRelPath) => {
    expect(() => parseIncomingTransferRequest(requestWithArtifact({
      ...CLAUDE_TRANSCRIPT,
      home_rel_path: homeRelPath,
    }))).toThrow(/transcript|path|artifact/i);
  });

  it("rejects a transcript whose filename is not the resume session id", () => {
    expect(() => parseIncomingTransferRequest(requestWithArtifact({
      ...CLAUDE_TRANSCRIPT,
      filename: "019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
    }))).toThrow(/contract/i);
  });

  it("rejects two artifacts of the same kind", () => {
    expect(() => parseIncomingTransferRequest(requestWithArtifacts([
      CLAUDE_TRANSCRIPT,
      { ...CLAUDE_TRANSCRIPT, artifact_id: "artifact-3" },
    ]))).toThrow(/duplicate artifact kind/i);
  });

  it("rejects two artifacts sharing one artifact id", () => {
    expect(() => parseIncomingTransferRequest(requestWithArtifacts([
      CLAUDE_ARCHIVE,
      { ...CLAUDE_TRANSCRIPT, artifact_id: CLAUDE_ARCHIVE.artifact_id },
    ]))).toThrow(/duplicate artifact id/i);
  });

  it("rejects more artifacts than the provider session contract allows", () => {
    expect(() => parseIncomingTransferRequest(requestWithArtifacts([
      CLAUDE_ARCHIVE,
      CLAUDE_TRANSCRIPT,
      { ...CLAUDE_ARCHIVE, artifact_id: "artifact-3" },
    ]))).toThrow(/at most two/i);
  });
});

describe("opencode session export artifacts", () => {
  const OPENCODE_SESSION = "ses_02645d9aaffeeOgwt2rbXIcTdp";
  const OPENCODE_EXPORT = {
    artifact_id: "artifact-1",
    filename: "opencode-session.json",
    provider: "opencode",
    kind: "session-export",
    materialization: "opencode-import",
    home_rel_path: ".local/share/opencode",
  };

  function opencodeRequest(
    artifacts: Record<string, unknown>[],
    resumeSessionId: string = OPENCODE_SESSION,
  ) {
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
          resume_session_id: resumeSessionId,
          prompt: "Fix handoff",
          stage: "in progress",
          branch: "task-source",
          pipeline: "default",
          display_name: null,
          base_ref: "origin/main",
          agent_type: "pty",
          agent_provider: "opencode",
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
        artifacts,
      },
    };
  }

  it("requires an opencode PTY task with a session to ship its conversation", () => {
    expect(requiredSessionArtifactKind({
      agentType: "pty",
      agentProvider: "opencode",
      resumeSessionId: OPENCODE_SESSION,
    })).toBe("session-export");
    // An agent that never got a turn has no session id, and no conversation to
    // lose with it.
    expect(requiredSessionArtifactKind({
      agentType: "pty",
      agentProvider: "opencode",
      resumeSessionId: null,
    })).toBeNull();
  });

  it("accepts the canonical opencode session export", () => {
    const request = parseIncomingTransferRequest(opencodeRequest([OPENCODE_EXPORT]));
    expect(request.payload.artifacts).toEqual([OPENCODE_EXPORT]);
  });

  it.each([
    { filename: "session.json" },
    { filename: `${OPENCODE_SESSION}.json` },
    { kind: "session-transcript" },
    { materialization: "copy-file" },
    { home_rel_path: ".local/share/opencode/opencode.db" },
    { home_rel_path: "../.ssh/authorized_keys" },
    { home_rel_path: "/tmp/owned" },
  ])("rejects an opencode export that departs from the contract: %o", (override) => {
    expect(() => parseIncomingTransferRequest(
      opencodeRequest([{ ...OPENCODE_EXPORT, ...override }]),
    )).toThrow(/contract|path|artifact/i);
  });

  it.each([
    "364643cc-5e6d-48fc-86ca-ca7764380900",
    "ses_",
    "ses_../../etc",
    "opencode",
  ])("rejects an opencode export whose resume id is not a session id: %s", (sessionId) => {
    expect(() => parseIncomingTransferRequest(
      opencodeRequest([OPENCODE_EXPORT], sessionId),
    )).toThrow(/session id|component|contract/i);
  });

  it("refuses the opencode-import materialization for a file-placing provider", () => {
    // `opencode-import` is the one materialization that never places a file, so
    // it must not become a way for another provider's artifact to skip the fence.
    const claudeRequest = opencodeRequest([{
      artifact_id: "artifact-1",
      filename: "364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
      provider: "claude",
      kind: "session-export",
      materialization: "opencode-import",
      home_rel_path: ".local/share/opencode",
    }], "364643cc-5e6d-48fc-86ca-ca7764380900");
    claudeRequest.payload.task.agent_provider = "claude";

    expect(() => parseIncomingTransferRequest(claudeRequest))
      .toThrow(/contract|kind|materialization/i);
  });
});

describe("transfer finalization state", () => {
  function requestWithFinalization(finalization: unknown) {
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
          resume_session_id: null,
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
        finalization,
      },
    };
  }

  it("reads a peer that predates the field as cleanly finalized", () => {
    expect(parseIncomingTransferRequest(requestWithFinalization(undefined)).payload.finalization)
      .toEqual({ cleanly_finalized: true, degraded_reason: null });
  });

  it("carries a degraded handoff to the receiver", () => {
    expect(parseIncomingTransferRequest(requestWithFinalization({
      cleanly_finalized: false,
      degraded_reason: "the source agent session did not exit within 1500ms",
    })).payload.finalization).toEqual({
      cleanly_finalized: false,
      degraded_reason: "the source agent session did not exit within 1500ms",
    });
  });

  it("bounds a reason a peer could otherwise make unbounded", () => {
    const finalization = parseIncomingTransferRequest(requestWithFinalization({
      cleanly_finalized: false,
      degraded_reason: "x".repeat(4096),
    })).payload.finalization;
    expect(finalization.degraded_reason).toHaveLength(512);
  });

  it("rejects a finalization state that is not a boolean verdict", () => {
    expect(() => parseIncomingTransferRequest(requestWithFinalization({
      cleanly_finalized: "no",
    }))).toThrow(/cleanly_finalized must be a boolean/);
  });

  it("defaults a built payload to a clean finalization", () => {
    expect(buildOutgoingTransferPayload({
      sourcePeerId: "peer-source",
      sourceTaskId: "task-source",
      targetPeerId: "peer-target",
      item: buildPayload().task as never,
      repoRemoteUrl: null,
      recovery: null,
      targetHasRepo: true,
      bundle: null,
    }).finalization).toEqual({ cleanly_finalized: true, degraded_reason: null });
  });
});
