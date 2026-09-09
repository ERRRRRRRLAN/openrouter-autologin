#!/usr/bin/env bash
# install.sh — openrouter-autologin
# Cross-platform installer: macOS/Linux via curl, Windows via PowerShell (irm).
# Requires: git, node >= 18, Chrome or Chromium.
set -e

REPO="openrouter-autologin"
OWNER="ERRRRRRRLAN"            # <-- filled after repo creation
BRANCH="main"
DEST="$PWD/$REPO"
CLEANUP=()  # backup paths to delete on success

err() { echo "[install] ERROR: $*" >&2; exit 1; }
info() { echo "[install] $*"; }

# ---- preflight ----
command -v git >/dev/null 2>&1 || err "git is required (https://git-scm.com)"
command -v node >/dev/null .sh 2>&1 || true
if ! command -v node >/dev/null 2>&1; then
  err "Node.js >= 18 is required (https://nodejs.org)"
fi
node -e "process.exit(/^v(1[89]|2[0-9]|[3-9][0-9])/.test(process.version) ? 0 : 1)" \
  || err "Node.js >= 18 required, found $(node -v)"

# ---- obtain source ----
if [ -d "$DEST/node_modules" ]; then
  info "Existing clone found at $DEST — pulling latest..."
  git -C "$DEST" pull --ff-only
else
  info "Cloning $OWNER/$REPO -> $DEST"
  git clone --depth 1 -b "$BRANCH" "https://github.com/$OWNER/$REPO.git" "$DEST"
fi
cd "$DEST"

# ---- deps ----
info "Installing npm dependencies (puppeteer + stealth)..."
npm install --no-fund --no-audit --loglevel=error

info "All set. Next steps:"
echo ""
echo "  cd $REPO"
echo "  cp account.txt.example account.txt   # then add your accounts"
echo "  npm start                            # or: npm run launcher"
echo ""
