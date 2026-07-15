import { chmod, writeFile } from "node:fs/promises";

export async function writeScriptedAgentBinary(path: string): Promise<void> {
  await writeFile(path, scriptedAgentSource());
  await chmod(path, 0o755);
}

export function scriptedAgentSource(): string {
  return `#!/bin/sh
printf 'SCRIPT_READY\\n'

heartbeat=0
(
  while :; do
    sleep 0.25
    heartbeat=$((heartbeat + 1))
    if [ $((heartbeat % 4)) -eq 0 ]; then
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
line=""
menu_choice=""
carriage_return=$(printf '\\r')

read_char() {
  # The sentinel prevents command substitution from stripping newline-only bytes.
  char=$(dd bs=1 count=1 2>/dev/null; printf '.')
  char=\${char%.}
}

while :; do
  read_char
  if [ "$char" = "$carriage_return" ]; then
    if [ "$menu_choice" = "1" ]; then
      printf 'SCRIPT_MENU_SELECTED:1\\n'
      menu_choice=""
      line=""
      continue
    fi

    printf 'SCRIPT_INPUT:%s\\n' "$line"
    case "$line" in
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
  fi
done

wait "$heartbeat_pid"
`;
}
