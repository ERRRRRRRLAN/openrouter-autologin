# install.ps1 — openrouter-autologin (Windows)
# Run from any terminal:
#   irm https://raw.githubusercontent.com/ERRRRRRRLAN/openrouter-autologin/main/install.ps1 | iex
# Requires: git, Node.js >= 18, Google Chrome.
$ErrorActionPreference = "Stop"

$Repo = "openrouter-autologin"
$Owner = "ERRRRRRRLAN"
$Branch = "main"
$Dest = Join-Path (Get-Location) $Repo

function Fail($msg) { Write-Host "[install] ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }

# ---- preflight ----
try { $null = git --version } catch { Fail "git is required (https://git-scm.com)" }
try { $null = node --version } catch { Fail "Node.js >= 18 is required (https://nodejs.org)" }
$nv = node --version
if ($nv -notmatch '^v(1[89]|2[0-9]|[3-9][0-9])\.') { Fail "Node.js >= 18 required, found $nv" }

# ---- obtain source ----
if (Test-Path (Join-Path $Dest "node_modules")) {
  Info "Existing clone at $Dest - pulling latest..."
  git -C $Dest pull --ff-only
} else {
  Info "Cloning $Owner/$Repo -> $Dest"
  git clone --depth 1 -b $Branch "https://github.com/$Owner/$Repo.git" $Dest
}
Set-Location $Dest

# ---- deps ----
Info "Installing npm dependencies (puppeteer + stealth)..."
$env:npm_config_fund = "false"
$env:npm_config_audit = "false"
npm install --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }

Info "All set. You are now in: $Dest"
Write-Host ""
Write-Host "  1. copy account.txt.example account.txt   # then add your accounts"
Write-Host "  2. npm start                              # run the bot (or: npm run launcher)"
Write-Host "  3. stop.bat                               # double-click to stop the bot anytime"
Write-Host ""
