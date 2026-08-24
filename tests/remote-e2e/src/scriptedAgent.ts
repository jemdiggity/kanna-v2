import { chmod, writeFile } from "node:fs/promises";

export interface ScriptedAgentOptions {
  redactInput?: boolean;
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

export function scriptedAgentSource(options: ScriptedAgentOptions = {}): string {
  const inputReport = options.redactInput
    ? "printf 'SCRIPT_REDACTED_INPUT\\n'"
    : "printf 'SCRIPT_INPUT:%s\\n' \"$line\"";
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
  const bracketedPasteHandling = options.tracePartialInput
    ? `if [ "$char" = "$escape" ]; then
    paste_marker=""
    marker_index=0
    while [ "$marker_index" -lt 5 ]; do
      read_char
      paste_marker="\${paste_marker}\${char}"
      marker_index=$((marker_index + 1))
    done
    if [ "$paste_marker" = "[200~" ] || [ "$paste_marker" = "[201~" ]; then
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
  const snapshotHistory = `${snapshotHistoryTrigger}
if [ "$snapshot_history_enabled" -eq 1 ]; then
  history_line=1
  while [ $history_line -le 10050 ]; do
    printf 'MOBILE_PTY_HISTORY_%05d_%s\\r\\n' "$history_line" '${"X".repeat(54)}'
    history_line=$((history_line + 1))
  done
  printf '%s\\r\\n' ${shellSingleQuote(snapshotHistorySentinel)}
fi
`;

  return `#!/bin/sh
${snapshotHistory}printf 'SCRIPT_READY\\n'

heartbeat=0
(
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
  done
) &
heartbeat_pid=$!

cleanup() {
  kill "$heartbeat_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

original_tty=$(stty -g)
stty -icanon min 1 time 0 -echo -icrnl

cleanup() {
  stty "$original_tty" 2>/dev/null || true
  kill "$heartbeat_pid" 2>/dev/null || true
}

# This deliberately mirrors the model chooser failure mode: its cursor opens
# on option 2, but typing 1 must highlight option 1 before the separately sent
# Enter submits that highlighted option.
printf 'SCRIPT_MENU_CURSOR:2\\n'
printf 'SCRIPT_INPUT_READY\\n'
line=""
menu_choice=""
carriage_return=$(printf '\\r')
escape=$(printf '\\033')

read_char() {
  # The sentinel prevents command substitution from stripping newline-only bytes.
  char=$(dd bs=1 count=1 2>/dev/null; printf '.')
  char=\${char%.}
}

while :; do
  read_char
  ${bracketedPasteHandling}
  if [ "$char" = "$carriage_return" ]; then
    if [ "$menu_choice" = "1" ]; then
      printf 'SCRIPT_MENU_SELECTED:1\\n'
      menu_choice=""
      line=""
      continue
    fi

    ${inputReport}
    case "$line" in
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
