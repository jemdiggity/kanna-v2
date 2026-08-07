import { describe, expect, it } from "vitest";
import { runCodexRaw } from "../../helpers/codex";
import { codexBinaryOrNull } from "../../helpers/availability";
import { getAgentPermissionFlags } from "../../../../apps/desktop/src/stores/agent-permissions";

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: the codex spawn dies on a usage
// error before the agent ever starts, in whichever mode lost its flag.
//
// This gap is why the suite missed a real break: `--full-auto` was removed from
// the interactive codex CLI while `codex exec` kept a deprecation trap for it,
// so every codex pin — all of which drive `codex exec` — stayed green while an
// `acceptEdits` codex task exited 2 with "unexpected argument '--full-auto'".
// Nothing pinned the *interactive* argv, which is what a PTY task runs.
//
// Acceptance is probed with `--help`: codex validates the preceding arguments
// before printing it, so an unknown flag exits 2 with "unexpected argument"
// instead of running a turn. That keeps this pin free of credits and of the
// account state that decides whether the other codex pins can run at all.

const PERMISSION_MODES = [undefined, "default", "dontAsk", "acceptEdits"] as const;

// The exec/SDK half is composed by CodexAdapter::base_args in
// crates/kanna-agent-protocol/src/codex.rs, which does not share the flag
// helper above: bypassing modes get the bypass flag, and anything else gets no
// sandbox flag at all.
const EXEC_SPAWNS: Array<{ label: string; args: string[] }> = [
  {
    label: "initial spawn, bypassing modes",
    args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json"],
  },
  {
    label: "initial spawn with model and reasoning effort",
    args: [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5.2-codex",
      "-c",
      'model_reasoning_effort="high"',
      "--json",
    ],
  },
  {
    label: "resume spawn",
    args: [
      "exec",
      "resume",
      "00000000-0000-0000-0000-000000000000",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
    ],
  },
];

async function expectAccepted(args: string[]): Promise<void> {
  const result = await runCodexRaw([...args, "--help"]);
  expect(
    `${result.stderr}\n${result.stdout}`,
    `codex rejected \`codex ${args.join(" ")}\``,
  ).not.toContain("unexpected argument");
  expect(result.exitCode, `codex ${args.join(" ")} --help exited ${result.exitCode}`).toBe(0);
}

describe("codex accepts the argv kanna composes", () => {
  for (const mode of PERMISSION_MODES) {
    it(`interactive spawn, permission mode ${mode ?? "unset"}`, async (ctx) => {
      if (!(await codexBinaryOrNull())) {
        ctx.skip("codex CLI is not installed");
        return;
      }
      // The PTY path builds a shell command string, so a single entry can hold
      // a flag and its value ("--sandbox workspace-write"); split back to argv.
      const flags = getAgentPermissionFlags("codex", mode).flatMap((flag) => flag.split(" "));
      await expectAccepted(flags);
    }, 60_000);

    it(`interactive resume spawn, permission mode ${mode ?? "unset"}`, async (ctx) => {
      if (!(await codexBinaryOrNull())) {
        ctx.skip("codex CLI is not installed");
        return;
      }
      const flags = getAgentPermissionFlags("codex", mode).flatMap((flag) => flag.split(" "));
      // task_creator/commands.rs: `{executable} {flags} resume '{id}' '{prompt}'`.
      await expectAccepted([...flags, "resume", "00000000-0000-0000-0000-000000000000"]);
    }, 60_000);
  }

  for (const spawn of EXEC_SPAWNS) {
    it(`codex exec ${spawn.label}`, async (ctx) => {
      if (!(await codexBinaryOrNull())) {
        ctx.skip("codex CLI is not installed");
        return;
      }
      await expectAccepted(spawn.args);
    }, 60_000);
  }
});
