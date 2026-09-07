#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="$ROOT/apps/desktop"
RAW_TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kanna-update-e2e.XXXXXX")"
TMP_ROOT="$(cd "$RAW_TMP_ROOT" && pwd -P)"
SERVER_PID=""
APP_PID=""
APP_LOG="/tmp/kanna-update-full-bundle-e2e-app.log"

cleanup() {
    local status=$?
    if [[ -n "$APP_PID" ]]; then
        kill "$APP_PID" >/dev/null 2>&1 || true
        wait "$APP_PID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${INSTALLED_APP:-}" ]]; then
        pkill -f "$INSTALLED_APP/Contents/MacOS/kanna-desktop" >/dev/null 2>&1 || true
    fi
    if [[ -n "$SERVER_PID" ]]; then
        kill "$SERVER_PID" >/dev/null 2>&1 || true
        wait "$SERVER_PID" >/dev/null 2>&1 || true
    fi
    if [[ "$status" -ne 0 && "${KANNA_UPDATE_E2E_KEEP_TMP:-0}" = "1" ]]; then
        echo "[update-e2e] preserving temp root after failure: $TMP_ROOT" >&2
        echo "[update-e2e] app log: $APP_LOG" >&2
    else
        chmod -R u+w "$TMP_ROOT" >/dev/null 2>&1 || true
        rm -rf "$TMP_ROOT"
    fi
    exit "$status"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Full-bundle app update E2E currently runs only on macOS." >&2
    exit 1
fi

OLD_VERSION="${KANNA_UPDATE_E2E_OLD_VERSION:-0.0.44}"
NEW_VERSION="${KANNA_UPDATE_E2E_NEW_VERSION:-0.0.45}"
KEY_PATH="$TMP_ROOT/updater.key"
RELEASE_DIR="$TMP_ROOT/release"
BUILD_DIR="$TMP_ROOT/builds"
INSTALL_ROOT="$TMP_ROOT/install"
INSTALLED_APP="$INSTALL_ROOT/Kanna.app"
OLD_APP_SOURCE="$BUILD_DIR/old/Kanna.app"
NEW_APP_SOURCE="$BUILD_DIR/new/Kanna.app"

find_free_port() {
    node <<'EOF'
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(1);
  const port = address.port;
  server.close(() => {
    process.stdout.write(String(port));
  });
});
EOF
}

WEBDRIVER_PORT="${KANNA_UPDATE_E2E_WEBDRIVER_PORT:-$(find_free_port)}"
SERVER_PORT="${KANNA_UPDATE_E2E_SERVER_PORT:-$(find_free_port)}"
MANIFEST_URL="http://127.0.0.1:$SERVER_PORT/latest.json"

case "$(uname -m)" in
    arm64) PLATFORM_KEY="darwin-aarch64"; ARCH_SUFFIX="arm64" ;;
    x86_64) PLATFORM_KEY="darwin-x86_64"; ARCH_SUFFIX="x86_64" ;;
    *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$RELEASE_DIR" "$BUILD_DIR/old" "$BUILD_DIR/new" "$INSTALL_ROOT"

echo "[update-e2e] staging sidecars and building frontend"
pnpm --dir "$DESKTOP_DIR" run build:sidecars
pnpm --dir "$DESKTOP_DIR" run build

echo "[update-e2e] generating temporary updater signing key"
pnpm --dir "$DESKTOP_DIR" exec tauri signer generate --ci --force -w "$KEY_PATH" >/dev/null
UPDATER_PUBKEY="$(tr -d '\n' < "$KEY_PATH.pub")"

write_tauri_overlay() {
    local version="$1"
    local output="$2"
    VERSION="$version" \
    UPDATER_PUBKEY="$UPDATER_PUBKEY" \
    MANIFEST_URL="$MANIFEST_URL" \
    node <<'EOF' > "$output"
const version = process.env.VERSION;
const pubkey = process.env.UPDATER_PUBKEY;
const endpoint = process.env.MANIFEST_URL;
process.stdout.write(JSON.stringify({
  version,
  build: {
    beforeBuildCommand: "",
    beforeBundleCommand: ""
  },
  bundle: {
    active: true,
    targets: ["app"],
    createUpdaterArtifacts: true
  },
  plugins: {
    updater: {
      pubkey,
      endpoints: [endpoint],
      dangerousInsecureTransportProtocol: true
    }
  }
}, null, 2));
EOF
}

