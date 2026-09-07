import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  remoteHarnessKannaCliPath,
  startRemoteHarness,
  type RemoteHarness
} from "./harness";
import {
  collectTerminalEvents,
  createScriptedTask,
  waitForCondition,
  waitForTerminalOutput
} from "./terminalFlowTestUtils";
import { BUFFY_UID } from "./firebaseAuth";

const execFileAsync = promisify(execFile);

const LINEAR_MANUAL_WORKFLOW = JSON.stringify({
  name: "remote-linear-manual",
  stages: [
    { name: "in progress", transition: "manual", prompt: "$TASK_PROMPT" },
    { name: "review", transition: "manual", prompt: "Review $TASK_PROMPT" },
    { name: "pr", transition: "manual", prompt: "Create PR for $TASK_PROMPT" }
  ]
});

const LINEAR_AUTO_WORKFLOW = JSON.stringify({
  name: "remote-linear-auto",
  stages: [
    { name: "in progress", transition: "auto", prompt: "$TASK_PROMPT" },
    { name: "review", transition: "manual", prompt: "Review $TASK_PROMPT" }
  ]
});

const APPROVAL_POST_WORKFLOW = JSON.stringify({
  name: "remote-approval-post",
  stages: [{
    name: "pr",
    agent: "pr",
    prompt: "Create PR for $TASK_PROMPT",
    policy: { transition: "manual" },
    post: {
      name: "approve",
      agent: "approve",
      prompt: "Approve $TASK_PROMPT"
    }
  }]
});

const SINGLETON_MERGE_WORKFLOW = JSON.stringify({
  name: "singleton-merge",
  stages: [{
    name: "in progress",
    agent: "merge",
    prompt: "$TASK_PROMPT",
    policy: { transition: "manual" }
  }]
});

type SqlParam = string | number | boolean | null;
type JsonRecord = Record<string, unknown>;

interface TaskSummary {
  id: string;
  repoId: string;
  title: string;
  prompt: string | null;
  agent: string | null;
  stage: string | null;
}

interface TaskDetail extends TaskSummary {
  branch: string | null;
  closedAt: string | null;
  worktreePath: string | null;
}

interface ActionResponse {
  taskId: string;
}

interface SqlResponse {
  rows: JsonRecord[];
  rowsAffected: number;
}

