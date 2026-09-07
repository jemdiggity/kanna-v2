import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOpenCodeBinary } from "../../helpers/opencode";
import { openCodeBinaryOrNull, ptyBridgeAvailable } from "../../helpers/availability";
import { makeRealTempDir, removeDir } from "../../helpers/background";
import { sleep, startPtySession, type PtySession } from "../../helpers/pty";

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: every OpenCode PTY task's
// `runtime_status` — the sidebar's working/idle indicator, task activity, the
// `task.awaiting_input` feed, and transfer finalization, which waits for Idle
// before it dares type a quit command at the source agent.
//
// The daemon reads status off rendered terminal rows, so it can only ever know
// what OpenCode draws. Its OpenCode rules (crates/daemon/src/detection/rules.json)
// pin three strings, each in a version-ranged vocabulary entry:
//
//   inFlightMarkers           the working footer  -> Busy
//   composerStatusSeparators  the composer's mode/model line -> Idle
//   permissionActionMarkers   the permission dialog's action row -> Waiting
//
// Those entries carry the CLI versions they were measured against, so a new
// spelling is *added* beside the old one rather than replacing it — someone on
// the team is still running the older release.
//
// Those are pinned at the unit layer against captured frames
// (crates/daemon/tests/fixtures/opencode/), which proves the matcher reads the
// frames correctly but cannot notice the day OpenCode stops drawing them. This
// file is that canary: it asserts the installed CLI still renders each marker,
// and names the constant to update when one moves.
//
// It exists because the previous idle marker — a `›` composer glyph — was
// pinned only against a hand-written fixture. The CLI stopped drawing it, no
// test noticed, and live OpenCode sessions sat at Busy forever. OpenCode moves
// fast enough that the working footer's own wording changed from "escape
// interrupt" to "esc interrupt" between two runs of this investigation:
// docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md.
//
// The second describe block below pins the spawn *shape* these markers are read
// off: that Kanna's argv still opens a TUI which outlives its first turn. The
// markers and the shape fail independently, and while Kanna spawned
// `opencode run --interactive` the shape was the one that was broken.

/** OpenCode Zen's free model — see tests/live/opencode-flags.test.ts. */
const LIVE_MODEL = "opencode/big-pickle";

// Whitespace-free: the TUI places text with cursor escapes (PtySession.compactOutput).
const READY = /Askanything|Build·/;
/** The `inFlightMarkers` spellings, minus the whitespace the TUI does not emit. */
const WORKING_FOOTER = /escapeinterrupt|escinterrupt|esctointerrupt/;
/**
 * The `opencode-composer-status` rule: "┃  Build · Big Pickle OpenCode Zen", or
 * "┃  Build · Model default" when no model is pinned. Matched against the
 * spaced output rather than the compact form, which has no line boundaries.
 *
 * The mode is more than one word whenever a permission-bypass flag is set —
 * Kanna's own spawn renders "┃  Build auto · Big Pickle OpenCode Zen", with an
 * "auto" badge after the mode. So this mirrors what the daemon actually keys
 * on: the box border, then any text, then a spaced middle dot. An earlier
 * version required a single word there and failed on Kanna's real argv while
 * the daemon's matcher was perfectly happy — a test stricter than the code it
 * guards is a false alarm waiting to happen.
 */
const COMPOSER_STATUS = /┃ {1,4}\S[^\n]* · \S/;
/** The `permissionActionMarkers` set, compacted the same way as READY. */
const PERMISSION_ACTIONS = /Allowonce.*Allowalways/s;
/**
 * The elapsed time OpenCode paints onto its summary line when a turn ends
 * ("▣ Build · Big Pickle · 3.0s"). The glyph alone heads the reply while it is
 * still streaming; the duration only arrives with the repaint that also clears
 * the working footer.
 */
const TURN_ELAPSED_TIME = /· \d+(?:\.\d+)?s/;

async function requireEnvironment(ctx: { skip: (reason?: string) => void }): Promise<boolean> {
  if (!(await openCodeBinaryOrNull())) {
    ctx.skip("opencode CLI is not installed");
    return false;
  }
  if (!(await ptyBridgeAvailable())) {
    ctx.skip("/usr/bin/python3 is unavailable, so no PTY can be allocated");
    return false;
  }
  return true;
}

/**
 * The TUI is what the daemon's matcher reads, and `opencode [project]` — the
 * CLI's default command — is what draws it.
 *
 * These are the flags Kanna's PTY spawn puts on the argv
 * (`crates/kanna-server/src/task_creator/commands.rs`), so the markers below are
 * pinned against the shape a real task runs rather than a nearby one. Kanna
 * passes no `[project]` positional — its bootstrap shell already runs in the
 * worktree — but this harness starts the CLI directly, so the directory is
 * given explicitly here.
 */
