import { chmod, writeFile } from "node:fs/promises";

export interface ScriptedAgentOptions {
  continuousOutput?: boolean;
  inputTraceFile?: string;
  redactInput?: boolean;
  terminalPasteSemantics?: boolean;
  tracePartialInput?: boolean;
  snapshotHistory?: {
    sentinel: string;
  };
}

export const SCRIPTED_AGENT_SNAPSHOT_HISTORY_SENTINEL =
  "MOBILE_PTY_SNAPSHOT_SENTINEL";

export async function writeScriptedAgentBinary(
  path: string,
  options: ScriptedAgentOptions = {},
): Promise<void> {
  await writeFile(path, scriptedAgentSource(options));
  await chmod(path, 0o755);
}

export async function writeScriptedClaudeStatusAgentBinary(path: string): Promise<void> {
  await writeFile(path, scriptedClaudeStatusAgentSource());
  await chmod(path, 0o755);
}

/**
 * A long-lived PTY fixture that paints the measured Claude 2.1.259 status
 * shapes. Every submitted line produces a stable busy frame followed by the
 * idle composer with its divider and mode bar, so daemon handoff tests can
 * exercise classification without spending an Anthropic turn.
 *
 * Two sentinel inputs reach the remaining daemon runtime verdicts without a
 * turn: `ask-permission` paints the permission prompt the classifier matches
 * on (`do you want to allow`) and parks there, and `quit-now` ends the
 * session so the server records `exited`.
 */
export function scriptedClaudeStatusAgentSource(): string {
  return `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '2.1.259 (Claude Code)\\n'
  exit 0
fi

original_tty=$(stty -g)
stty -echo
cleanup() {
  stty "$original_tty" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

paint_busy() {
  printf '\\033[2J\\033[HClaude Code\\r\\n'
  printf 'SCRIPT_CLAUDE_BUSY\\r\\n'
  printf '✻ Working (1s · esc to interrupt)\\r\\n'
  printf '⏵⏵ bypass permissions on (shift+tab to cycle)\\r\\n'
}

paint_idle() {
  printf '\\033[2J\\033[HClaude Code\\r\\n'
  printf 'SCRIPT_CLAUDE_IDLE\\r\\n'
  printf '✻ Churned for 1s · done 12:46 AM\\r\\n'
  printf '────────────────────────────────────────────────────────────────────────────────\\r\\n'
  printf '❯ \\r\\n'
  printf '────────────────────────────────────────────────────────────────────────────────\\r\\n'
  printf '⏵⏵ bypass permissions on (shift+tab to cycle)\\r\\n'
}

paint_waiting() {
  printf '\\033[2J\\033[HClaude Code\\r\\n'
  printf 'SCRIPT_CLAUDE_WAITING\\r\\n'
  printf 'Do you want to allow this command?\\r\\n'
  printf '  1. Yes\\r\\n'
  printf '  2. No, tell Claude what to do differently\\r\\n'
}

paint_idle
while IFS= read -r line; do
  case "$line" in
    *ask-permission*)
      paint_waiting
      continue
      ;;
    *quit-now*)
      exit 0
      ;;
  esac
  paint_busy
  # Long enough for the server watcher to reconnect and observe Busy after a
  # daemon handoff before the composer is repainted.
  sleep 3
  paint_idle
done
`;
}

