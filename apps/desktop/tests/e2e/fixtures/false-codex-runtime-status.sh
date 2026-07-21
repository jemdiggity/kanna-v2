#!/bin/zsh -f

set -eu

phase_delay="${KANNA_FALSE_AGENT_PHASE_DELAY_SECONDS:-2}"

printf '› '
IFS= read -r _
printf '\033[2J\033[H\n\n\n\n\n\nesc to interrupt\n'
sleep "$phase_delay"
printf '\033[2J\033[H\n\n\n\n\n\ndo you want to allow\n'
sleep "$phase_delay"
printf '\033[2J\033[H\n\n\n\n\n\n› '

while :; do
  sleep 60
done
