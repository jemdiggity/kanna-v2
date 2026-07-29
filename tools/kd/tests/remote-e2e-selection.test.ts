import { describe, expect, it } from "vitest";
import {
  REMOTE_E2E_TRIGGER_PATHS,
  buildRemoteE2eLaneArgs,
  executeRemoteE2e,
  matchRemoteE2eTriggerPaths,
  selectRemoteE2eByChangedPaths,
} from "../src/runtime/remote-e2e";
import type { CommandResult, CommandRunner } from "../src/runtime/process";

interface RecordedCall {
  command: string;
  args: string[];
}

function gitRunner(
  responses: Record<string, Partial<CommandResult>>,
  calls: RecordedCall[]
): CommandRunner {
  return {
    async run(command, args) {
      calls.push({ command, args });
      const key = `${command} ${args.join(" ")}`;
      const response = responses[key];
      if (!response) {
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${key}` };
      }
      return { exitCode: 0, stdout: "", stderr: "", ...response };
    },
  };
}

const ORIGIN_HEAD = "git symbolic-ref --short refs/remotes/origin/HEAD";
const MERGE_BASE = "git merge-base origin/main HEAD";
const DIFF = "git diff --name-only abc123";
const UNTRACKED = "git ls-files --others --exclude-standard";

function gitResponses(diff: string, untracked = ""): Record<string, Partial<CommandResult>> {
  return {
    [ORIGIN_HEAD]: { stdout: "origin/main\n" },
    [MERGE_BASE]: { stdout: "abc123\n" },
    [DIFF]: { stdout: diff },
    [UNTRACKED]: { stdout: untracked },
  };
}

const DEV_LANE_OPTIONS = {
  staging: false,
  mobileRelay: false,
  desktopPairing: false,
  ifChanged: true,
};

describe("remote E2E trigger paths", () => {
  it("matches the path filter of the deleted remote-e2e.yml workflow", () => {
    expect([...REMOTE_E2E_TRIGGER_PATHS]).toEqual([
      "services/relay/",
      "crates/kanna-server/",
      "services/firebase-functions/",
      "apps/mobile/src/lib/",
      "tests/remote-e2e/",
      "tools/kd/",
    ]);
  });

  it("matches by path prefix without matching sibling directories", () => {
    expect(
      matchRemoteE2eTriggerPaths([
        "crates/kanna-server/src/mobile_api.rs",
        "crates/kanna-daemon/src/lib.rs",
        "apps/mobile/src/lib/transports/relayClient.ts",
        "apps/mobile/src/screens/TaskList.tsx",
        "docs/specs/remote-task-e2e.md",
      ])
    ).toEqual([
      "crates/kanna-server/src/mobile_api.rs",
      "apps/mobile/src/lib/transports/relayClient.ts",
    ]);
  });
});

describe("kd test remote-e2e --if-changed", () => {
  it("reports the branch changed paths against the default branch merge-base", async () => {
    const calls: RecordedCall[] = [];
    const runner = gitRunner(
      gitResponses("services/relay/src/index.ts\nREADME.md\n", "tests/remote-e2e/src/new.ts\n"),
      calls
    );

    const selection = await selectRemoteE2eByChangedPaths({
      repoRoot: "/repo",
      env: {},
      runner,
    });

    expect(selection).toEqual({
      required: true,
      defaultBranchRef: "origin/main",
      mergeBase: "abc123",
      changedPaths: ["README.md", "services/relay/src/index.ts", "tests/remote-e2e/src/new.ts"],
      matchedPaths: ["services/relay/src/index.ts", "tests/remote-e2e/src/new.ts"],
    });
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      ORIGIN_HEAD,
      MERGE_BASE,
      DIFF,
      UNTRACKED,
    ]);
  });

  it("falls back to a known default branch ref when origin/HEAD is unset", async () => {
    const calls: RecordedCall[] = [];
    const runner = gitRunner(
      {
        [ORIGIN_HEAD]: { exitCode: 128, stderr: "ref refs/remotes/origin/HEAD is not a symbolic ref" },
        "git rev-parse --verify --quiet origin/main": { stdout: "deadbeef\n" },
        [MERGE_BASE]: { stdout: "abc123\n" },
        [DIFF]: { stdout: "docs/specs/remote-task-e2e.md\n" },
        [UNTRACKED]: { stdout: "" },
      },
      calls
    );

    const selection = await selectRemoteE2eByChangedPaths({
      repoRoot: "/repo",
      env: {},
      runner,
    });

    expect(selection.defaultBranchRef).toBe("origin/main");
    expect(selection.required).toBe(false);
  });

  it("runs the unchanged dev lane when a trigger path changed", async () => {
    const calls: RecordedCall[] = [];
    const responses = {
      ...gitResponses("crates/kanna-server/src/mobile_api.rs\n"),
      "pnpm --dir tests/remote-e2e exec tsx src/run.ts --dev": { stdout: "remote e2e passed" },
    };

    const result = await executeRemoteE2e({
      repoRoot: "/repo",
      env: { KANNA_DEV_PORT: "1421" },
      runner: gitRunner(responses, calls),
      options: DEV_LANE_OPTIONS,
    });

    expect(calls.filter((call) => call.command !== "git")).toEqual([
      { command: "pnpm", args: buildRemoteE2eLaneArgs(DEV_LANE_OPTIONS) },
    ]);
    expect(result).toEqual({
      ok: true,
      message: "remote e2e passed",
      data: {
        command: "pnpm",
        args: ["--dir", "tests/remote-e2e", "exec", "tsx", "src/run.ts", "--dev"],
        exitCode: 0,
      },
    });
  });

  it("keeps the extra Layer C and Layer D lanes when a trigger path changed", async () => {
    const calls: RecordedCall[] = [];
    const options = { ...DEV_LANE_OPTIONS, mobileRelay: true, desktopPairing: true };
    const responses = {
      ...gitResponses("tools/kd/src/runtime/remote-e2e.ts\n"),
      "pnpm --dir tests/remote-e2e exec tsx src/run.ts --dev --mobile-relay --desktop-pairing": {
        stdout: "ok",
      },
    };

    const result = await executeRemoteE2e({
      repoRoot: "/repo",
      env: {},
      runner: gitRunner(responses, calls),
      options,
    });

    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.command !== "git")).toEqual([
      { command: "pnpm", args: buildRemoteE2eLaneArgs(options) },
    ]);
  });

  it("does no emulator or test work when no trigger path changed", async () => {
    const calls: RecordedCall[] = [];
    const runner = gitRunner(
      gitResponses("docs/specs/remote-task-e2e.md\napps/desktop/src/App.vue\n"),
      calls
    );

    const result = await executeRemoteE2e({
      repoRoot: "/repo",
      env: {},
      runner,
      options: DEV_LANE_OPTIONS,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("remote E2E not required for this branch");
    expect(calls.every((call) => call.command === "git")).toBe(true);
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      ORIGIN_HEAD,
      MERGE_BASE,
      DIFF,
      UNTRACKED,
    ]);
  });

  it("runs the lane unconditionally when --if-changed is absent", async () => {
    const calls: RecordedCall[] = [];
    const runner = gitRunner(
      { "pnpm --dir tests/remote-e2e exec tsx src/run.ts --dev": { stdout: "ok" } },
      calls
    );

    const result = await executeRemoteE2e({
      repoRoot: "/repo",
      env: {},
      runner,
      options: { ...DEV_LANE_OPTIONS, ifChanged: false },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { command: "pnpm", args: ["--dir", "tests/remote-e2e", "exec", "tsx", "src/run.ts", "--dev"] },
    ]);
  });

  it("refuses to gate the staging lane", async () => {
    const calls: RecordedCall[] = [];
    const result = await executeRemoteE2e({
      repoRoot: "/repo",
      env: {},
      runner: gitRunner({}, calls),
      options: { ...DEV_LANE_OPTIONS, staging: true },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("remote-e2e --if-changed applies to the dev lane only.");
    expect(calls).toEqual([]);
  });

  it("propagates a failing lane exit code", async () => {
    const calls: RecordedCall[] = [];
    const responses = {
      ...gitResponses("services/firebase-functions/src/index.ts\n"),
      "pnpm --dir tests/remote-e2e exec tsx src/run.ts --dev": {
        exitCode: 1,
        stderr: "remote e2e failed",
      },
    };

    const result = await executeRemoteE2e({
      repoRoot: "/repo",
      env: {},
      runner: gitRunner(responses, calls),
      options: DEV_LANE_OPTIONS,
    });

    expect(result).toEqual({
      ok: false,
      message: "remote e2e failed",
      data: {
        command: "pnpm",
        args: ["--dir", "tests/remote-e2e", "exec", "tsx", "src/run.ts", "--dev"],
        exitCode: 1,
      },
    });
  });
});