describe("remote task listing, creation, and actions E2E", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
    const desktopSecret = createHash("sha256").update(`${harness.desktopId}:singleton-e2e`).digest("hex");
    const credential = await fetch(`${firestoreBaseUrl(harness)}/desktopCredentials/${harness.desktopId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${await harness.getIdToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {
        desktopId: { stringValue: harness.desktopId },
        displayName: { stringValue: "Singleton E2E Desktop" },
        desktopSecretHash: { stringValue: createHash("sha256").update(desktopSecret).digest("hex") },
        revokedAt: { nullValue: null }, uid: { stringValue: BUFFY_UID },
        updatedAt: { stringValue: new Date().toISOString() },
      } }),
    });
    if (!credential.ok) throw new Error(`credential fixture failed: ${credential.status} ${await credential.text()}`);
    await harness.restartServerWithIdentity({ desktopId: harness.desktopId, desktopSecret });
    await harness.waitForDesktop();
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  it("lists repos and tasks from the desktop database through relay invokes", async () => {
    const fullAlphaPrompt = `${"p".repeat(600)}END-OF-FULL-PROMPT`;
    const alpha = await createScriptedTask(harness, {
      displayName: "Remote list alpha task",
      prompt: fullAlphaPrompt
    });
    const beta = await createScriptedTask(harness, {
      displayName: "Remote list beta task"
    });

    const repos = asRepoSummaries(await invokeDesktop(harness, "GET", "/v1/repos", null));
    expect(repos.map((repo) => repo.id)).toEqual(expect.arrayContaining([alpha.repoId, beta.repoId]));

    const alphaTasks = asTaskSummaries(await invokeDesktop(
      harness,
      "GET",
      `/v1/repos/${alpha.repoId}/tasks`,
      null
    ));
    expect(alphaTasks.map((task) => task.id)).toContain(alpha.taskId);
    expect(alphaTasks.map((task) => task.id)).not.toContain(beta.taskId);

    const recent = asTaskSummaries(await invokeDesktop(harness, "GET", "/v1/tasks/recent", null));
    expect(recent.map((task) => task.id)).toEqual(expect.arrayContaining([alpha.taskId, beta.taskId]));

    const scopedRecentValue = await invokeDesktop(
      harness,
      "GET",
      `/v1/tasks/recent?repoId=${encodeURIComponent(alpha.repoId)}&limit=1`,
      null
    );
    const scopedRecent = asTaskSummaries(scopedRecentValue);
    expect(scopedRecent.map((task) => task.id)).toEqual([alpha.taskId]);
    expect(Array.from(scopedRecent[0]!.prompt ?? "")).toHaveLength(500);
    expect(scopedRecent[0]!.prompt).not.toContain("END-OF-FULL-PROMPT");
    expect(scopedRecent[0]!.agent).toBeTruthy();
    if (!Array.isArray(scopedRecentValue)) {
      throw new Error("expected scoped recent task array");
    }
    expect(asRecord(scopedRecentValue[0]).snippet).toBeUndefined();

    const search = asTaskSummaries(await invokeDesktop(
      harness,
      "GET",
      `/v1/tasks/search?query=${encodeURIComponent("alpha task")}`,
      null
    ));
    expect(search.map((task) => task.id)).toContain(alpha.taskId);
    expect(search.map((task) => task.id)).not.toContain(beta.taskId);

    const scopedSearch = asTaskSummaries(await invokeDesktop(
      harness,
      "GET",
      `/v1/tasks/search?query=${encodeURIComponent("Remote list")}&repoId=${encodeURIComponent(alpha.repoId)}`,
      null
    ));
    expect(scopedSearch.map((task) => task.id)).toEqual([alpha.taskId]);

    const dbRows = await querySql(
      harness,
      "SELECT id, repo_id, display_name, closed_at FROM pipeline_item WHERE id IN (?1, ?2) ORDER BY display_name",
      [alpha.taskId, beta.taskId]
    );
    expect(dbRows).toMatchObject([
      { id: alpha.taskId, repo_id: alpha.repoId, display_name: "Remote list alpha task", closed_at: null },
      { id: beta.taskId, repo_id: beta.repoId, display_name: "Remote list beta task", closed_at: null }
    ]);
  }, 60_000);

  it("creates a task over the relay and exposes its DB, worktree, and terminal state", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Remote creation task"
    });
    const events = collectTerminalEvents(harness, task.taskId);

    try {
      await waitForTerminalOutput(events, "SCRIPT_READY");

      const detail = asTaskDetail(await invokeDesktop(harness, "GET", `/v1/tasks/${task.taskId}`, null));
      expect(detail).toMatchObject({
        id: task.taskId,
        repoId: task.repoId,
        title: "Remote creation task",
        stage: "in progress"
      });
      expect(detail.worktreePath).toBe(task.worktreePath);

      const rows = await querySql(
        harness,
        `SELECT pi.id, pi.branch, pi.agent_provider, wt.path AS worktree_path, sr.status AS run_status
           FROM pipeline_item pi
           JOIN worktree wt ON wt.pipeline_item_id = pi.id AND wt.branch = pi.branch
           JOIN stage_run sr ON sr.task_id = pi.id
          WHERE pi.id = ?1`,
        [task.taskId]
      );
      expect(rows).toMatchObject([
        {
          id: task.taskId,
          branch: `task-${task.taskId}`,
          agent_provider: "codex",
          worktree_path: task.worktreePath,
          run_status: "running"
        }
      ]);
    } finally {
      events.close();
    }
  }, 60_000);

  it("discovers closed children and parent-scoped events through a real CLI and server", async () => {
    const parent = await createScriptedTask(harness, {
      displayName: "CLI child discovery parent"
    });
    const openChildId = await createChildTask(harness, parent, "open");
    const closedChildId = await createChildTask(harness, parent, "closed");

    await invokeDesktop(harness, "POST", `/v1/tasks/${closedChildId}/actions/close`, null);

    const typedParent = asRecord(await runKannaCliJson(harness, [
      "task",
      "get",
      "--task-id",
      parent.taskId
    ]));
    expect(typedParent.childTaskIds).toHaveLength(2);
    expect(typedParent.childTaskIds).toEqual(
      expect.arrayContaining([openChildId, closedChildId])
    );

    const typedClosedChild = asRecord(await runKannaCliJson(harness, [
      "task",
      "get",
      "--task-id",
      closedChildId
    ]));
    expect(typedClosedChild.closedAt).toEqual(expect.any(String));

    const typedEvents = await runKannaCliJson(harness, [
      "task",
      "wait-events",
      "--parent-task-id",
      parent.taskId,
      "--timeout-secs",
      "0"
    ]);
    const typedEventTaskIds = eventTaskIds(typedEvents);
    expect(typedEventTaskIds).toEqual(expect.arrayContaining([openChildId, closedChildId]));
    expect(typedEventTaskIds).not.toContain(parent.taskId);
    const typedCursor = getString(asRecord(typedEvents), "cursor");
    expect(typedCursor).toMatch(/^kh1\.[0-9a-f]{8}$/);
    expect(typedCursor.length).toBeLessThan(128);

    await appendTaskEvent(harness, openChildId, "task.awaiting_input");
    const typedNext = await runKannaCliJson(harness, [
      "task",
      "wait-events",
      "--parent-task-id",
      parent.taskId,
      "--cursor",
      typedCursor,
      "--timeout-secs",
      "0"
    ]);
    expect(eventTaskIds(typedNext)).toEqual([openChildId]);
    expect(eventTypes(typedNext)).toEqual(["task.awaiting_input"]);
    expect(getString(asRecord(typedNext), "cursor").length).toBeLessThan(128);

    // The generic CLI call follows the same generated catalog request path as
    // kanna-mcp, so this proves the declarative casing/serialization contract
    // against the real server in addition to the typed CLI fallback above.
    const catalogParent = asRecord(await runKannaCliJson(harness, [
      "tool",
      "call",
      "kanna_get_task",
      "--json",
      JSON.stringify({ task_id: parent.taskId })
    ]));
    expect(catalogParent.childTaskIds).toHaveLength(2);
    expect(catalogParent.childTaskIds).toEqual(
      expect.arrayContaining([openChildId, closedChildId])
    );

    const catalogEvents = await runKannaCliJson(harness, [
      "tool",
      "call",
      "kanna_wait_events",
      "--json",
      JSON.stringify({ parent_task_id: parent.taskId, timeout_secs: 0 })
    ]);
    expect(eventTaskIds(catalogEvents)).toEqual(
      expect.arrayContaining([openChildId, closedChildId])
    );
    const catalogCursor = getString(asRecord(catalogEvents), "cursor");
    expect(catalogCursor).toMatch(/^kh1\.[0-9a-f]{8}$/);
    expect(catalogCursor.length).toBeLessThan(128);

    await appendTaskEvent(harness, openChildId, "task.revision_requested");
    const catalogNext = await runKannaCliJson(harness, [
      "tool",
      "call",
      "kanna_wait_events",
      "--json",
      JSON.stringify({
        parent_task_id: parent.taskId,
        cursor: catalogCursor,
        timeout_secs: 0
      })
    ]);
    expect(eventTaskIds(catalogNext)).toEqual([openChildId]);
    expect(eventTypes(catalogNext)).toEqual(["task.revision_requested"]);
    expect(getString(asRecord(catalogNext), "cursor").length).toBeLessThan(128);
  }, 120_000);


  it("launches, reuses, and honestly refuses a repository singleton command over the LAN route", async () => {
    // The route the phone's More tab uses. Its 503 was not a transport
    // failure: the LAN request arrived and the desktop's own repository-scoped
    // singleton arbitration refused it, because the relay could not answer
    // singleton directory. This pins all three outcomes on the real route —
    // create, reuse, and refuse without creating a rival.
    const commandTask = await createScriptedTask(harness, {
      displayName: "Repo command singleton"
    });
    const remoteUrlHash = createHash("sha256")
      .update(`repo-command-singleton:${commandTask.repoId}`)
      .digest("hex");
    await invokeDesktop(harness, "PATCH", `/v1/repos/${commandTask.repoId}`, {
      remoteUrlHash
    });
    const openManagers = async (): Promise<string[]> => {
      const rows = await querySql(
        harness,
        `SELECT DISTINCT p.id
           FROM pipeline_item p
           JOIN repo r ON r.id = p.repo_id
           JOIN stage_run s ON s.task_id = p.id AND s.agent = 'task-manager'
          WHERE r.remote_url_hash = ?1 AND p.closed_at IS NULL`,
        [remoteUrlHash]
      );
      return rows.map((row) => getString(row, "id"));
    };

    const catalog = asRecord(await invokeLanJson(
      harness,
      "GET",
      `/v1/repos/${commandTask.repoId}/commands`,
      null
    ));
    const revision = getString(catalog, "revision");
    const commandIds = (catalog.commands as unknown[]).map(
      (command) => getString(asRecord(command), "id")
    );
    expect(commandIds).toContain("custom:task-manager");

    // A sibling desktop that cannot mark its singletons. The hazard is not
    // that it is offline — it is that it published an open task for THIS
    // repository, which could be this repository's manager. That is
    // uncertainty, never permission to elect a rival.
    const strandedDesktopUrl =
      `${firestoreBaseUrl(harness)}/users/${BUFFY_UID}/desktops/stranded-directory-desktop`;
    const strandedTaskUrl = `${strandedDesktopUrl}/tasks/stranded-open-task`;
    const writeFirestore = async (url: string, fields: unknown): Promise<void> => {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
      });
      expect(response.ok).toBe(true);
    };
    await writeFirestore(strandedDesktopUrl, {
      desktopId: { stringValue: "stranded-directory-desktop" },
      singletonDirectoryVersion: { integerValue: "0" }
    });
    const strandedTaskFields = (hash: string) => ({
      ownerDesktopId: { stringValue: "stranded-directory-desktop" },
      ownerLocalTaskId: { stringValue: "stranded-open-task" },
      closedAt: { nullValue: null },
      repo: {
        mapValue: { fields: { remoteUrlHash: { stringValue: hash } } }
      }
    });
    await writeFirestore(strandedTaskUrl, strandedTaskFields(remoteUrlHash));

    const runPath =
      `/v1/repos/${commandTask.repoId}/commands/${encodeURIComponent("custom:task-manager")}/run`;
    const refusal = await invokeLanJson(harness, "POST", runPath, {
      catalogRevision: revision
    }).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    // The desktop explains the refusal in the body, which is what the phone
    // now shows instead of a bare status code, and it names the machine that
    // could not be read.
    expect((refusal as Error).message).toContain("(503)");
    expect((refusal as Error).message).toContain("repository singleton directory");
    expect((refusal as Error).message).toContain("stranded-directory-desktop");
    expect((refusal as Error).message).toContain("no singleton was created");
    expect(await openManagers()).toEqual([]);

    // The same unreadable machine, now holding an open task for a different
    // repository only. Its own index proves it holds nothing that could be
    // this repository's manager, so this repository is no longer blocked —
    // the desktop document stays exactly where it is, untouched.
    await writeFirestore(strandedTaskUrl, strandedTaskFields("unrelated-remote-hash"));

    const created = asRecord(await invokeLanJson(harness, "POST", runPath, {
      catalogRevision: revision
    }));
    expect(created.reused).toBe(false);
    const managerTaskId = getString(created, "taskId");
    // The owner's identity, which is how a caller names the task. This desktop
    // owns it, so both halves are its own.
    expect(getString(created, "ownerDesktopId")).toBe(harness.desktopId);
    expect(getString(created, "ownerLocalRepoId")).toBe(commandTask.repoId);
    expect(getString(created, "ownerLocalTaskId")).toBe(managerTaskId);
    await waitForCondition(
      async () => (await openManagers()).length === 1,
      30_000,
      "the repository command did not create exactly one task-manager singleton"
    );

    // A second launch of the same command reuses the singleton the account
    // already owns rather than creating a second one.
    const reused = asRecord(await invokeLanJson(harness, "POST", runPath, {
      catalogRevision: revision
    }));
    expect(reused).toMatchObject({
      taskId: managerTaskId,
      reused: true,
      ownerDesktopId: harness.desktopId,
      ownerLocalRepoId: commandTask.repoId,
      ownerLocalTaskId: managerTaskId
    });
    expect(await openManagers()).toEqual([managerTaskId]);

    // A catalog the caller has not refreshed is refused separately, and that
    // refusal also creates nothing.
    const stale = await invokeLanJson(harness, "POST", runPath, {
      catalogRevision: "stale-revision"
    }).then(() => null, (error: unknown) => error);
    expect((stale as Error).message).toContain("(409)");
    expect(await openManagers()).toEqual([managerTaskId]);

    await invokeDesktop(harness, "POST", `/v1/tasks/${managerTaskId}/actions/close`, null);
    await waitForCondition(
      async () => (await openManagers()).length === 0,
      30_000,
      "closing the singleton did not release it"
    );

    for (const url of [strandedTaskUrl, strandedDesktopUrl]) {
      await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer owner" } });
    }
  }, 180_000);

  it("advances stages, completes stages, requests revision, runs merge agent, and closes with current durable-task semantics", async () => {
    const advanceTask = await createScriptedTask(harness, {
      displayName: "Remote advance task"
    });
    await setWorkflowDefinition(
      harness,
      advanceTask.taskId,
      "remote-linear-manual",
      LINEAR_MANUAL_WORKFLOW,
      "manual"
    );

    const advanceResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${advanceTask.taskId}/actions/advance-stage`,
      { source: "operator" }
    ));
    expect(advanceResponse.taskId).toBe(advanceTask.taskId);
    await waitForTaskStage(harness, advanceTask.taskId, "review");
    const advanced = await taskRow(harness, advanceTask.taskId);
    expect(advanced).toMatchObject({
      id: advanceTask.taskId,
      stage: "review",
      branch: `task-${advanceTask.taskId}-2`,
      closed_at: null
    });
    const advanceWorktrees = await querySql(
      harness,
      "SELECT branch, path FROM worktree WHERE pipeline_item_id = ?1 ORDER BY branch",
      [advanceTask.taskId]
    );
    expect(advanceWorktrees).toMatchObject([
      {
        branch: `task-${advanceTask.taskId}-2`
      }
    ]);
    expect(await git(await repoPathForTask(harness, advanceTask.taskId), [
      "show-ref",
      "--verify",
      `refs/heads/task-${advanceTask.taskId}-2`
    ])).toContain(`task-${advanceTask.taskId}-2`);
    const advanceDetail = asRecord(await invokeDesktop(
      harness,
      "GET",
      `/v1/tasks/${advanceTask.taskId}`,
      null
    ));
    expect(getString(asRecord(advanceDetail.latestRun), "trigger")).toBe("operator");
    const advanceReviewRun = await latestRunRow(harness, advanceTask.taskId);

    const successTask = await createScriptedTask(harness, {
      displayName: "Remote complete success task"
    });
    const successRun = await latestRunRow(harness, successTask.taskId);
    await setWorkflowDefinition(
      harness,
      successTask.taskId,
      "remote-linear-auto",
      LINEAR_AUTO_WORKFLOW,
      "auto"
    );
    const successResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${successTask.taskId}/actions/complete-stage`,
      {
        runId: successRun.id,
        status: "success",
        summary: "implemented over relay",
        metadata: { coverage: "remote-e2e" }
      }
    ));
    expect(successResponse.taskId).toBe(successTask.taskId);
    await waitForTaskStage(harness, successTask.taskId, "review");
    expect(await latestRunRow(harness, successTask.taskId)).toMatchObject({
      stage: "review",
      kind: "main",
      status: "running",
      trigger: "auto"
    });

    const failureTask = await createScriptedTask(harness, {
      displayName: "Remote complete failure task"
    });
    const failureRun = await latestRunRow(harness, failureTask.taskId);
    await setWorkflowDefinition(
      harness,
      failureTask.taskId,
      "remote-linear-auto",
      LINEAR_AUTO_WORKFLOW,
      "auto"
    );
    const failureResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${failureTask.taskId}/actions/complete-stage`,
      {
        runId: failureRun.id,
        status: "failure",
        summary: "tests failed over relay",
        metadata: { failing: "remote-e2e" }
      }
    ));
    expect(failureResponse.taskId).toBe(failureTask.taskId);
    await waitForLatestRunStatus(harness, failureTask.taskId, "failed");
    expect(await taskRow(harness, failureTask.taskId)).toMatchObject({
      id: failureTask.taskId,
      stage: "in progress",
      closed_at: null
    });

    const revisionResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${advanceTask.taskId}/actions/request-revision`,
      {
        runId: getString(advanceReviewRun, "id"),
        targetStage: "in progress",
        summary: "review failed over relay",
        prompt: "Address the remote action assertion gaps.",
        metadata: { reviewer: "remote-e2e" }
      }
    ));
    expect(revisionResponse.taskId).toBe(advanceTask.taskId);
    await waitForTaskStage(harness, advanceTask.taskId, "in progress");
    expect(await taskRow(harness, advanceTask.taskId)).toMatchObject({
      id: advanceTask.taskId,
      stage: "in progress",
      branch: `task-${advanceTask.taskId}-3`,
      closed_at: null
    });
    const revisionRuns = await querySql(
      harness,
      "SELECT stage, status, feedback FROM stage_run WHERE task_id = ?1 ORDER BY started_at, id",
      [advanceTask.taskId]
    );
    expect(revisionRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "review",
          status: "failed",
          feedback: "review failed over relay"
        }),
        expect.objectContaining({
          stage: "in progress",
          status: "running",
          feedback: "Address the remote action assertion gaps."
        })
      ])
    );

    const remoteUrlHash = createHash("sha256").update(`singleton-e2e:${advanceTask.repoId}`).digest("hex");
    await invokeDesktop(harness, "PATCH", `/v1/repos/${advanceTask.repoId}`, { remoteUrlHash });
    const claimKey = createHash("sha256").update(remoteUrlHash).update("\0merge").digest("hex");
    const claimUrl = `${firestoreBaseUrl(harness)}/users/${BUFFY_UID}/repoSingletonClaims/${claimKey}`;
    const mergeResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${advanceTask.taskId}/actions/run-merge-agent`,
      null
    ));
    expect(mergeResponse.taskId).not.toBe(advanceTask.taskId);
    await waitForCondition(async () => {
      const rows = await querySql(
        harness,
        "SELECT display_name, pipeline FROM pipeline_item WHERE id = ?1",
        [mergeResponse.taskId]
      );
      return rows[0]?.display_name === "Merge Master" && rows[0]?.pipeline === "singleton-merge";
    }, 10_000, "merge agent task was not recorded");

    // Closing idle singletons is ordinary cleanup. The explicit handoff must
    // recover through account ownership arbitration, including publication.
    await invokeDesktop(harness, "POST", `/v1/tasks/${mergeResponse.taskId}/actions/close`, null);
    const replacement = asActionResponse(await invokeDesktop(
      harness, "POST", `/v1/tasks/${advanceTask.taskId}/actions/signal-merge-handoff`,
      { branch: "feature/reclaim", target: "main", summary: "Reclaim closed Merge Master" }
    ));
    expect(replacement.taskId).not.toBe(mergeResponse.taskId);
    await waitForCondition(async () => {
      const rows = await querySql(harness,
        "SELECT id FROM pipeline_item WHERE pipeline = 'singleton-merge' AND closed_at IS NULL"
      );
      return rows.length === 1 && rows[0]?.id === replacement.taskId;
    }, 30_000, "handoff did not recreate exactly one Merge Master");
    await waitForCondition(async () => {
      const response = await fetch(claimUrl, { headers: { Authorization: "Bearer owner" } });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`claim read failed: ${response.status}`);
      const document = asRecord(await response.json());
      const fields = asRecord(document.fields);
      return asRecord(fields.machineId).stringValue === harness.desktopId
        && asRecord(fields.taskId).stringValue === replacement.taskId;
    }, 30_000, "replacement owner was not published to the account claim");
    await invokeDesktop(harness, "POST", `/v1/tasks/${replacement.taskId}/actions/close`, null);
    await waitForCondition(async () => {
      const response = await fetch(claimUrl, { headers: { Authorization: "Bearer owner" } });
      if (response.status === 404) return true;
      if (!response.ok) throw new Error(`claim read failed: ${response.status}`);
      return false;
    }, 30_000, "closing the replacement did not release the cloud claim");

    const closeTask = await createScriptedTask(harness, {
      displayName: "Remote close task"
    });
    const closeBefore = await taskRow(harness, closeTask.taskId);
    const closeWorktreePath = getString(closeBefore, "worktree_path");
    const closeBranch = getString(closeBefore, "branch");
    const repoPath = await repoPathForTask(harness, closeTask.taskId);
    await writeFile(`${closeWorktreePath}/dirty-close.txt`, "dirty state captured at close\n");

    await invokeDesktop(harness, "POST", `/v1/tasks/${closeTask.taskId}/actions/close`, null);
    await waitForCondition(async () => {
      const row = await taskRow(harness, closeTask.taskId);
      return typeof row.closed_at === "string";
    }, 10_000, "task did not close");
    await waitForCondition(async () => {
      const rows = await querySql(
        harness,
        "SELECT id FROM worktree WHERE pipeline_item_id = ?1",
        [closeTask.taskId]
      );
      return rows.length === 0;
    }, 10_000, "closed task worktree rows were not removed");
    await expect(stat(closeWorktreePath)).rejects.toThrow();
    expect(await git(repoPath, ["show-ref", "--verify", `refs/heads/${closeBranch}`])).toContain(closeBranch);
    expect(await git(repoPath, ["log", "-1", "--pretty=%s", closeBranch])).toContain("WIP at task close");

    const repoTasksAfterClose = asTaskSummaries(await invokeDesktop(
      harness,
      "GET",
      `/v1/repos/${closeTask.repoId}/tasks`,
      null
    ));
    expect(repoTasksAfterClose.map((task) => task.id)).not.toContain(closeTask.taskId);
  }, 120_000);
});

