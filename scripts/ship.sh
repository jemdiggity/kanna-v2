#!/bin/bash
set -euo pipefail

STEP=""
cleanup() {
    if [[ -n "$STEP" ]]; then
        echo "Error: failed during: $STEP" >&2
    fi
    # Reset version files if we modified them but didn't finish
    if [[ "${VERSION_FILES_DIRTY:-false}" = true ]]; then
        echo "    Resetting version files..." >&2
        git -C "$ROOT" checkout -- VERSION apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml 2>/dev/null || true
        # Cargo.lock may not have changed yet
        git -C "$ROOT" checkout -- apps/desktop/src-tauri/Cargo.lock 2>/dev/null || true
    fi
}
trap cleanup ERR

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/.build"

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Build, sign, notarize, and release a new version of Kanna.

Options:
  --major    Bump major version (X.0.0)
  --minor    Bump minor version (0.X.0)
  --patch    Bump patch version (0.0.X) [default]
  --arm64    Build only arm64 (Apple Silicon)
  --x86_64   Build only x86_64 (Intel)
               (default: build both architectures)
  --release  Tag, push, and create GitHub release after building
  --dry-run  Build and sign but skip notarization and release
  --help     Show this help message

Prerequisites:
  - Clean git working directory
  - Developer ID Application certificate installed
  - APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID env vars (for notarization)
  - gh CLI authenticated
  - Rust targets installed: rustup target add aarch64-apple-darwin x86_64-apple-darwin

Examples:
  ./scripts/ship.sh                   # Build both architectures, sign, and notarize
  ./scripts/ship.sh --arm64           # Build arm64 only
  ./scripts/ship.sh --x86_64          # Build x86_64 only
  ./scripts/ship.sh --release         # Also tag, push, and create GitHub release
  ./scripts/ship.sh --minor --release # Minor version release
  ./scripts/ship.sh --dry-run         # Build and sign only (skip notarization)
EOF
    exit 0
}

# Parse arguments
DRY_RUN=false
RELEASE=false
BUMP="patch"
BUILD_ARM64=false
BUILD_X86_64=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --help|-h) usage ;;
        --major) BUMP="major"; shift ;;
        --minor) BUMP="minor"; shift ;;
        --patch) BUMP="patch"; shift ;;
        --arm64) BUILD_ARM64=true; shift ;;
        --x86_64) BUILD_X86_64=true; shift ;;
        --release) RELEASE=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Default: build both architectures
if [[ "$BUILD_ARM64" = false && "$BUILD_X86_64" = false ]]; then
    BUILD_ARM64=true
    BUILD_X86_64=true
fi

# Build arch arrays based on flags
ARCHS=()
ARCH_LABELS=()
if [[ "$BUILD_ARM64" = true ]]; then
    ARCHS+=(aarch64-apple-darwin)
    ARCH_LABELS+=(arm64)
fi
if [[ "$BUILD_X86_64" = true ]]; then
    ARCHS+=(x86_64-apple-darwin)
    ARCH_LABELS+=(x86_64)
fi

# --- Validate prerequisites ---

STEP="validating prerequisites"

# Clean git state (skip in dry-run — no tag/release happens)
if [[ "$DRY_RUN" = false ]]; then
    if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
        echo "Error: Working directory is not clean. Commit or stash changes first."
        exit 1
    fi

    # Must be up to date with origin/main (releases always target main)
    git -C "$ROOT" fetch --quiet origin main
    if ! git -C "$ROOT" merge-base --is-ancestor origin/main HEAD; then
        echo "Error: Your branch is behind origin/main. Merge or rebase first."
        exit 1
    fi
fi

# Developer ID certificate
DEVELOPER_ID=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | awk -F'"' '{print $2}' || true)
if [[ -z "$DEVELOPER_ID" ]]; then
    if [[ "$DRY_RUN" = true ]]; then
        echo "    [dry-run] No Developer ID certificate found — build will be unsigned"
    else
        echo "Error: No Developer ID Application certificate found."
        echo "Install your certificate or run 'security find-identity -v -p codesigning' to check."
        exit 1
    fi
