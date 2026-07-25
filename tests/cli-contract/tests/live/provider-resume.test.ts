import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  listAntigravityConversationIds,
  runAntigravityPrint,
} from "../../helpers/antigravity";
import { isClaudeUnavailable, runClaude } from "../../helpers/claude";
import { runCodexExec, runCodexPtyResume } from "../../helpers/codex";
import { runCopilot } from "../../helpers/copilot";
import {
  isOpenCodeProviderAuthenticated,
  runOpenCodeJson,
} from "../../helpers/opencode";
import {
  createResumeNonce,
  extractCodexThreadId,
  extractOpenCodeSessionId,
  providerUnavailableReason,
  recallPrompt,
  rememberPrompt,
  selectNewConversationId,
} from "../../helpers/provider-resume";

function diagnostic(provider: string, stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.trim().slice(-2_000);
  return `${provider} live resume output:\n${output}`;
}

describe("live provider conversation resume", () => {
  it("Claude resumes a separately launched conversation by session ID", async ({ skip }) => {
    const nonce = createResumeNonce("claude");
    const sessionId = randomUUID();

    let first;
    try {
      first = await runClaude({
        prompt: rememberPrompt(nonce),
        flags: ["--session-id", sessionId, "--permission-mode", "dontAsk"],
        timeoutMs: 120_000,
      });
    } catch (error) {
      const reason = providerUnavailableReason(String(error));
      if (reason) skip(reason);
      throw error;
    }
    if (isClaudeUnavailable(first)) skip("Claude authentication unavailable");
    expect(
      first.exitCode,
      diagnostic("Claude initial turn", first.stdout, first.stderr),
    ).toBe(0);

    const resumed = await runClaude({
      prompt: recallPrompt(),
      flags: ["--resume", sessionId, "--permission-mode", "dontAsk"],
      timeoutMs: 120_000,
    });
    if (isClaudeUnavailable(resumed)) skip("Claude authentication unavailable");
    expect(
      resumed.exitCode,
      diagnostic("Claude resumed turn", resumed.stdout, resumed.stderr),
    ).toBe(0);
    expect(
      resumed.stdout,
      diagnostic("Claude resumed turn", resumed.stdout, resumed.stderr),
    ).toContain(nonce);
  }, 240_000);

  it("Copilot resumes a separately launched conversation by session ID", async ({ skip }) => {
    const nonce = createResumeNonce("copilot");
    const sessionId = randomUUID();

    let first;
    try {
      first = await runCopilot({
        prompt: rememberPrompt(nonce),
        flags: [`--session-id=${sessionId}`],
        timeoutMs: 120_000,
      });
    } catch (error) {
      const reason = providerUnavailableReason(String(error));
      if (reason) skip(reason);
      throw error;
    }
    const firstUnavailable = providerUnavailableReason(`${first.stdout}\n${first.stderr}`);
    if (firstUnavailable) skip(firstUnavailable);
    expect(
      first.exitCode,
      diagnostic("Copilot initial turn", first.stdout, first.stderr),
    ).toBe(0);

    const resumed = await runCopilot({
      prompt: recallPrompt(),
      flags: [`--resume=${sessionId}`],
      timeoutMs: 120_000,
    });
    const resumedUnavailable = providerUnavailableReason(
      `${resumed.stdout}\n${resumed.stderr}`,
    );
    if (resumedUnavailable) skip(resumedUnavailable);
    expect(
      resumed.exitCode,
      diagnostic("Copilot resumed turn", resumed.stdout, resumed.stderr),
    ).toBe(0);
    expect(
      resumed.stdout,
      diagnostic("Copilot resumed turn", resumed.stdout, resumed.stderr),
    ).toContain(nonce);
  }, 240_000);

  it("Codex production PTY command resumes a separately launched conversation", async ({
    skip,
  }) => {
    if (process.platform !== "darwin") {
      skip(
        "Codex production PTY resume contract requires the macOS script utility",
      );
    }
    const nonce = createResumeNonce("codex");

    let first;
    try {
      first = await runCodexExec({
        prompt: rememberPrompt(nonce),
        timeoutMs: 120_000,
      });
    } catch (error) {
      const reason = providerUnavailableReason(String(error));
      if (reason) skip(reason);
      throw error;
    }
    const firstUnavailable = providerUnavailableReason(`${first.stdout}\n${first.stderr}`);
    if (firstUnavailable) skip(firstUnavailable);
    expect(
      first.exitCode,
      diagnostic("Codex initial turn", first.stdout, first.stderr),
    ).toBe(0);
    const sessionId = extractCodexThreadId(first.lines);

    const resumed = await runCodexPtyResume({
      sessionId,
      prompt: recallPrompt(),
      waitFor: nonce,
      flags: ["--yolo"],
      timeoutMs: 120_000,
    });
    const resumedUnavailable = providerUnavailableReason(
      `${resumed.stdout}\n${resumed.stderr}`,
    );
    if (resumedUnavailable) skip(resumedUnavailable);
    // The interactive TUI remains open after the turn, so the harness closes
    // its PTY once the recalled nonce is observed; its signal exit is expected.
    expect(
      resumed.matched,
      diagnostic("Codex resumed turn", resumed.stdout, resumed.stderr),
    ).toBe(true);
    expect(
      resumed.stdout,
      diagnostic("Codex resumed turn", resumed.stdout, resumed.stderr),
    ).toContain(nonce);
  }, 240_000);

  it("OpenCode resumes a separately launched conversation by session ID", async ({ skip }) => {
    const nonce = createResumeNonce("opencode");

    if (!(await isOpenCodeProviderAuthenticated())) {
      skip("OpenCode provider is not authenticated");
    }

    let first;
    try {
      first = await runOpenCodeJson({
        prompt: rememberPrompt(nonce),
        timeoutMs: 120_000,
      });
    } catch (error) {
      const reason = providerUnavailableReason(String(error));
      if (reason) skip(reason);
      throw error;
    }
    const firstUnavailable = providerUnavailableReason(`${first.stdout}\n${first.stderr}`);
    if (firstUnavailable) skip(firstUnavailable);
    expect(
      first.exitCode,
      diagnostic("OpenCode initial turn", first.stdout, first.stderr),
    ).toBe(0);
    const sessionId = extractOpenCodeSessionId(first.lines);

    const resumed = await runOpenCodeJson({
      prompt: recallPrompt(),
      flags: ["--session", sessionId],
      timeoutMs: 120_000,
    });
    const resumedUnavailable = providerUnavailableReason(
      `${resumed.stdout}\n${resumed.stderr}`,
    );
    if (resumedUnavailable) skip(resumedUnavailable);
    expect(
      resumed.exitCode,
      diagnostic("OpenCode resumed turn", resumed.stdout, resumed.stderr),
    ).toBe(0);
    expect(
      resumed.stdout,
      diagnostic("OpenCode resumed turn", resumed.stdout, resumed.stderr),
    ).toContain(nonce);
  }, 240_000);

  it("Antigravity resumes a separately launched conversation by conversation ID", async ({ skip }) => {
    const nonce = createResumeNonce("antigravity");
    const before = await listAntigravityConversationIds();

    let first;
    try {
      first = await runAntigravityPrint(rememberPrompt(nonce));
    } catch (error) {
      const reason = providerUnavailableReason(String(error));
      if (reason) skip(reason);
      throw error;
    }
    const firstUnavailable = providerUnavailableReason(`${first.stdout}\n${first.stderr}`);
    if (firstUnavailable) skip(firstUnavailable);
    expect(
      first.exitCode,
      diagnostic("Antigravity initial turn", first.stdout, first.stderr),
    ).toBe(0);

    const after = await listAntigravityConversationIds();
    const sessionId = selectNewConversationId(before, after);
    const resumed = await runAntigravityPrint(recallPrompt(), {
      conversationId: sessionId,
    });
    const resumedUnavailable = providerUnavailableReason(
      `${resumed.stdout}\n${resumed.stderr}`,
    );
    if (resumedUnavailable) skip(resumedUnavailable);
    expect(
      resumed.exitCode,
      diagnostic("Antigravity resumed turn", resumed.stdout, resumed.stderr),
    ).toBe(0);
    expect(
      resumed.stdout,
      diagnostic("Antigravity resumed turn", resumed.stdout, resumed.stderr),
    ).toContain(nonce);
  }, 320_000);
});
