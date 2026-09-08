import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureRepo, type FixtureRepo } from "./fixtureRepo.ts";
import { binary, run, waitFor, Worker } from "./worker.ts";

/**
 * Linux Phase 1's exit gate, exercised through the real wiring on whatever
 * platform it runs on.
 *
 * Every assertion is against durable state — rows the server wrote, branches
 * and worktrees git actually has — and never against terminal output. A gate
 * that scraped a terminal would pass on a screenful of the right characters
 * while the record behind it was empty, which is the failure mode the input
 * ledger exists to prevent.
 *
 * The cases run in order and share one worker and one task on purpose: the
 * gate is a *lifecycle*, and a task that was created, executed, instructed,
 * completed, forked and closed in sequence is the thing being proven.
 */

/** The 2026-09-06 incident's length: one line, no newline, delivered whole. */
const LONG_MESSAGE = `HEAD ${"x".repeat(1_047 - 5 - 25)}and this is the tail only`;

let repo: FixtureRepo;
let worker: Worker;
let repoId: string;
let taskId: string;
let firstBranch: string;
let firstWorktree: string;

async function supervisorPid(): Promise<number> {
  const listing = await run("/bin/ps", ["-eo", "pid,args"], process.env);
  const line = listing.stdout
    .split("\n")
    .find((entry) => entry.includes(`kanna-worker run --data-dir ${worker.dataDir}`));
  if (!line) throw new Error(`no supervisor for ${worker.dataDir}:\n${listing.stdout}`);
  return Number.parseInt(line.trim().split(/\s+/)[0]!, 10);
}

beforeAll(async () => {
  repo = await createFixtureRepo();
  worker = await Worker.start(repo.providerBinDir);
}, 240_000);

afterAll(async () => {
  await worker?.stop();
});

async function git(args: string[], cwd = repo.path): Promise<string> {
  const result = await run("git", args, process.env, cwd);
  return result.stdout.trim();
}

/** The task's branches, by ref rather than by `git branch`'s decorated output. */
async function taskBranches(): Promise<string[]> {
  const refs = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  return refs
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(firstBranch))
    .sort();
}

async function task(): Promise<Record<string, unknown>> {
  return worker.json(`/v1/tasks/${taskId}`);
}