find_built_app() {
    local search_roots=()
    [[ -d "$ROOT/.build" ]] && search_roots+=("$ROOT/.build")
    [[ -d "$DESKTOP_DIR/src-tauri/target" ]] && search_roots+=("$DESKTOP_DIR/src-tauri/target")
    if [[ "${#search_roots[@]}" -eq 0 ]]; then
        return 0
    fi

    find "${search_roots[@]}" \
        -path "*/debug/bundle/macos/Kanna.app" \
        -type d \
        -prune \
        -print | sort | tail -1
}

build_app_bundle() {
    local version="$1"
    local destination="$2"
    local overlay="$TMP_ROOT/tauri-$version.json"
    write_tauri_overlay "$version" "$overlay"

    echo "[update-e2e] building Kanna.app $version"
    KANNA_VERSION="$version" \
    KANNA_UPDATER_PUBKEY="$UPDATER_PUBKEY" \
    pnpm --dir "$DESKTOP_DIR" exec tauri build \
        --debug \
        --bundles app \
        --no-sign \
        --ci \
        --ignore-version-mismatches \
        --config "$overlay"

    local built_app
    built_app="$(find_built_app)"
    if [[ -z "$built_app" || ! -d "$built_app" ]]; then
        echo "Expected debug Kanna.app bundle was not produced." >&2
        exit 1
    fi

    rm -rf "$destination"
    cp -R "$built_app" "$destination"
}

create_updater_bundle() {
    local app_source="$1"
    local bundle_dest="$2"
    local stage_root="$bundle_dest.stage"
    local stage_app="$stage_root/$(basename "$app_source")"
    rm -f "$bundle_dest"
    rm -rf "$stage_root"
    mkdir -p "$stage_root"
    cp -R "$app_source" "$stage_app"
    find "$stage_app" -type d -exec chmod u+rwx,go+rx {} +
    COPYFILE_DISABLE=1 tar -C "$stage_root" -czf "$bundle_dest" "$(basename "$app_source")"
    rm -rf "$stage_root"
}

make_app_dirs_readonly() {
    local app_source="$1"
    find "$app_source" -type d -exec chmod a-w {} +
}

sign_updater_bundle() {
    local bundle_path="$1"
    local signature_path="$2"
    local generated_signature="${bundle_path}.sig"
    rm -f "$generated_signature" "$signature_path"
    pnpm --dir "$DESKTOP_DIR" exec tauri signer sign \
        --private-key-path "$KEY_PATH" \
        --password "" \
        "$bundle_path" >/dev/null
    mv "$generated_signature" "$signature_path"
}

write_manifest() {
    local bundle_url="$1"
    local signature="$2"
    VERSION="$NEW_VERSION" \
    PLATFORM_KEY="$PLATFORM_KEY" \
    BUNDLE_URL="$bundle_url" \
    SIGNATURE="$signature" \
    node <<'EOF' > "$RELEASE_DIR/latest.json"
const version = process.env.VERSION;
const platformKey = process.env.PLATFORM_KEY;
const url = process.env.BUNDLE_URL;
const signature = process.env.SIGNATURE;
process.stdout.write(JSON.stringify({
  version,
  notes: "Full-bundle updater E2E",
  pub_date: "2026-04-29T00:00:00Z",
  platforms: {
    [platformKey]: { url, signature }
  }
}, null, 2));
EOF
}

read_bundle_version() {
    /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist"
}

wait_for_server() {
    local deadline=$((SECONDS + 20))
    while (( SECONDS < deadline )); do
        if curl -fsS "$MANIFEST_URL" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.25
    done
    echo "Timed out waiting for update manifest server at $MANIFEST_URL" >&2
    exit 1
}

