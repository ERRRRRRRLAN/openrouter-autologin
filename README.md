<div align="center">

```
 ██████╗ ██████╗ ███████╗███╗   ██╗██████╗  ██████╗ ██╗   ██╗████████╗███████╗
██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝██╔════╝
██║   ██║██████╔╝█████╗  ██╔██╗ ██║██████╔╝██║   ██║██║   ██║   ██║   █████╗  
██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██╔══██╗██║   ██║██║   ██║   ██║   ██╔══╝  
╚██████╔╝██║     ███████╗██║ ╚████║██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████╗
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝
```



# OpenRouter AutoLogin

**Google OAuth login → API key created → saved. Bulk. Headless.**

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

---

## What it does

Feed it a list of Google accounts. For each one, the bot will:

1. Open the OpenRouter sign-in page
2. Complete Google OAuth (email → password → consent), headless with anti-detection
3. Delete stale keys, then create a fresh API key
4. Save the key to `api_keys.txt` and move to the next account

A terminal UI launcher handles start / stop / status / live log viewing.


## Requirements

- **Node.js 18+** — <https://nodejs.org>
- **Google Chrome or Chromium** — <https://www.google.com/chrome/>
- **git** — <https://git-scm.com>

Windows is the primary platform (stop scripts are Windows-native).
macOS/Linux work for the bot itself via `npm start`.

## Install

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/ERRRRRRRLAN/openrouter-autologin/main/install.ps1 | iex
```

> [!IMPORTANT]
> Run this in **PowerShell** — not `cmd`. The curl one-liner below is for
> macOS/Linux only; in `cmd` it fails with a WSL error because `bash` is not
> available there.

### macOS / Linux (any terminal)

```bash
curl -fsSL https://raw.githubusercontent.com/ERRRRRRRLAN/openrouter-autologin/main/install.sh | bash
```

### npm

```bash
npm install git+https://git@github.com/ERRRRRRRLAN/openrouter-autologin.git
```

### Manual

```bash
git clone https://github.com/ERRRRRRRLAN/openrouter-autologin.git
cd openrouter-autologin
npm install
```

### Build the .exe launcher (optional, Windows)

```bash
npm run build:exe
```

## Usage

1. Add your accounts to `account.txt` (copy from `account.txt.example`):

```
email@gmail.com|password
next@gmail.com|password
```

2. Run:

```bash
npm run launcher    # terminal UI (arrow keys, Enter to run, live logs)
npm start           # headless bot directly, no UI
```

Headless mode works without any visible Chrome window — the header shows
`BOT RUNNING (BACKGROUND)` and the launcher streams the last log lines.

3. Stop:

- In the launcher UI: menu item **3. Stop Bot** — or double-click `stop.bat`
- Bot-only: `Ctrl+C`

## Configuration

All via environment variables, all optional:

| Variable | Default | What it does |
|---|---|---|
| `HEADLESS` | `false` | `true` = Chrome invisible, faster |
| `MAX_ACCOUNTS` | all | Process only first N accounts |
| `CHROME_PATH` | auto | Full path to chrome/chromium binary |
| `BOT_DEBUG` | `0` | `1` = screenshots on every state change |
| `BOT_DIR` | — | Override working dir (used by the exe) |

## How it works

- `openrouter_bot.js` — the bot. A state machine walks each account through:
  OpenRouter home → sign-in → Google OAuth (identifier → password → consent)
  → keys page → create key → save. Steals the key via the one-password widget,
  reads it from the DOM, appends to `api_keys.txt`.
- `launcher.js` — terminal UI. Menus via arrow keys, spawns the bot in
  background (headless) or foreground mode, live log tail, stop, profile reset.
- `stop.bat` / `stop.ps1` — one-click stop for the bot and its Chrome profiles.
- `chrome_profiles/<email>/` — per-account persistent Chrome profiles, so
  repeat runs skip login entirely (session reuse).

## Project layout

```
openrouter-autologin/
├── launcher.js            # terminal UI launcher
├── openrouter_bot.js      # the bot (state machine)
├── account.txt.example    # account list template
├── api_keys.txt           # output (created at runtime)
├── install.sh / .ps1      # curl / irm one-liner installers
├── stop.bat / stop.ps1    # one-click stop
└── package.json
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Chrome tidak ditemukan` | Install Chrome, or set `CHROME_PATH=/path/to/chrome` |
| `account.txt kosong` | Create it next to the bot, format `email\|password` |
| Google rejects login (500) | Too many attempts — let profiles cool down, retry later |
| Key not saved | Check `logs/bot.log`; account likely flagged; rerun |
| Stuck run | Double-click `stop.bat`, then rerun from the launcher |

## License

[MIT](LICENSE)