async function invokeDesktop(
  harness: RemoteHarness,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body: unknown
): Promise<unknown> {
  return await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method,
    path,
    body
  });
}

async function invokeLanJson(
  harness: RemoteHarness,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const response = await fetch(`${harness.lanBaseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: method === "GET" ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LAN ${method} ${path} failed (${response.status}): ${text}`);
  }
  return text.length > 0 ? JSON.parse(text) as unknown : null;
}

async function createChildTask(
  harness: RemoteHarness,
  parent: { repoId: string; taskId: string },
  label: string
): Promise<string> {
  const response = asRecord(await invokeDesktop(harness, "POST", "/v1/tasks", {
    repoId: parent.repoId,
    prompt: `Run deterministic child task ${label}`,
    displayName: `CLI child discovery ${label} child`,
    agentProvider: "codex",
    agentType: "pty",
    parentTaskId: parent.taskId
  }));
  return getString(response, "taskId");
}

async function runKannaCliJson(
  harness: RemoteHarness,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    remoteHarnessKannaCliPath(harness.repoRoot),
    [...args, "--server-url", harness.lanBaseUrl],
    {
      cwd: harness.repoRoot,
      env: { ...process.env, ...extraEnv },
      timeout: 30_000
    }
  );
  return JSON.parse(String(stdout)) as unknown;
}