drive_update_ui() {
    APP_WEBDRIVER_PORT="$WEBDRIVER_PORT" \
    OLD_VERSION="$OLD_VERSION" \
    NEW_VERSION="$NEW_VERSION" \
    node <<'EOF'
const port = process.env.APP_WEBDRIVER_PORT;
const oldVersion = process.env.OLD_VERSION;
const newVersion = process.env.NEW_VERSION;
const baseUrl = `http://127.0.0.1:${port}`;
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
const EXPECTED_WINDOW_RECT = { x: 120, y: 90, width: 980, height: 720 };
const RECT_TOLERANCE = 16;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.value?.error) {
    throw new Error(payload.value.message || payload.value.error);
  }
  return payload.value;
}

async function executeAsync(sessionId, script) {
  return request("POST", `/session/${sessionId}/execute/async`, {
    script,
    args: [],
  });
}

async function waitForStatus() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/status`).catch(() => null);
    if (response?.ok) return;
    await sleep(500);
  }
  throw new Error(`WebDriver did not become available at ${baseUrl}`);
}

async function waitForSessionGone(sessionId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = await request("POST", `/session/${sessionId}/execute/sync`, {
      script: "return document.readyState;",
      args: [],
    }).catch(() => null);
    if (value === null) return;
    await sleep(500);
  }
  throw new Error("Timed out waiting for updater relaunch to close the original WebDriver session.");
}

async function waitForText(sessionId, text, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastBody = "";
  while (Date.now() < deadline) {
    const body = await request("POST", `/session/${sessionId}/execute/sync`, {
      script: "return document.body.innerText;",
      args: [],
    }).catch(() => "");
    lastBody = String(body);
    if (String(body).includes(text)) return;
    await sleep(500);
  }
  const updateCheck = await executeAsync(sessionId, `
      const cb = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke("plugin:updater|check", {
        headers: null,
        timeout: null,
        proxy: null,
        target: null,
        allowDowngrades: null
      }).then(
        (value) => cb({ ok: true, value }),
        (error) => cb({ ok: false, error: String(error) })
      );
    `).catch((error) => ({ ok: false, error: String(error) }));
  console.error("[update-e2e] body text before timeout:");
  console.error(lastBody);
  console.error("[update-e2e] raw updater check:");
  console.error(JSON.stringify(updateCheck, null, 2));
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function click(sessionId, selector) {
  const element = await request("POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: selector,
  });
  await request("POST", `/session/${sessionId}/element/${element[elementKey]}/click`, {});
}

async function getWindowRect(sessionId) {
  return request("GET", `/session/${sessionId}/window/rect`);
}

async function setWindowRect(sessionId, rect) {
  await request("POST", `/session/${sessionId}/window/rect`, rect);
}

function rectDelta(actual, expected) {
  return {
    x: Math.abs(actual.x - expected.x),
    y: Math.abs(actual.y - expected.y),
    width: Math.abs(actual.width - expected.width),
    height: Math.abs(actual.height - expected.height),
  };
}

function isRectClose(actual, expected) {
  const delta = rectDelta(actual, expected);
  return Object.values(delta).every((value) => value <= RECT_TOLERANCE);
}

async function waitForWindowRect(sessionId, expectedRect, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await getWindowRect(sessionId);
    if (isRectClose(latest, expectedRect)) return latest;
    await sleep(250);
  }
  throw new Error(
    `Window rect did not reach expected bounds before updater restart. expected=${JSON.stringify(expectedRect)} actual=${JSON.stringify(latest)} delta=${JSON.stringify(rectDelta(latest, expectedRect))}`
  );
}

async function assertRestoredWindowRect(sessionId, expectedRect) {
  const deadline = Date.now() + 20000;
  let actual = null;
  while (Date.now() < deadline) {
    actual = await getWindowRect(sessionId);
    if (isRectClose(actual, expectedRect)) return;
    await sleep(250);
  }
  throw new Error(
    `Window state was not restored after updater relaunch. expected=${JSON.stringify(expectedRect)} actual=${JSON.stringify(actual)} delta=${JSON.stringify(rectDelta(actual, expectedRect))}`
  );
}

await waitForStatus();
const session = await request("POST", "/session", { capabilities: {} });
const sessionId = session.sessionId;
let relaunchedSessionId = null;
try {
  const expectedRect = EXPECTED_WINDOW_RECT;
  await setWindowRect(sessionId, expectedRect);
  await waitForWindowRect(sessionId, expectedRect);
  await waitForText(sessionId, "Update available");
  await waitForText(sessionId, newVersion);
  const body = await request("POST", `/session/${sessionId}/execute/sync`, {
    script: "return document.body.innerText;",
    args: [],
  });
  if (String(body).includes(oldVersion) && !String(body).includes(newVersion)) {
    throw new Error("Update prompt did not expose the newer version.");
  }
  await click(sessionId, "[data-testid=\"update-install\"]");
  await waitForText(sessionId, "Ready to restart", 60000);
  await click(sessionId, '[data-testid="update-restart"]');
  await waitForSessionGone(sessionId);
  await waitForStatus();
  const relaunchedSession = await request("POST", "/session", { capabilities: {} });
  relaunchedSessionId = relaunchedSession.sessionId;
  await assertRestoredWindowRect(relaunchedSessionId, expectedRect);
} finally {
  if (relaunchedSessionId) {
    await fetch(`${baseUrl}/session/${relaunchedSessionId}`, { method: "DELETE" }).catch(() => undefined);
  }
  await fetch(`${baseUrl}/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
}
EOF
}

