#!/bin/sh
set -eu

REPO="jemdiggity/kanna"
APP_NAME="Kanna"
INSTALL_DIR="/Applications"

main() {
  check_os
  check_deps

  tag=$(get_latest_tag)
  echo "Installing ${APP_NAME} ${tag}..."

  arch=$(uname -m)
  case "$arch" in
    arm64|aarch64) arch_suffix="aarch64" ;;
    x86_64)        arch_suffix="x86_64" ;;
    *)             fail "Unsupported architecture: ${arch}" ;;
  esac

  dmg_name="${APP_NAME}_${tag#v}_${arch_suffix}.dmg"
  url="https://github.com/${REPO}/releases/download/${tag}/${dmg_name}"

  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT

  echo "Downloading ${dmg_name}..."
  curl -fSL --progress-bar -o "${tmpdir}/${dmg_name}" "$url" \
    || fail "Download failed. Check that ${tag} has a release for ${arch_suffix}."

  echo "Installing to ${INSTALL_DIR}..."
  hdiutil attach -quiet -nobrowse -mountpoint "${tmpdir}/mnt" "${tmpdir}/${dmg_name}"
  cp -R "${tmpdir}/mnt/${APP_NAME}.app" "${INSTALL_DIR}/${APP_NAME}.app"
  hdiutil detach -quiet "${tmpdir}/mnt"

  echo "${APP_NAME} installed to ${INSTALL_DIR}/${APP_NAME}.app"
}

check_os() {
  [ "$(uname -s)" = "Darwin" ] || fail "Kanna is macOS-only."
}

check_deps() {
  command -v curl >/dev/null || fail "curl is required."
  command -v hdiutil >/dev/null || fail "hdiutil is required."
}

get_latest_tag() {
  curl -fsSL -H "Accept: application/json" \
    "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name":"\([^"]*\)".*/\1/p' \
    || fail "Could not fetch latest release."
}

fail() {
  echo "Error: $1" >&2
  exit 1
}

main