function eventTaskIds(value: unknown): string[] {
  const events = asRecord(value).events;
  if (!Array.isArray(events)) {
    throw new Error(`expected task event array ${JSON.stringify(value)}`);
  }
  return events.map((event) => getString(asRecord(event), "taskId"));
}

function eventTypes(value: unknown): string[] {
  const events = asRecord(value).events;
  if (!Array.isArray(events)) {
    throw new Error(`expected task event array ${JSON.stringify(value)}`);
  }
  return events.map((event) => getString(asRecord(event), "type"));
}

async function appendTaskEvent(
  harness: RemoteHarness,
  taskId: string,
  eventType: string
): Promise<void> {
  const rowsAffected = await executeSql(
    harness,
    "INSERT INTO task_event (task_id, type, payload) VALUES (?1, ?2, '{}')",
    [taskId, eventType]
  );
  expect(rowsAffected).toBe(1);
}

async function querySql(harness: RemoteHarness, sql: string, params: SqlParam[] = []): Promise<JsonRecord[]> {
  const response = asSqlResponse(await invokeDesktop(harness, "POST", "/v1/e2e/sql", {
    query: true,
    sql,
    params
  }));
  return response.rows;
}

async function executeSql(harness: RemoteHarness, sql: string, params: SqlParam[] = []): Promise<number> {
  const response = asSqlResponse(await invokeDesktop(harness, "POST", "/v1/e2e/sql", {
    query: false,
    sql,
    params
  }));
  return response.rowsAffected;
}

