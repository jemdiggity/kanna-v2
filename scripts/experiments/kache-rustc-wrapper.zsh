#!/bin/zsh

set -u

if (( $# == 0 )); then
  print -u2 -r -- "kache rustc wrapper: missing rustc executable"
  exit 2
fi

real_rustc=$1
shift

crate_name=unknown
source_path=
previous=

for argument in "$@"; do
  if [[ "$previous" == "--crate-name" ]]; then
    crate_name=$argument
  fi

  if [[ -z "$source_path" && "$argument" != -* && "$argument" == *.rs ]]; then
    source_path=$argument
  fi

  if [[ "$argument" == --crate-name=* ]]; then
    crate_name=${argument#--crate-name=}
  fi

  previous=$argument
done

log_classification() {
  local classification=$1
  local detail=$2
  if [[ -n "${KANNA_KACHE_CLASSIFICATION_LOG:-}" ]]; then
    printf '%s\t%s\t%s\n' "$classification" "$crate_name" "$detail" \
      >> "$KANNA_KACHE_CLASSIFICATION_LOG" 2>/dev/null || true
  fi
}

run_rustc() {
  local reason=$1
  shift
  log_classification direct "$reason"
  exec "$real_rustc" "$@"
}

if [[ -z "$source_path" || -z "${KANNA_KACHE_WORKSPACE_ROOT:-}" ]]; then
  run_rustc unclassified "$@"
fi

workspace_root=${KANNA_KACHE_WORKSPACE_ROOT:A}
source_absolute=${source_path:A}

if [[ "$source_absolute" == "$workspace_root"/* ]]; then
  run_rustc "$source_absolute" "$@"
fi

kache_bin=${KANNA_KACHE_BIN:-}
if [[ -z "$kache_bin" || ! -x "$kache_bin" ]]; then
  run_rustc kache-unavailable "$@"
fi

log_classification kache "$source_absolute"
exec "$kache_bin" "$real_rustc" "$@"
