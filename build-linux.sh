#!/usr/bin/env bash
# Sidearm Linux Build Script
# Usage: ./build-linux.sh [--clean]
#
# Builds the release binary + bundles (AppImage, deb).
# Run this on a Linux machine with the repo cloned.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$PROJECT_DIR/src-tauri"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[build]${NC} $*"; }
warn() { echo -e "${YELLOW}[build]${NC} $*"; }
err()  { echo -e "${RED}[build]${NC} $*" >&2; }
ok()   { echo -e "${GREEN}[build]${NC} $*"; }

# ── Parse args ──────────────────────────────────────────────
CLEAN=false
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=true ;;
        -h|--help)
            echo "Usage: ./build-linux.sh [--clean]"
            echo "  --clean  Force full recompile (cargo clean)"
            exit 0
            ;;
    esac
done

# ── Check prerequisites ────────────────────────────────────
log "Checking prerequisites..."

missing=()
for cmd in cargo node npm; do
    if ! command -v "$cmd" &>/dev/null; then
        missing+=("$cmd")
    fi
done

if [ ${#missing[@]} -gt 0 ]; then
    err "Missing: ${missing[*]}"
    echo ""
    echo "  Install Rust:    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo "  Install Node.js: https://nodejs.org/ (or via nvm)"
    exit 1
fi

# System libraries for Tauri v2
TAURI_LIBS=(
    libwebkit2gtk-4.1-dev
    libgtk-3-dev
    libappindicator3-dev
    librsvg2-dev
    libssl-dev
    patchelf
)
missing_libs=()
for lib in "${TAURI_LIBS[@]}"; do
    if ! dpkg -s "$lib" &>/dev/null 2>&1; then
        missing_libs+=("$lib")
    fi
done

if [ ${#missing_libs[@]} -gt 0 ]; then
    err "Missing system libraries: ${missing_libs[*]}"
    echo ""
    echo "  sudo apt update && sudo apt install -y ${missing_libs[*]}"
    exit 1
fi

ok "Prerequisites OK (cargo $(cargo --version 2>/dev/null | cut -d' ' -f2), node $(node --version 2>/dev/null))"

# ── Clean if requested ─────────────────────────────────────
if $CLEAN; then
    log "Cleaning build artifacts..."
    (cd "$TAURI_DIR" && cargo clean)
fi

# ── Install npm deps if needed ─────────────────────────────
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    log "Installing npm dependencies..."
    (cd "$PROJECT_DIR" && npm install)
fi

# ── Build ──────────────────────────────────────────────────
log "Building Sidearm release..."
cd "$PROJECT_DIR"
npx tauri build

echo ""
ok "Build complete! Output:"
echo ""

# Show what was built
if [ -f "$TAURI_DIR/target/release/sidearm" ]; then
    size=$(du -h "$TAURI_DIR/target/release/sidearm" | cut -f1)
    ok "  Binary:   $TAURI_DIR/target/release/sidearm ($size)"
fi

for bundle in "$TAURI_DIR/target/release/bundle"/{deb,appimage,rpm}/*; do
    if [ -f "$bundle" ]; then
        size=$(du -h "$bundle" | cut -f1)
        ok "  Bundle:   $bundle ($size)"
    fi
done