build_app_bundle "$OLD_VERSION" "$OLD_APP_SOURCE"
build_app_bundle "$NEW_VERSION" "$NEW_APP_SOURCE"
make_app_dirs_readonly "$NEW_APP_SOURCE"

BUNDLE_NAME="Kanna_${NEW_VERSION}_${ARCH_SUFFIX}.app.tar.gz"
BUNDLE_PATH="$RELEASE_DIR/$BUNDLE_NAME"
SIGNATURE_PATH="$BUNDLE_PATH.sig"
create_updater_bundle "$NEW_APP_SOURCE" "$BUNDLE_PATH"
sign_updater_bundle "$BUNDLE_PATH" "$SIGNATURE_PATH"
SIGNATURE="$(cat "$SIGNATURE_PATH")"
write_manifest "http://127.0.0.1:$SERVER_PORT/$BUNDLE_NAME" "$SIGNATURE"

cp -R "$OLD_APP_SOURCE" "$INSTALLED_APP"
if [[ "$(read_bundle_version "$INSTALLED_APP")" != "$OLD_VERSION" ]]; then
    echo "Installed old app bundle does not report $OLD_VERSION." >&2
    exit 1
fi

echo "[update-e2e] serving updater manifest from $MANIFEST_URL"
python3 -m http.server "$SERVER_PORT" --bind 127.0.0.1 --directory "$RELEASE_DIR" >/dev/null 2>&1 &
SERVER_PID="$!"
wait_for_server

echo "[update-e2e] launching old app from $INSTALLED_APP"
# KANNA_E2E_NO_ACTIVATE keeps this instance — and the copy the updater relaunches,
# which inherits this environment — from taking the operator's focus mid-run.
env -u KANNA_WORKTREE \
    KANNA_DB_NAME="kanna-update-full-bundle-e2e-test.db" \
    KANNA_DAEMON_DIR="$TMP_ROOT/daemon" \
    KANNA_E2E_NO_ACTIVATE="${KANNA_E2E_NO_ACTIVATE:-1}" \
    KANNA_WEBDRIVER_PORT="$WEBDRIVER_PORT" \
"$INSTALLED_APP/Contents/MacOS/kanna-desktop" >"$APP_LOG" 2>&1 &
APP_PID="$!"

drive_update_ui

UPDATED_VERSION="$(read_bundle_version "$INSTALLED_APP")"
if [[ "$UPDATED_VERSION" != "$NEW_VERSION" ]]; then
    echo "Expected installed app bundle to update to $NEW_VERSION, got $UPDATED_VERSION." >&2
    exit 1
fi

echo "[update-e2e] full-bundle updater smoke passed: $OLD_VERSION -> $UPDATED_VERSION"