async function setWorkflowDefinition(
  harness: RemoteHarness,
  taskId: string,
  workflowName: string,
  workflowDefinition: string,
  completionTransition: "manual" | "auto"
): Promise<void> {
  const taskRowsAffected = await executeSql(
    harness,
    "UPDATE pipeline_item SET pipeline = ?1, pipeline_def = ?2 WHERE id = ?3",
    [workflowName, workflowDefinition, taskId]
  );
  expect(taskRowsAffected).toBe(1);

  const runRowsAffected = await executeSql(
    harness,
    `UPDATE stage_run
        SET completion_transition = ?1
      WHERE task_id = ?2 AND kind = 'main' AND status = 'running'`,
    [completionTransition, taskId]
  );
  expect(runRowsAffected).toBe(1);
}

async function waitForTaskStage(harness: RemoteHarness, taskId: string, stage: string): Promise<void> {
  await waitForCondition(async () => {
    const row = await taskRow(harness, taskId);
    return row.stage === stage;
  }, 15_000, `task ${taskId} did not reach stage ${stage}`);
}

async function waitForLatestRunStatus(
  harness: RemoteHarness,
  taskId: string,
  status: string
): Promise<void> {
  await waitForCondition(async () => {
    const row = await latestRunRow(harness, taskId);
    return row.status === status;
  }, 10_000, `task ${taskId} latest run did not reach ${status}`);
}