describe("the headless worker's exit gate", () => {
  it("starts the daemon and the server as its own children and authorizes them", async () => {
    const status = await worker.status();
    expect(status?.state).toBe("running");

    const supervisor = await supervisorPid();
    // Both must be direct children of the supervisor. That parentage is the
    // daemon's trust root -- a daemon parented by anything it cannot read
    // through /proc refuses to start at all -- not a deployment detail.
    for (const pid of [await worker.daemonPid(), await worker.serverPid()]) {
      const parent = await run("/bin/ps", ["-o", "ppid=", "-p", String(pid)], process.env);
      expect(Number.parseInt(parent.stdout.trim(), 10)).toBe(supervisor);
    }
  });

  it("creates a task in a registered repository", async () => {
    const added = await worker.cli(["repo", "add", "--path", repo.path]);
    expect(added.code, `${added.stdout}${added.stderr}`).toBe(0);
    const repos = await worker.sql("SELECT id, path FROM repo", []);
    const registered = repos.find((row) => String(row.path).endsWith("/repo"));
    expect(registered, JSON.stringify(repos)).toBeTruthy();
    repoId = String(registered!.id);

    const created = await worker.cli([
      "task",
      "create",
      "--repo-id",
      repoId,
      "--prompt",
      "headless gate task",
      "--workflow-name",
      "gate",
    ]);
    expect(created.code, created.stderr).toBe(0);
    const rows = await worker.sql(
      "SELECT id, stage, branch FROM pipeline_item ORDER BY rowid DESC LIMIT 1",
      [],
    );
    taskId = String(rows[0]?.id);
    expect(taskId).toBeTruthy();
    expect(rows[0]?.stage).toBe("in progress");
    firstBranch = String(rows[0]?.branch);
  });

  it("executes the stage: the agent session runs and settles", async () => {
    await waitFor(
      async () => {
        const detail = await task();
        return detail.runtimeState === "busy" || detail.runtimeState === "idle";
      },
      async () => `task never started running: ${JSON.stringify(await task())}`,
    );
    const detail = await task();
    expect(["busy", "idle", "waiting"]).toContain(detail.runtimeState);
    expect(detail.latestRun).toBeTruthy();

    // A running *session* is not yet a running *agent*: the PTY starts with a
    // login shell that runs repo setup and only then execs the provider.
    // Input sent before that reaches the shell, not the agent -- which is why
    // the gate waits for the agent's own marker rather than for a stage run.
    await waitFor(
      async () => (await worker.cli(["task", "logs", "--task-id", taskId])).stdout.includes(
        "SCRIPT_READY",
      ),
      "the scripted agent never announced itself",
    );

    // The worktree the run is actually executing in, as recorded, rather
    // than a path this lane guesses from the branch name.
    const runs = await worker.sql(
      "SELECT cwd FROM stage_run WHERE task_id = ?1 AND cwd IS NOT NULL ORDER BY rowid LIMIT 1",
      [taskId],
    );
    firstWorktree = String(runs[0]?.cwd ?? join(repo.path, ".kanna-worktrees", firstBranch));
    expect(existsSync(firstWorktree), firstWorktree).toBe(true);
  });

  it("records a delivered input durably, whole, and submitted once", async () => {
    const sent = await worker.cli([
      "task",
      "send-input",
      "--task-id",
      taskId,
      "--message",
      LONG_MESSAGE,
      "--source",
      "operator",
    ]);
    expect(sent.code, sent.stderr).toBe(0);

    const rows = await worker.sql(
      "SELECT message, source, stage FROM task_input WHERE task_id = ?1",
      [taskId],
    );
    expect(rows).toHaveLength(1);
    // The full text, not a summary and not a prefix: a later stage reads this
    // record to learn what it was told.
    expect(rows[0]?.message).toBe(LONG_MESSAGE);
    expect(rows[0]?.source).toBe("operator");
    expect(rows[0]?.stage).toBe("in progress");
    expect((await task()).deliveredInputCount).toBe(1);

    // And the agent received it as one submission of the whole line. This is
    // the 2026-09-06 incident's shape; the guarantee is in-band framing, so it
    // holds wherever the consumer's read boundaries happen to fall.
    await waitFor(
      async () => (await repo.agentInput()).includes(LONG_MESSAGE),
      async () => `agent never received the message whole: ${JSON.stringify(await repo.agentInput())}`,
    );
    const received = await repo.agentInput();
    expect(received.filter((line) => line === LONG_MESSAGE)).toHaveLength(1);
  });

  it("records completion as a terminal stage run", async () => {
    const completed = await worker.cli([
      "stage-complete",
      "--task-id",
      taskId,
      "--status",
      "success",
      "--summary",
      "gate stage done",
    ]);
    expect(completed.code, completed.stderr).toBe(0);

    const runs = await worker.sql(
      "SELECT status, result, stage, kind FROM stage_run WHERE task_id = ?1 ORDER BY rowid",
      [taskId],
    );
    const terminal = runs.find((row) => row.status === "succeeded");
    expect(terminal, JSON.stringify(runs)).toBeTruthy();
    expect(terminal?.result).toContain("gate stage done");

    const events = await worker.sql("SELECT type FROM task_event WHERE task_id = ?1", [taskId]);
    expect(events.map((row) => row.type)).toContain("run.finished");
  });

  it("forks a fresh workspace at the stage boundary", async () => {
    const committedTip = await git(["rev-parse", firstBranch]);

    const advanced = await worker.cli([
      "task",
      "advance-stage",
      "--task-id",
      taskId,
      "--source",
      "operator",
    ]);
    expect(advanced.code, advanced.stderr).toBe(0);

    await waitFor(
      async () => (await task()).stage === "review",
      async () => `task never reached review: ${JSON.stringify(await task())}`,
    );

    const detail = await task();
    const forked = String(detail.branch);
    expect(forked).toBe(`${firstBranch}-2`);
    // Cut from the task's committed tip, not from whatever main happens to be.
    expect(await git(["rev-parse", forked])).toBe(committedTip);
    expect(existsSync(join(repo.path, ".kanna-worktrees", forked))).toBe(true);

    const runs = await worker.sql(
      "SELECT stage, kind, trigger FROM stage_run WHERE task_id = ?1 AND stage = 'review'",
      [taskId],
    );
    expect(runs[0]?.trigger).toBe("operator");
  });

  it("survives a server restart with its daemon generation and session intact", async () => {
    const daemonBefore = await worker.daemonPid();
    const serverBefore = await worker.serverPid();
    process.kill(serverBefore, "SIGKILL");

    await waitFor(
      async () => {
        const pid = await worker.serverPid().catch(() => serverBefore);
        return pid !== serverBefore && (await worker.status()) !== null;
      },
      () => `the supervisor never replaced the server\n${worker.output()}`,
    );

    // The daemon was never restarted, and the new server was re-authorized on
    // that same generation — otherwise the task below could not be steered.
    expect(await worker.daemonPid()).toBe(daemonBefore);

    const sent = await worker.cli([
      "task",
      "send-input",
      "--task-id",
      taskId,
      "--message",
      "after the server restart",
      "--source",
      "operator",
    ]);
    expect(sent.code, sent.stderr).toBe(0);
    await waitFor(
      async () => (await repo.agentInput()).includes("after the server restart"),
      "the session did not accept input after the server restarted",
    );
  });

  it("replaces the daemon under a live session and keeps it", async () => {
    const before = await worker.daemonPid();
    worker.reload();

    await waitFor(
      async () => (await worker.daemonPid().catch(() => before)) !== before,
      () => `no successor daemon was published\n${worker.output()}`,
    );
    const after = await worker.daemonPid();
    expect(after).not.toBe(before);

    // The session moved to the successor with its child process intact: it
    // still accepts input, and the delivery is still recorded.
    const sent = await worker.cli([
      "task",
      "send-input",
      "--task-id",
      taskId,
      "--message",
      "after the daemon handoff",
      "--source",
      "operator",
    ]);
    expect(sent.code, sent.stderr).toBe(0);
    await waitFor(
      async () => (await repo.agentInput()).includes("after the daemon handoff"),
      "the session did not survive the daemon handoff",
    );
    const rows = await worker.sql("SELECT message FROM task_input WHERE task_id = ?1", [taskId]);
    expect(rows.map((row) => row.message)).toContain("after the daemon handoff");
  });

  it("closes the task, keeping its branches and removing its worktrees", async () => {
    const branchesBefore = await taskBranches();
    expect(branchesBefore.length).toBeGreaterThanOrEqual(2);

    const closed = await worker.cli(["task", "close", "--task-id", taskId]);
    expect(closed.code, closed.stderr).toBe(0);

    await waitFor(
      async () => {
        const rows = await worker.sql(
          "SELECT closed_at FROM pipeline_item WHERE id = ?1",
          [taskId],
        );
        return rows[0]?.closed_at !== null && rows[0]?.closed_at !== undefined;
      },
      "the task never recorded a close",
    );

    await waitFor(
      async () => !existsSync(firstWorktree),
      () => `worktree ${firstWorktree} outlived the close`,
    );

    // Close never deletes a branch.
    const branchesAfter = await taskBranches();
    expect(branchesAfter).toEqual(branchesBefore);

    // The task keeps its last stage: visibility is `closed_at`, not stage.
    const rows = await worker.sql("SELECT stage FROM pipeline_item WHERE id = ?1", [taskId]);
    expect(rows[0]?.stage).toBe("review");
  });
});

describe("the systemd user unit", () => {
  const linux = process.platform === "linux";

  it.skipIf(!linux)(
    "stops only the supervisor, so a unit restart leaves the daemon and its sessions alive",
    async () => {
      const unit = await run(binary("kanna-worker"), ["print-unit"], process.env);
      expect(unit.code, unit.stderr).toBe(0);
      // The one setting that decides whether restarting the service kills
      // every agent on the machine.
      expect(unit.stdout).toContain("KillMode=process");
      expect(unit.stdout).toContain("ExecReload=/bin/kill -HUP $MAINPID");
      expect(unit.stdout).toMatch(/Environment=PATH=\S+/);
    },
  );

  it.skipIf(!linux)("installs into the XDG user unit directory", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "kanna-worker-unit-"));
    const target = join(dir, "kanna-worker.service");
    const installed = await run(
      binary("kanna-worker"),
      ["install-unit", "--unit-path", target],
      process.env,
    );
    expect(installed.code, installed.stderr).toBe(0);
    expect(await readFile(target, "utf8")).toContain("ExecStart=");
  });
});