export function scriptedAgentSource(options: ScriptedAgentOptions = {}): string {
  const continuousOutput = options.continuousOutput !== false;
  const inputTrace = options.inputTraceFile
    ? `printf '%s\\000' "$line" >> ${shellSingleQuote(options.inputTraceFile)}`
    : ":";
  // Avoid CSI bytes here: the file-mention scanner intentionally ignores
  // control-bearing lines. Fill one row without reaching its wrap cell, then
  // return to column zero so the asserted input bytes overwrite a clean row.
  const inputLineReset = options.snapshotHistory
    ? `\\r${" ".repeat(131)}\\r`
    : "";
  const inputReport = options.redactInput
    ? "printf 'SCRIPT_REDACTED_INPUT\\n'"
    : `${inputTrace}
    printf '${inputLineReset}SCRIPT_INPUT:%s\\n' "$line"`;
  const snapshotHistorySentinel =
    options.snapshotHistory?.sentinel ?? SCRIPTED_AGENT_SNAPSHOT_HISTORY_SENTINEL;
  const snapshotHistoryTrigger = options.snapshotHistory
    ? "snapshot_history_enabled=1"
    : `snapshot_history_enabled=0
case "$*" in
  *${SCRIPTED_AGENT_SNAPSHOT_HISTORY_SENTINEL}*) snapshot_history_enabled=1 ;;
esac`;
  const partialInputTrace = options.tracePartialInput
    ? "printf 'SCRIPT_PARTIAL:%s\\n' \"$line\""
    : ":";
  const bracketedPasteHandling = options.tracePartialInput || options.terminalPasteSemantics
    ? `if [ "$char" = "$escape" ]; then
    paste_marker=""
    marker_index=0
    while [ "$marker_index" -lt 5 ]; do
      read_char
      paste_marker="\${paste_marker}\${char}"
      marker_index=$((marker_index + 1))
    done
    if [ "$paste_marker" = "[200~" ]; then
      paste_active=1
      continue
    fi
    if [ "$paste_marker" = "[201~" ]; then
      paste_active=0
      continue
    fi
    if [ "$paste_marker" = "[<65;" ]; then
      mouse_suffix=""
      suffix_index=0
      while [ "$suffix_index" -lt 4 ]; do
        read_char
        mouse_suffix="\${mouse_suffix}\${char}"
        suffix_index=$((suffix_index + 1))
      done
      if [ "$mouse_suffix" = "1;1M" ]; then
        printf 'SCRIPT_CONTROL:scroll\\n'
        continue
      fi
      paste_marker="\${paste_marker}\${mouse_suffix}"
    fi
    line="\${line}\${escape}\${paste_marker}"
    ${partialInputTrace}
    continue
  fi`
    : "";
  const submissionCondition = options.terminalPasteSemantics
    ? `if [ "$char" = "$carriage_return" ] || { [ "$char" = "$line_feed" ] && [ "$paste_active" -eq 0 ]; }; then`
    : `if [ "$char" = "$carriage_return" ]; then`;
  const terminalModePrelude = options.terminalPasteSemantics
    ? "printf '\\033[?2004h'"
    : ":";
  const snapshotHistory = `${snapshotHistoryTrigger}
if [ "$snapshot_history_enabled" -eq 1 ]; then
  history_line=1
  while [ $history_line -le 200 ]; do
    # 125 columns: one row in the relay fixture's authoritative 132-column
    # grid, but two rows (including an orphan X fragment) if mobile parses the
    # snapshot at its 80-column proposal width.
    printf 'MOBILE_PTY_HISTORY_%05d_%s\\r\\n' "$history_line" '${"X".repeat(100)}'
    history_line=$((history_line + 1))
  done
  printf '%s\\r\\n' ${shellSingleQuote(snapshotHistorySentinel)}
fi
`;

  const heartbeatLoop = continuousOutput
    ? `(
  while :; do
    sleep 0.25
    heartbeat=$((heartbeat + 1))
    if [ $((heartbeat % 4)) -eq 0 ]; then
      if [ "$snapshot_history_enabled" -eq 1 ]; then
        printf '%s\\n' ${shellSingleQuote(snapshotHistorySentinel)}
      fi
      printf 'SCRIPT_READY\\n'
    fi
    printf 'SCRIPT_HEARTBEAT %s\\n' "$heartbeat"
    printf '\\033[3;1HRELAY_GRID_CELL'
    printf '\\033[4;1H'
  done
) &
heartbeat_pid=$!`
    : "heartbeat_pid=";

  return `#!/bin/sh
${snapshotHistory}${terminalModePrelude}
printf 'SCRIPT_READY\\n'

# Keep one cell and the cursor at deterministic viewport coordinates so real
# rendered-grid tests can distinguish source-grid hydration from arbitrary
# in-bounds cursor state. ANSI coordinates are one-based: the marker is at
# row 3/column 1 and the cursor rests at row 4/column 1.
printf '\\033[3;1HRELAY_GRID_CELL'
printf '\\033[4;1H'

heartbeat=0
${heartbeatLoop}

cleanup() {
  if [ -n "$heartbeat_pid" ]; then kill "$heartbeat_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

original_tty=$(stty -g)
stty -icanon min 1 time 0 -echo -icrnl

cleanup() {
  stty "$original_tty" 2>/dev/null || true
  if [ -n "$heartbeat_pid" ]; then kill "$heartbeat_pid" 2>/dev/null || true; fi
}

# This deliberately mirrors the model chooser failure mode: its cursor opens
# on option 2, but typing 1 must highlight option 1 before the separately sent
# Enter submits that highlighted option.
printf 'SCRIPT_MENU_CURSOR:2\\n'
printf 'SCRIPT_INPUT_READY\\n'
line=""
menu_choice=""
carriage_return=$(printf '\\r')
line_feed=$(printf '\\n.')
line_feed=\${line_feed%.}
escape=$(printf '\\033')
paste_active=0

read_char() {
  # The sentinel prevents command substitution from stripping newline-only bytes.
  char=$(dd bs=1 count=1 2>/dev/null; printf '.')
  char=\${char%.}
}

while :; do
  read_char
  ${bracketedPasteHandling}

  ${submissionCondition}
    if [ "$menu_choice" = "1" ]; then
      printf 'SCRIPT_MENU_SELECTED:1\\n'
      menu_choice=""
      line=""
      continue
    fi

    ${inputReport}
    case "$line" in
      *relay-fixture-idle*)
        printf 'OpenAI Codex\\r\\nDone.\\r\\n› \\r\\n'
        ;;
      *reconnect-fixture-start*)
        kill "$heartbeat_pid" 2>/dev/null || true
        heartbeat_pid=""
        printf '\\033[2J\\033[HRECONNECT_REFERENCE_HEADER\\r\\n'
        printf 'stable row before hostile cuts\\r\\n'
        ;;
      *reconnect-cut-ansi*)
        printf '\\033['
        sleep 0.35
        printf '31mANSI_RED_SAFE\\033[0m\\r\\n'
        ;;
      *reconnect-cut-utf8*)
        printf '\\346'
        sleep 0.35
        printf '\\274\\242_UTF8_SAFE\\r\\n'
        ;;
      *reconnect-cut-sync*)
        printf '\\033[?2026'
        sleep 0.35
        printf 'h\\033[4;1HSYNC_FRAME_SAFE\\033[?2026l\\r\\n'
        ;;
      *reconnect-overflow*)
        reconnect_line=1
        while [ $reconnect_line -le 5000 ]; do
          printf 'RECONNECT_OVERFLOW_%04d_%s\\r\\n' "$reconnect_line" '${"Y".repeat(128)}'
          reconnect_line=$((reconnect_line + 1))
        done
        printf 'RECONNECT_OVERFLOW_DONE\\r\\n'
        ;;
      *burst-output*)
        burst_line=1
        while [ $burst_line -le 2000 ]; do
          printf 'SCRIPT_BURST_%04d_%s\n' "$burst_line" '${"X".repeat(128)}'
          burst_line=$((burst_line + 1))
        done
        printf 'SCRIPT_BURST_DONE\n'
        ;;
      *exit-zero*)
        printf 'SCRIPT_EXITING\\n'
        exit 0
        ;;
      *exit-one*)
        printf 'SCRIPT_FAILING\\n'
        exit 7
        ;;
    esac
    line=""
  elif [ -z "$line" ] && [ "$char" = "1" ]; then
    menu_choice="1"
    printf 'SCRIPT_MENU_OPTION_1_HIGHLIGHTED\\n'
  else
    line="\${line}\${char}"
    ${partialInputTrace}
  fi
done

wait "$heartbeat_pid"
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
