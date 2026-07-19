#!/bin/zsh

set -euo pipefail

script_dir=${0:A:h}
wrapper="$script_dir/kache-rustc-wrapper.zsh"
fixture_root=$(mktemp -d /tmp/kanna-kache-wrapper-test.XXXXXX)
trap 'rm -rf -- "$fixture_root"' EXIT

workspace="$fixture_root/workspace with spaces"
external="$fixture_root/cargo-registry/example"
mkdir -p "$workspace/src" "$external/src" "$fixture_root/bin"
: > "$workspace/src/lib.rs"
: > "$external/src/lib.rs"
ln -s "$workspace" "$fixture_root/workspace-link"

call_log="$fixture_root/call.log"
classification_log="$fixture_root/classification.log"

real_rustc="$fixture_root/bin/fake-rustc"
fake_kache="$fixture_root/bin/fake-kache"

cat > "$real_rustc" <<'SCRIPT'
#!/bin/zsh
print -r -- rustc > "$KACHE_WRAPPER_TEST_CALL_LOG"
printf '%s\n' "$@" >> "$KACHE_WRAPPER_TEST_CALL_LOG"
SCRIPT

cat > "$fake_kache" <<'SCRIPT'
#!/bin/zsh
print -r -- kache > "$KACHE_WRAPPER_TEST_CALL_LOG"
printf '%s\n' "$@" >> "$KACHE_WRAPPER_TEST_CALL_LOG"
SCRIPT

chmod +x "$real_rustc" "$fake_kache"

assert_call() {
  local expected=$1
  local actual
  actual=$(<"$call_log")
  if [[ "$actual" != "$expected" ]]; then
    print -u2 -r -- "unexpected compiler call"
    print -u2 -r -- "expected:"
    print -u2 -r -- "$expected"
    print -u2 -r -- "actual:"
    print -u2 -r -- "$actual"
    return 1
  fi
}

run_wrapper() {
  local cwd=$1
  shift
  (
    cd "$cwd"
    KANNA_KACHE_WORKSPACE_ROOT="$fixture_root/workspace-link" \
      KANNA_KACHE_BIN="$fake_kache" \
      KANNA_KACHE_CLASSIFICATION_LOG="$classification_log" \
      KACHE_WRAPPER_TEST_CALL_LOG="$call_log" \
      zsh "$wrapper" "$real_rustc" "$@"
  )
}

run_wrapper "$workspace" \
  --crate-name local_crate src/lib.rs --emit=metadata "argument with spaces"
assert_call "$(printf '%s\n' \
  rustc \
  --crate-name local_crate src/lib.rs --emit=metadata "argument with spaces")"

run_wrapper "$external" \
  --crate-name registry_crate src/lib.rs --emit=metadata "argument with spaces"
assert_call "$(printf '%s\n' \
  kache "$real_rustc" \
  --crate-name registry_crate src/lib.rs --emit=metadata "argument with spaces")"

run_wrapper "$workspace" --print cfg
assert_call "$(printf '%s\n' rustc --print cfg)"

(
  cd "$external"
  KANNA_KACHE_WORKSPACE_ROOT="$fixture_root/workspace-link" \
    KANNA_KACHE_BIN="$fixture_root/bin/missing-kache" \
    KANNA_KACHE_CLASSIFICATION_LOG="$classification_log" \
    KACHE_WRAPPER_TEST_CALL_LOG="$call_log" \
    zsh "$wrapper" "$real_rustc" \
      --crate-name registry_without_cache src/lib.rs --emit=metadata
)
assert_call "$(printf '%s\n' \
  rustc \
  --crate-name registry_without_cache src/lib.rs --emit=metadata)"

grep -q $'^direct\tlocal_crate\t' "$classification_log"
grep -q $'^kache\tregistry_crate\t' "$classification_log"
grep -q $'^direct\tunknown\tunclassified$' "$classification_log"
grep -q $'^direct\tregistry_without_cache\tkache-unavailable$' "$classification_log"

print -r -- "kache rustc wrapper contract: all cases passed"