else
    echo "    Signing identity: $DEVELOPER_ID"
    export APPLE_SIGNING_IDENTITY="$DEVELOPER_ID"
fi

# Notarization credentials (skip check in dry-run mode)
if [[ "$DRY_RUN" = false ]]; then
    MISSING_VARS=()
    [[ -z "${APPLE_ID:-}" ]] && MISSING_VARS+=("APPLE_ID")
    [[ -z "${APPLE_PASSWORD:-}" ]] && MISSING_VARS+=("APPLE_PASSWORD")
    [[ -z "${APPLE_TEAM_ID:-}" ]] && MISSING_VARS+=("APPLE_TEAM_ID")
    if [[ ${#MISSING_VARS[@]} -gt 0 ]]; then
        echo "Error: Missing notarization env vars: ${MISSING_VARS[*]}"
        echo "Set APPLE_ID, APPLE_PASSWORD (app-specific password), and APPLE_TEAM_ID."
        echo "Or use --dry-run to skip notarization."
        exit 1
    fi
fi

# gh CLI (only needed for --release)
if [[ "$DRY_RUN" = false ]]; then
    if ! gh auth status >/dev/null 2>&1; then
        echo "Error: gh CLI is not authenticated. Run 'gh auth login' first."
        exit 1
    fi
fi

# Rust targets
for TARGET in "${ARCHS[@]}"; do
    if ! rustup target list --installed | grep -q "$TARGET"; then
        echo "Error: Rust target $TARGET is not installed."
        echo "Run: rustup target add $TARGET"
        exit 1
    fi
done

echo "    Prerequisites OK"

# --- Bump version ---

STEP="bumping version"

# Fetch tags from origin so we don't miss versions pushed by other machines
git -C "$ROOT" fetch --quiet origin --tags

LAST_TAG=$(git -C "$ROOT" tag -l 'v*' --sort=-v:refname | head -1)
if [[ -z "$LAST_TAG" ]]; then
    LAST_VERSION="0.0.0"
else
    LAST_VERSION="${LAST_TAG#v}"
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$LAST_VERSION"

# Don't bump if the tag exists locally but was never pushed
if [[ -n "$LAST_TAG" ]] && ! git -C "$ROOT" ls-remote --tags origin "refs/tags/$LAST_TAG" | grep -q "$LAST_TAG"; then
    echo "    Tag $LAST_TAG exists locally but was never pushed — re-releasing $LAST_VERSION"
else
    case $BUMP in
        major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
        minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
        patch) PATCH=$((PATCH + 1)) ;;
    esac
fi

VERSION="$MAJOR.$MINOR.$PATCH"

echo "==> Shipping Kanna v$LAST_VERSION → v$VERSION"

# --- Sync version files ---

STEP="syncing version files"
VERSION_FILES_DIRTY=true

# Write VERSION file
echo "$VERSION" > "$ROOT/VERSION"

# Update tauri.conf.json (semver only)
TAURI_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.json"
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$TAURI_CONF"

# Update Cargo.toml [package] version (first version = line only)
CARGO_TOML="$ROOT/apps/desktop/src-tauri/Cargo.toml"
sed -i '' "1,/^version = /s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$CARGO_TOML"

# Regenerate Cargo.lock
cargo check --manifest-path "$CARGO_TOML" --quiet 2>/dev/null || true

echo "    Version files updated to $VERSION"

# --- Build both architectures ---

DMG_PATHS=()
RELEASE_DIR="$BUILD_DIR/release"
mkdir -p "$RELEASE_DIR"

for i in "${!ARCHS[@]}"; do
    ARCH="${ARCHS[$i]}"
    LABEL="${ARCH_LABELS[$i]}"

    STEP="build ($LABEL)"
    echo "    Building sidecars ($LABEL)..."

    # Build and stage kanna-daemon + kanna-hook for this target
    (
        cd "$ROOT"
        export RUSTC_WRAPPER=""
        if [[ "$ARCH" = "x86_64-apple-darwin" && -d "/usr/local/opt/openssl@3" ]]; then
            export OPENSSL_DIR="/usr/local/opt/openssl@3"
        fi
        cargo build --release --target "$ARCH" --manifest-path crates/daemon/Cargo.toml
        cargo build --release --target "$ARCH" --manifest-path crates/kanna-hook/Cargo.toml
    )
    "$ROOT/scripts/stage-sidecars.sh" --release --target "$ARCH"

    echo "    Building app ($LABEL)..."

    (
        cd "$ROOT/apps/desktop"
        # sccache doesn't work inside Tauri's build subprocess
        export RUSTC_WRAPPER=""
        # x86_64 cross-compile needs x86 Homebrew OpenSSL
        if [[ "$ARCH" = "x86_64-apple-darwin" && -d "/usr/local/opt/openssl@3" ]]; then
            export OPENSSL_DIR="/usr/local/opt/openssl@3"
        fi
        if [[ "$DRY_RUN" = true ]]; then
            # Unset notarization vars so Tauri signs but doesn't notarize
            unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
        fi
        bun tauri build --target "$ARCH"
    )

    # Find the DMG in Tauri's output directory
    DMG_SOURCE_DIR="$BUILD_DIR/${ARCH}/release/bundle/dmg"
    DMG_SOURCE=$(find "$DMG_SOURCE_DIR" -name "*.dmg" -type f 2>/dev/null | head -1)
    if [[ -z "$DMG_SOURCE" ]]; then
        echo "Error: No DMG found in $DMG_SOURCE_DIR"
        exit 1
    fi

    DMG_NAME="Kanna-${VERSION}-${LABEL}.dmg"
    DMG_DEST="$RELEASE_DIR/$DMG_NAME"
    cp "$DMG_SOURCE" "$DMG_DEST"
    DMG_PATHS+=("$DMG_DEST")

    echo "    Built: $DMG_NAME"
done

# Version files were intentionally modified — don't reset on success
VERSION_FILES_DIRTY=false

# --- Release ---

if [[ "$RELEASE" = true ]]; then
    # Check tag doesn't already exist on remote
    if git -C "$ROOT" ls-remote --tags origin "refs/tags/v$VERSION" | grep -q "v$VERSION"; then
        echo "Error: Tag v$VERSION already exists on origin."
        exit 1
    fi

    STEP="committing version bump"
    echo "    Committing version bump..."
    git -C "$ROOT" add -f VERSION apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
    git -C "$ROOT" commit -m "release: v$VERSION"

    STEP="tagging and pushing"
    echo "    Tagging v$VERSION..."
    # Only create tag if it doesn't already exist locally (re-release case)
    if ! git -C "$ROOT" tag -l "v$VERSION" | grep -q "v$VERSION"; then
        git -C "$ROOT" tag "v$VERSION"
    fi

    # Fast-forward main to include the version bump, then push main + tag.
    # This works because the worktree branch started from main with no diverging commits.
    CURRENT_BRANCH=$(git -C "$ROOT" symbolic-ref --short HEAD)
    if [[ "$CURRENT_BRANCH" != "main" ]]; then
        echo "    Fast-forwarding main to include release commit..."
        git -C "$ROOT" fetch origin main --quiet
        RELEASE_COMMIT=$(git -C "$ROOT" rev-parse HEAD)
        # Verify main is an ancestor (worktree didn't diverge)
        if ! git -C "$ROOT" merge-base --is-ancestor origin/main "$RELEASE_COMMIT"; then
            echo "Error: main has diverged from this branch. Merge main first."
            exit 1
        fi
        git -C "$ROOT" push origin "$RELEASE_COMMIT:refs/heads/main" --tags
    else
        git -C "$ROOT" push origin main --tags
    fi

    STEP="creating GitHub release"
    echo "    Creating GitHub release..."
    gh release create "v$VERSION" "${DMG_PATHS[@]}" \
        --title "Kanna v$VERSION" \
        --generate-notes

    echo "==> Shipped Kanna v$VERSION"
    echo "    https://github.com/jemdiggity/kanna-tauri/releases/tag/v$VERSION"
else
    echo "==> Built Kanna v$VERSION"
    for DMG in "${DMG_PATHS[@]}"; do
        echo "    DMG: $DMG"
    done
    echo "    Run with --release to tag and publish to GitHub"
fi