async function taskRow(harness: RemoteHarness, taskId: string): Promise<JsonRecord> {
  const rows = await querySql(
    harness,
    `SELECT pi.id, pi.stage, pi.branch, pi.closed_at, wt.path AS worktree_path
       FROM pipeline_item pi
       LEFT JOIN worktree wt ON wt.pipeline_item_id = pi.id AND wt.branch = pi.branch
      WHERE pi.id = ?1`,
    [taskId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected one task row for ${taskId}, got ${rows.length}`);
  }
  return rows[0]!;
}

async function latestRunRow(harness: RemoteHarness, taskId: string): Promise<JsonRecord> {
  const rows = await querySql(
    harness,
    `SELECT id, stage, kind, status, feedback, COALESCE(trigger, 'unspecified') AS trigger
       FROM stage_run
      WHERE task_id = ?1
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
    [taskId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected one latest run row for ${taskId}, got ${rows.length}`);
  }
  return rows[0]!;
}

async function repoPathForTask(harness: RemoteHarness, taskId: string): Promise<string> {
  const rows = await querySql(
    harness,
    `SELECT r.path
       FROM repo r
       JOIN pipeline_item pi ON pi.repo_id = r.id
      WHERE pi.id = ?1`,
    [taskId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected repo path for ${taskId}`);
  }
  return getString(rows[0]!, "path");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: process.env });
  return stdout;
}

