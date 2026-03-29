#!/usr/bin/env bash
# Sidearm Dev Server (Linux)
# Usage: ./dev.sh [--clean] [--check-only]
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$PROJECT_DIR/src-tauri"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[sidearm]${NC} $*"; }
warn() { echo -e "${YELLOW}[sidearm]${NC} $*"; }
err()  { echo -e "${RED}[sidearm]${NC} $*" >&2; }
ok()   { echo -e "${GREEN}[sidearm]${NC} $*"; }

# ── Parse args ──────────────────────────────────────────────
CLEAN=false
CHECK_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --clean)      CLEAN=true ;;
        --check-only) CHECK_ONLY=true ;;
        -h|--help)
            echo "Usage: ./dev.sh [--clean] [--check-only]"
            echo "  --clean       Force full recompile (cargo clean)"
            echo "  --check-only  Only run cargo check, don't start dev server"
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
    err "Install Rust (rustup.rs) and Node.js (nodejs.org)"
    exit 1
fi

# Check system libraries for Tauri v2
# libappindicator3-dev conflicts with ayatana on Ubuntu 22.04+; accept either
TAURI_LIBS=(libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev)
APPINDICATOR_OK=false
dpkg -s libappindicator3-dev &>/dev/null 2>&1 && APPINDICATOR_OK=true
dpkg -s libayatana-appindicator3-dev &>/dev/null 2>&1 && APPINDICATOR_OK=true

missing_libs=()
for lib in "${TAURI_LIBS[@]}"; do
    if ! dpkg -s "$lib" &>/dev/null 2>&1; then
        missing_libs+=("$lib")
    fi
done
if ! $APPINDICATOR_OK; then
    missing_libs+=("libayatana-appindicator3-dev (or libappindicator3-dev)")
fi

if [ ${#missing_libs[@]} -gt 0 ]; then
    warn "Missing system libraries: ${missing_libs[*]}"
    warn "Install with:"
    echo "  sudo apt install ${missing_libs[*]}"
    exit 1
fi

# Check input group membership (needed for evdev)
if ! groups | grep -qw input; then
    warn "User '$(whoami)' is not in the 'input' group."
    warn "Keyboard capture (evdev) will not work without it."
    warn "Fix: sudo usermod -aG input \$USER && logout"
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

# ── Check-only mode ────────────────────────────────────────
if $CHECK_ONLY; then
    log "Running cargo check..."
    (cd "$TAURI_DIR" && cargo check)
    ok "cargo check passed"
    log "Running cargo test..."
    (cd "$TAURI_DIR" && cargo test)
    ok "Done"
    exit 0
fi

# ── Kill stale processes ───────────────────────────────────
pkill -f "sidearm" 2>/dev/null || true

# ── Start dev server ───────────────────────────────────────
log "Starting Tauri dev server..."
cd "$PROJECT_DIR"
cargo tauri dev
