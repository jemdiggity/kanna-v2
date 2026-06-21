#!/bin/sh
set -eu

repo_root="$(git rev-parse --show-toplevel)"
mkdir -p "${repo_root}/.cargo"
printf "[build]\ntarget-dir = \".build\"\n" > "${repo_root}/.cargo/config.toml"
