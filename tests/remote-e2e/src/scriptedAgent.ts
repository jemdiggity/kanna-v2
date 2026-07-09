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

while IFS= read -r line; do
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
done

wait "$heartbeat_pid"
`;
}