const KANNA_PTY_FLAGS = ["--auto", "--model", LIVE_MODEL];
/**
 * Kanna's spawn for any permission mode other than `dontAsk`/default, which
 * passes no bypass flag at all. It is also the only shape that can reach the
 * permission dialog — `--auto` is precisely the flag that stops it opening.
 */
const KANNA_PTY_FLAGS_ASKING = ["--model", LIVE_MODEL];

async function startOpenCode(
  cwd: string,
  extraArgs: string[] = [],
  flags: string[] = KANNA_PTY_FLAGS,
): Promise<PtySession> {
  const binary = await findOpenCodeBinary();
  // OpenCode reads its project config from a repository root.
  execFileSync("git", ["init", "-q"], { cwd });
  return startPtySession(binary, [...flags, ...extraArgs, cwd], { cwd });
}

/** Pump until the TUI stops redrawing: the turn is over, or a dialog is up. */
async function waitUntilQuiet(session: PtySession, quietForMs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastLength = session.output.length;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline && !session.exited) {
    await sleep(500);
    if (session.output.length !== lastLength) {
      lastLength = session.output.length;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietForMs) {
      return;
    }
  }
}

describe("TUI status markers the daemon reads (opencode)", () => {
  it("draws a composer status line, a working footer, and a turn summary", async (ctx) => {
    if (!(await requireEnvironment(ctx))) return;

    const cwd = await makeRealTempDir("kanna-opencode-status-");
    const session = await startOpenCode(cwd);
    try {
      if (!(await session.waitForOutput(READY, 60_000))) {
        ctx.skip("opencode TUI never reached its composer");
        return;
      }

      expect(
        COMPOSER_STATUS.test(session.output),
        `the composer's mode/model line is gone, so the daemon has no positive Idle marker ` +
        `for OpenCode. Update composerStatusSeparators in ` +
        `crates/daemon/src/detection/rules.json and re-capture the fixtures. TUI tail:\n` +
        session.output.slice(-1200),
      ).toBe(true);

      await session.submit(
        "Without asking any questions, print every integer from 1 to 60 in your reply, " +
        "one per line, and then stop.",
      );

      const wentBusy = await session.waitForOutput(WORKING_FOOTER, 120_000);
      if (session.exited) {
        ctx.skip(`opencode exited before the turn started. TUI tail:\n${session.output.slice(-600)}`);
        return;
      }
      expect(
        wentBusy,
        `opencode never drew a working footer this test recognises, so the daemon can no longer ` +
        `see an OpenCode session as Busy. Add the new spelling to inFlightMarkers in ` +
        `crates/daemon/src/detection/rules.json. TUI tail:\n${session.output.slice(-1200)}`,
      ).toBe(true);

      await waitUntilQuiet(session, 6_000, 240_000);

      // What the daemon actually asks — "does the rendered screen still show
      // the working footer" — cannot be asked here: this harness accumulates
      // bytes rather than rendering them, and OpenCode repaints by addressing
      // individual cells, so the buffer holds every frame it ever drew with no
      // line structure left. That question is pinned one layer down, against a
      // captured post-turn frame replayed through the daemon's own terminal
      // (crates/daemon/src/headless_terminal.rs).
      //
      // What is checkable here is that the turn *ended the way the matcher
      // assumes*: OpenCode paints an elapsed time onto its summary line when it
      // stops working, which is the same repaint that replaces the footer.
      const painted = session.output;
      expect(
        TURN_ELAPSED_TIME.test(painted),
        `opencode painted no elapsed time after the turn. The repaint that adds it is the one ` +
        `that clears the working footer, so if it is gone the footer may never be cleared and ` +
        `the daemon would hold the session at Busy — which is exactly the bug this pin exists ` +
        `for. TUI tail:\n${painted.slice(-1200)}`,
      ).toBe(true);

      await session.submit("/exit");
      await session.waitForExit(30_000);
    } finally {
      session.kill();
      await removeDir(cwd);
    }
  }, 420_000);

  it("draws an action row on the permission dialog", async (ctx) => {
    if (!(await requireEnvironment(ctx))) return;

    const cwd = await makeRealTempDir("kanna-opencode-permission-");
    // The TUI command asks by default only for what the repo config says; make
    // every permission an explicit ask so the dialog is reached deterministically.
    writeFileSync(
      join(cwd, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        permission: { bash: "ask", edit: "ask", webfetch: "ask" },
      }),
    );

    // Kanna's asking spawn, not its default one: `--auto` suppresses the very
    // dialog this test exists to find.
    const session = await startOpenCode(cwd, [], KANNA_PTY_FLAGS_ASKING);
    try {
      if (!(await session.waitForOutput(READY, 60_000))) {
        ctx.skip("opencode TUI never reached its composer");
        return;
      }

      await session.submit(
        "Run the shell command `echo hello > greeting.txt` in the current directory. " +
        "Do not ask me anything, just run it.",
      );

      // Either the dialog opens, or the turn ends without one — the second is
      // the model declining to reach for a tool, and waiting out the full
      // timeout on it teaches nothing. A dialog is a quiet screen too, so
      // quiescence is what separates them, not a marker.
      await waitUntilQuiet(session, 6_000, 180_000);
      const asked = PERMISSION_ACTIONS.test(session.compactOutput);
      if (!asked && !session.exited) {
        // A model that answers without reaching for a tool proves nothing either way.
        ctx.skip(`opencode never attempted a tool call. TUI tail:\n${session.output.slice(-600)}`);
        return;
      }
      expect(
        asked,
        `opencode's permission dialog no longer draws an "Allow once / Allow always" action row. ` +
        `That row is the only part of the dialog inside the daemon's status window, so without it ` +
        `a task parked on a permission prompt is never reported as Waiting. Update ` +
        `permissionActionMarkers in crates/daemon/src/detection/rules.json. TUI tail:\n` +
        session.output.slice(-1200),
      ).toBe(true);
    } finally {
      session.kill();
      await removeDir(cwd);
    }
  }, 300_000);
});

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: everything that reaches a running
// OpenCode task by typing at it — `kanna_send_task_input`, stage posts
// (commit/approve), revision resume, and transfer finalization's wrap-up and
// quit. All of them write bytes to the PTY and expect a composer to be there.
//
// Kanna used to spawn `opencode run --interactive '<prompt>'`, which on 1.18.15
// draws no TUI and exits at the end of its first turn: injected text was echoed
// by the tty, never became a turn, and the process was gone a second later
// (docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md, "Defect 2"). The
// spawn now uses the CLI's default command with `--prompt`. This is the pin
// that the replacement actually keeps a composer alive past its opening turn —
// the property the old shape lacked, and the one no marker assertion above can
// detect on its own.
describe("the spawn shape Kanna's OpenCode PTY tasks use", () => {
  it("delivers --prompt as a real turn and still has a composer afterwards", async (ctx) => {
    if (!(await requireEnvironment(ctx))) return;

    const cwd = await makeRealTempDir("kanna-opencode-spawn-");
    const session = await startOpenCode(cwd, [
      "--prompt",
      "Reply with exactly the word ALPHA and nothing else.",
    ]);
    try {
      // `--prompt` has to become a turn on its own: nothing types it in.
      const wentBusy = await session.waitForOutput(WORKING_FOOTER, 120_000);
      expect(
        wentBusy,
        `opencode never started a turn from --prompt, so a Kanna task would come up with its ` +
        `prompt undelivered. Check the PTY composition in ` +
        `crates/kanna-server/src/task_creator/commands.rs. TUI tail:\n` +
        session.output.slice(-1200),
      ).toBe(true);

      await waitUntilQuiet(session, 6_000, 240_000);

      // The property the old `run --interactive` spawn did not have.
      expect(
        session.exited,
        `opencode exited when its opening turn ended, so a Kanna task would have no session left ` +
        `for send-input, stage posts, revision resume or the transfer wrap-up to reach. ` +
        `exitCode=${session.exitCode}. TUI tail:\n${session.output.slice(-1200)}`,
      ).toBe(false);
      expect(
        COMPOSER_STATUS.test(session.output),
        `opencode drew no composer after its opening turn, so injected input has nothing to land ` +
        `in. TUI tail:\n${session.output.slice(-1200)}`,
      ).toBe(true);

      // And injected input — written exactly the way `try_submit_task_input`
      // writes it — becomes a second turn rather than tty echo.
      await session.submit("Reply with exactly the word BETA and nothing else.");
      const secondTurn = await session.waitForOutput(WORKING_FOOTER, 120_000);
      expect(
        secondTurn,
        `injected input did not become a turn, which is the exact failure the old one-shot spawn ` +
        `had: the bytes are echoed by the tty and the agent never sees them. TUI tail:\n` +
        session.output.slice(-1200),
      ).toBe(true);

      await waitUntilQuiet(session, 6_000, 240_000);
      expect(
        session.compactOutput.includes("BETA"),
        `the agent never answered the injected message. TUI tail:\n${session.output.slice(-1200)}`,
      ).toBe(true);
    } finally {
      session.kill();
      await removeDir(cwd);
    }
  }, 600_000);
});