function asSqlResponse(value: unknown): SqlResponse {
  if (!isRecord(value) || !Array.isArray(value.rows) || typeof value.rowsAffected !== "number") {
    throw new Error(`unexpected SQL response ${JSON.stringify(value)}`);
  }
  return {
    rows: value.rows.map(asRecord),
    rowsAffected: value.rowsAffected
  };
}

function asRepoSummaries(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) {
    throw new Error(`expected repo summaries array ${JSON.stringify(value)}`);
  }
  return value.map((item) => {
    const record = asRecord(item);
    return {
      id: getString(record, "id"),
      name: getString(record, "name")
    };
  });
}

function asTaskSummaries(value: unknown): TaskSummary[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected task summaries array ${JSON.stringify(value)}`);
  }
  return value.map((item) => {
    const record = asRecord(item);
    return {
      id: getString(record, "id"),
      repoId: getString(record, "repoId"),
      title: getString(record, "title"),
      prompt: getOptionalString(record, "prompt"),
      agent: getOptionalString(record, "agent"),
      stage: getOptionalString(record, "stage")
    };
  });
}

function asTaskDetail(value: unknown): TaskDetail {
  const record = asRecord(value);
  return {
    id: getString(record, "id"),
    repoId: getString(record, "repoId"),
    title: getString(record, "title"),
    prompt: getOptionalString(record, "prompt"),
    agent: getOptionalString(record, "agent"),
    stage: getOptionalString(record, "stage"),
    branch: getOptionalString(record, "branch"),
    closedAt: getOptionalString(record, "closedAt"),
    worktreePath: getOptionalString(record, "worktreePath")
  };
}

function asActionResponse(value: unknown): ActionResponse {
  const record = asRecord(value);
  return { taskId: getString(record, "taskId") };
}

function asRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`expected object ${JSON.stringify(value)}`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function getString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`expected string field ${key} in ${JSON.stringify(record)}`);
  }
  return value;
}

function getOptionalString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`expected optional string field ${key} in ${JSON.stringify(record)}`);
  }
  return value;
}

function firestoreBaseUrl(harness: RemoteHarness): string {
  return `http://127.0.0.1:${harness.ports.firestore}/v1/projects/kanna-local/databases/(default)/documents`;
}
