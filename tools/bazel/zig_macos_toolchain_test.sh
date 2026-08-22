#!/bin/sh
set -eu

zig="$1"
case "$zig" in
  *zig-macos-sdk-wrapper) ;;
  *)
    echo "resolved Zig toolchain did not select the patched macOS SDK wrapper: $zig" >&2
    exit 1
    ;;
esac

case "$zig" in
  external/*) zig="${RUNFILES_DIR:?}/${zig#external/}" ;;
esac

test_root="${TEST_TMPDIR:?}"
source_file="$test_root/hello.zig"
output_file="$test_root/hello"

printf '%s\n' 'pub fn main() void { @import("std").debug.print("kanna-zig-toolchain-ok\n", .{}); }' > "$source_file"
"$zig" build-exe "$source_file" -femit-bin="$output_file"
actual="$($output_file 2>&1)"

if [ "$actual" != "kanna-zig-toolchain-ok" ]; then
  echo "unexpected output from Zig-linked native executable: $actual" >&2
  exit 1
fi
