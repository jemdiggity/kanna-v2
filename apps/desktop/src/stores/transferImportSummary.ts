/**
 * Display-only provenance for a task that arrived by cross-machine transfer.
 * The server prints it into the destination PTY once, before the agent starts,
 * so an imported task announces where it came from instead of just appearing.
 *
 * The source PTY is deliberately never written to: it holds a live agent TUI,
 * and the transcript it ships is what the destination resumes from.
 *
 * Built server-side, by the transfer engine's import step — this is the shape
 * the renderer reads off the task, not something it assembles. The renderer used
 * to compose it (resolving the peer's display name out of the sidecar registry
 * itself), which only worked while a window was the thing performing imports.
 */
export interface TransferImportSummary {
  sourceMachine: string | null;
  repoMode: string | null;
  sessionRestored: boolean;
}
