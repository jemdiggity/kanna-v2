export const unattendedRealE2eFiles = [
  "agent-writes-file.test.ts",
  "approval-native-control.test.ts",
  "auth-indexeddb-fallback.test.ts",
  "blocked-resume-agent-submit.test.ts",
  "cloud-task-mobile-index.test.ts",
  "cloud-task-sync.test.ts",
  "cloud-task-transfer.test.ts",
  "cloudSmokeEnv.test.ts",
  "free-model-agent-writes-file.test.ts",
  "kanna-cli-path.test.ts",
  "local-transfer-accept-import.test.ts",
  "local-transfer-agent-surfaces.test.ts",
  "local-transfer-busy-agent-wrapup.test.ts",
  "local-transfer-first-milestone.test.ts",
  "local-transfer-headless-engine.test.ts",
  "local-transfer-missing-session-state.test.ts",
  "local-transfer-opencode-continuity.test.ts",
  "local-transfer-pair-machine.test.ts",
  "local-transfer-repo-acquisition.test.ts",
  "local-transfer-source-handoff-failure.test.ts",
  "local-transfer-task-sync.test.ts",
  "mobile-pairing-ui.test.ts",
  "mobile-relay-auth-recovery.test.ts",
  "mobile-server-ksp-capabilities.test.ts",
  "native-window-theme.test.ts",
  "pty-runtime-status.test.ts",
  "pty-session.test.ts",
  "remote-visual-companion.test.ts",
  "shell-modal-prewarmed-session.test.ts",
  "stage-continue-agent-submit.test.ts",
  "stage-workflow.test.ts",
  "startup-window-size.test.ts",
  "task-base-branch.test.ts",
  "terminal-soft-newline.test.ts",
] as const;

export const operatorRealE2eFiles = [
  "cloud-prod-smoke.test.ts",
  "cloud-relay-desktop-auth.test.ts",
  "local-transfer-claude-transcript.test.ts",
  "sdk-lifecycle-codex.test.ts",
  "stage-advance-sdk-codex.test.ts",
  "themed-claude-session.test.ts",
] as const;

export function realE2eTierFiles(tier: "unattended" | "operator"): readonly string[] {
  return tier === "unattended" ? unattendedRealE2eFiles : operatorRealE2eFiles;
}
