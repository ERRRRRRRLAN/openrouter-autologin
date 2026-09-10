'use strict';
/* OpenRouter Auto-Key Bot - Launcher TUI (v2 - responsive)
 * Major fix: status is polled ASYNC (not sync per keypress); render uses
 * an ANSI scroll-region (no full clear -> no flicker); instant keypress.
 * CLI: --status --bg --fg --stop --reset-profiles
 * Must live in the same folder as openrouter_bot.js.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const IS_EXE = (() => { try { return require('node:sea').isSea(); } catch (_) { return false; } })();
const BOT_DIR = IS_EXE ? path.dirname(process.execPath) : __dirname;
const F = {
  bot: path.join(BOT_DIR, 'openrouter_bot.js'),
  accounts: path.join(BOT_DIR, 'account.txt'),
  keys: path.join(BOT_DIR, 'api_keys.txt'),
  api: path.join(BOT_DIR, 'api'),
  settings: path.join(BOT_DIR, 'settings.json'),
  pid: path.join(BOT_DIR, 'bot.pid'),
  log: path.join(BOT_DIR, 'logs', 'bot.log'),
  profiles: path.join(BOT_DIR, 'chrome_profiles'),
};
const C = {
  R: '\x1b[0m', B: '\x1b[1m', DIM: '\x1b[2m', INV: '\x1b[7m',
  CYN: '\x1b[36m', GRN: '\x1b[32m', YEL: '\x1b[33m', RED: '\x1b[31m',
};

const FORCE_UI = process.env.LAUNCHER_FORCE_UI === '1';

function resolveNode() {
  if (!IS_EXE) return process.execPath;
  try {
    const out = cp.spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true });
    const p = (out.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return 'node';
}
const NODE_EXE = resolveNode();

/* ---------- system helpers (all FAST) ---------- */

// Find the bot pid via the pid file first (instant), then tasklist fallback (~150ms)
function findBotPids() {
  const pids = [];
  try {
    const s = parseInt(fs.readFileSync(F.pid, 'utf8').trim(), 10);
    if (Number.isFinite(s) && s > 0) pids.push(s);
  } catch (_) {}
  if (pids.length) {
    // verify it is alive via tasklist (once, fast)
    const r = cp.spawnSync('tasklist', ['/FI', `PID eq ${pids[0]}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const alive = (r.stdout || '').includes('"' + pids[0] + '"');
    return alive ? pids : [];
  }
  return [];
}

function psSlow(cmd) {
  const r = cp.spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout || '' };
}

function killChromeBot() {
  const r = psSlow("Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*openrouter-autologin*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
  return r.code === 0;
}

function stopBot() {
  const pids = findBotPids();
  let killed = 0;
  for (const pid of pids) {
    const r = cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) killed++;
  }
  killChromeBot();
  try { fs.unlinkSync(F.pid); } catch (_) {}
  return { found: pids.length, killed };
}

// Anti-double-instance guard: pid file + any node process running the bot.
// Returns null when clear, or an error message when a bot is already running.
function checkBotRunning() {
  const existing = findBotPids();
  if (existing.length) return 'Bot already running (pid ' + existing.join(', ') + ')';
  try {
    const out = cp.spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*openrouter_bot.js*' }).Count"],
      { encoding: 'utf8', windowsHide: true });
    const cnt = parseInt((out.stdout || '0').trim(), 10);
    if (cnt > 0) return 'Bot already running in foreground mode (' + cnt + ' processes) - check another window / use Stop Bot first';
  } catch (_) {}
  return null;
}

function runBackground() {
  // Double-bot guard: check the pid file AND node processes running openrouter_bot.js
  const busy = checkBotRunning();
  if (busy) return { ok: false, msg: busy };
  if (!fs.existsSync(F.bot)) return { ok: false, msg: 'openrouter_bot.js not found in this folder' };
  // BACKGROUND = HEADLESS: the bot chrome never shows up (its UA is disguised as headful by the bot).
  const env = Object.assign({}, process.env, { HEADLESS: 'true' });
  const child = cp.spawn(NODE_EXE, [F.bot], {
    cwd: BOT_DIR, detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  try { fs.writeFileSync(F.pid, String(child.pid)); } catch (_) {}
  child.unref();
  return { ok: true, pid: child.pid };
}

/* ---------- key store: api/*.txt run files + legacy api_keys.txt ---------- */

// data rows of a key file: non-blank lines that are not '#' header comments
function dataRows(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((t) => t && !t.startsWith('#'));
  } catch (_) { return []; }
}

// email of one key row: 'date | email | key | k/N' (4 parts) or legacy 'email|key' (2 parts)
function rowEmail(t) {
  const p = t.split('|').map((x) => x.trim());
  const e = p.length >= 3 ? p[1] : p[0];
  return e ? e.toLowerCase() : '';
}

// keys   = total data rows across api/*.txt + legacy api_keys.txt lines
// runs  = number of files in api/
// done  = distinct emails in that union (accounts that have at least one key)
function readKeyStats() {
  const st = { files: [], runs: 0, keys: 0, done: 0, legacy: 0 };
  const emails = new Set();
  try { st.files = fs.readdirSync(F.api).filter((f) => f.endsWith('.txt')).sort(); } catch (_) { st.files = []; }
  st.runs = st.files.length;                                    // R = number of api/ files
  for (const f of st.files) {
    if (!f.startsWith('keys_')) continue;                       // saved keys live in keys_*.txt only (deleted_*.txt = sweep output, not saved keys)
    const rows = dataRows(path.join(F.api, f));
    st.keys += rows.length;
    for (const r of rows) { const e = rowEmail(r); if (e) emails.add(e); }
  }
  const legacy = dataRows(F.keys);
  st.legacy = legacy.length;
  st.keys += legacy.length;
  for (const r of legacy) { const e = rowEmail(r); if (e) emails.add(e); }
  st.done = emails.size;
  return st;
}

function currentKeysPerAccount() {
  try {
    const v = parseInt(JSON.parse(fs.readFileSync(F.settings, 'utf8')).keysPerAccount, 10);
    if (v >= 1 && v <= 5) return v;
  } catch (_) {}
  return 1;
}

/* ---------- status (async, cached; NOT called during render) ---------- */

const STAT = { pids: [], accounts: 0, pending: 0, keys: 0, runs: 0, done: 0, kpa: 1, profiles: 0, line: '', tail: [] };

async function refreshStat() {
  STAT.pids = findBotPids();
  STAT.kpa = currentKeysPerAccount();
  try {
    const lines = fs.readFileSync(F.accounts, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    STAT.accounts = lines.length;
    const ks = readKeyStats();
    STAT.keys = ks.keys;   // total key rows across api/*.txt + legacy api_keys.txt lines
    STAT.runs = ks.runs;   // number of files in api/
    STAT.done = ks.done;   // distinct emails in that union
    STAT.pending = Math.max(0, STAT.accounts - STAT.done);
  } catch (_) { STAT.accounts = 0; }
  try {
    STAT.profiles = fs.readdirSync(F.profiles).filter((d) => {
      try { return fs.statSync(path.join(F.profiles, d)).isDirectory(); } catch (_) { return false; }
    }).length;
  } catch (_) { STAT.profiles = 0; }
  // bot log tail (multi-line, for the live view in the menu) — read at most 8KB
  try {
    const fd = fs.openSync(F.log, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(8192, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const txt = buf.toString('utf8');
    const ls = txt.split(/\r?\n/).filter(Boolean);
    const tail = ls.slice(-8).map((s) => {
      let t = s.replace(/\[[\d\- :]+\]/g, '').trim();
      if (t.length > 96) t = '...' + t.slice(-93);
      return t;
    });
    STAT.tail = tail;
    STAT.line = tail[tail.length - 1] || '';
  } catch (_) { STAT.tail = []; STAT.line = ''; }
}

/* ---------- UI ---------- */

const MENU = [
  { id: 'bg',       label: 'Run Bot - Mode BACKGROUND', desc: 'runs hidden, log at logs\\bot.log' },
  { id: 'fg',       label: 'Run Bot - Mode FOREGROUND', desc: 'bot log streams right here (Ctrl+C to stop)' },
  { id: 'stop',     label: 'Stop Bot',                 desc: 'stop bot + bot chrome (safe anytime)' },
  { id: 'edit',     label: 'Edit account.txt',         desc: 'open notepad; press any key after saving' },
  { id: 'settings', label: 'Settings',                 desc: 'API keys per account' },
  { id: 'keys',     label: 'View API keys',            desc: 'key files in api\\ + latest keys' },
  { id: 'delkeys',  label: 'Delete ALL API keys',      desc: 'remove keys from ALL accounts (confirm first)' },
  { id: 'reset',    label: 'Reset Chrome Profiles',    desc: 'delete all chrome profiles (accounts must log in again)' },
  { id: 'quit',     label: 'Exit',                    desc: 'close the launcher' },
];
let sel = 0;
let mode = 'menu';
let confirmHandler = null;
let lastLines = 0; // number of lines rendered last (for a clean redraw)
const W = 78;

function line(ch) { return (ch || '-').repeat(W); }
function center(s) { const pad = Math.max(0, W - 2 - s.length); const l = Math.floor(pad / 2); return ' '.repeat(l) + s + ' '.repeat(pad - l) + '|'; }
function padTo(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

// render: ANSI "move to top + clear each line" — no full screen clear, no flicker
// DOUBLE HEADER BUG: the old version joined ALL elements with '\n' — cursor codes (\x1b[?25l,
// \x1b[NF) picked up newlines too, each render shifted ~2 lines down, stale headers remained.
// Fix: newline ONLY between content lines (\r\n), the cursor always ends at line start
// AFTER the frame -> lastLines = rows.length (no +1).
function writeScreen(lines) {
  const rows = [];
  for (const l of lines) rows.push('\x1b[2K' + l);            // clear line + write
  const extra = lastLines - lines.length;                     // erase leftover lines from the previous render
  if (extra > 0) for (let i = 0; i < extra; i++) rows.push('\x1b[2K');
  let pre = lastLines === 0 ? '\x1b[2J\x1b[H' : '\x1b[' + lastLines + 'F'; // full clear at start / move up to the top line of the previous render
  pre += '\x1b[?25l';                                        // hide the cursor while rendering
  process.stdout.write(pre + rows.join('\r\n') + '\r\n\x1b[?25h');
  // the cursor ends exactly at the start of the line AFTER the frame = rows.length
  lastLines = rows.length;
}

function menuLines() {
  const st = STAT;
  const running = st.pids.length > 0;
  const L = [];
  L.push(C.B + C.CYN + line('=') + C.R);
  L.push(C.B + C.CYN + '|' + center('OPENROUTER BOT - AUTO API KEY') + C.R);
  L.push(C.B + C.CYN + '|' + C.DIM + center(BOT_DIR.slice(0, W - 4)) + C.R);
  L.push(C.CYN + line('=') + C.R);
  L.push('  Status   : ' + (running ? C.GRN + C.B + 'BOT RUNNING (BACKGROUND)' + C.R + C.DIM + '  pid ' + st.pids.join(', ') + C.R : C.DIM + 'IDLE' + C.R));
  L.push('  Accounts : ' + st.accounts + ' total, ' + (st.pending > 0 ? C.YEL + st.pending + ' pending' + C.R : C.GRN + 'all done' + C.R));
  L.push('  Keys     : ' + st.keys + ' saved (' + st.runs + ' runs)');
  L.push('  Profiles : ' + st.profiles + ' chrome');
  if (running && st.tail && st.tail.length) {
    L.push(C.DIM + line('-') + C.R);
    L.push(C.B + '  BOT LOG (live):' + C.R);
    for (const t of st.tail) L.push(C.DIM + '  ' + t.slice(0, 72) + C.R);
  }
  L.push(C.DIM + line('-') + C.R);
  MENU.forEach((m, i) => {
    const active = i === sel;
    const marker = active ? C.B + '  > ' : '    ';
    const text = padTo((i + 1) + '. ' + m.label, 34);
    const body = active ? C.INV + C.CYN + ' ' + text + ' ' + C.R : text;
    L.push(marker + body);
    if (active) {
      let d = m.desc;
      if (m.id === 'settings') d = 'API keys per account (currently ' + (STAT.kpa || 1) + ')';
      if (d) L.push('      ' + C.DIM + d + C.R);
    }
  });
  L.push(C.DIM + line('-') + C.R);
  L.push('  [' + C.B + 'Up/Down' + C.R + '] select   [' + C.B + 'Enter' + C.R + '] run   [' + C.B + '1-9' + C.R + '] quick   [' + C.B + 'Q' + C.R + '] quit');
  L.push(C.CYN + line('=') + C.R);
  return L;
}

function draw() { writeScreen(menuLines()); }

function drawFullClear() { lastLines = 0; writeScreen(menuLines()); }

function showResult(title, ok, lines) {
  const L = [];
  L.push('');
  L.push(C.B + (ok ? C.GRN : C.RED) + line('=') + C.R);
  L.push(C.B + (ok ? C.GRN : C.RED) + '|' + center(title) + C.R);
  L.push(C.B + (ok ? C.GRN : C.RED) + line('=') + C.R);
  for (const l of lines) L.push('  ' + l);
  L.push('');
  L.push(C.DIM + '  [press any key to return to the menu]' + C.R);
  writeScreen(L);
  mode = 'result';
}

function showKeysScreen() {
  const ks = readKeyStats();
  const latest = ks.files.length ? ks.files[ks.files.length - 1] : '';
  const L = [];
  L.push('');
  L.push(C.B + C.CYN + line('=') + C.R);
  L.push(C.B + C.CYN + '|' + center('API KEYS (' + ks.keys + ' saved, ' + ks.runs + ' runs)') + C.R);
  L.push(C.B + C.CYN + line('=') + C.R);
  if (!ks.files.length && !ks.legacy) {
    L.push('  ' + C.DIM + '(no key files yet - run the bot to generate API keys)' + C.R);
  } else {
    L.push(C.B + '  Key files in api\\:' + C.R);
    const show = ks.files.slice(-10);
    for (const f of show) {
      L.push('  ' + padTo(f, 34) + C.DIM + String(dataRows(path.join(F.api, f)).length).padStart(4) + ' rows' + C.R);
    }
    if (ks.files.length > show.length) L.push('  ' + C.DIM + '... and ' + (ks.files.length - show.length) + ' more files' + C.R);
    if (ks.legacy) L.push('  ' + padTo('api_keys.txt (legacy)', 34) + C.DIM + String(ks.legacy).padStart(4) + ' lines' + C.R);
    if (latest) {
      const rows = dataRows(path.join(F.api, latest));
      const tail = rows.slice(-15);
      L.push('');
      L.push(C.B + '  Latest: ' + latest + C.R + C.DIM + '  (last ' + tail.length + ' of ' + rows.length + ' rows)' + C.R);
      for (const r of tail) {
        const p = r.split('|').map((x) => x.trim());
        if (p.length >= 3) {
          const when = p[0].length >= 19 ? p[0].slice(11) : p[0];
          const key = p[2];
          L.push('  ' + C.DIM + padTo(when, 10) + C.R + ' ' + C.B + padTo(p[1], 26) + C.R + C.YEL + key.slice(0, 20) + (key.length > 20 ? '...' : '') + C.R + (p[3] ? C.DIM + ' ' + p[3] + C.R : ''));
        } else {
          L.push('  ' + C.YEL + r.slice(0, 72) + C.R);
        }
      }
    }
  }
  L.push('');
  const base = '  [press any key to return to the menu]   dir: ';
  let dir = F.api;
  if (base.length + dir.length > W) dir = dir.length > W - base.length - 3 ? '...' + dir.slice(-(W - base.length - 3)) : dir.slice(0, W - base.length);
  L.push(C.DIM + base + dir + C.R);
  writeScreen(L);
  mode = 'result';
}

function askConfirm(title, lines) {
  const L = [];
  L.push('');
  L.push(C.B + C.YEL + line('=') + C.R);
  L.push(C.B + C.YEL + '|' + center(title) + C.R);
  L.push(C.B + C.YEL + line('=') + C.R);
  for (const l of lines) L.push('  ' + l);
  L.push('');
  L.push('  ' + C.B + 'Enter' + C.R + ' = confirm   ' + C.B + 'Esc' + C.R + ' / ' + C.B + 'N' + C.R + ' = cancel');
  L.push('');
  writeScreen(L);
  mode = 'confirm';
}

function backToMenu() { mode = 'menu'; sel = Math.min(sel, MENU.length - 1); drawFullClear(); }

/* ---------- menu actions ---------- */

function activate(id) {
  if (id === 'fg') {
    runForegroundBot();
  } else if (id === 'bg') {
    const r = runBackground();
    if (r.ok) {
      refreshStat();
      showResult('BOT STARTED (BACKGROUND)', true, [
        C.GRN + 'Bot running with pid ' + r.pid + C.R,
        'Log    : ' + F.log,
        C.DIM + 'Stop via menu 3 (Stop Bot) / stop.bat / launcher.exe --stop' + C.R,
      ]);
    } else {
      showResult('START FAILED', false, [C.RED + r.msg + C.R]);
    }
  } else if (id === 'stop') {
    const r = stopBot();
    refreshStat();
    showResult('STOP BOT', true, [
      'Bot processes found : ' + r.found,
      'Stopped             : ' + r.killed,
      'Chrome bot          : cleaned',
    ]);
  } else if (id === 'edit') {
    try { cp.spawn('cmd', ['/c', 'start', '', 'notepad.exe', F.accounts], { detached: true, stdio: 'ignore' }); } catch (_) {}
    showResult('EDIT ACCOUNT.TXT', true, [
      'Notepad opened for account.txt',
      C.DIM + 'After editing + saving, close notepad then press any key.' + C.R,
    ]);
  } else if (id === 'settings') {
    showSettingsPrompt();
  } else if (id === 'keys') {
    showKeysScreen();
  } else if (id === 'delkeys') {
    askDeleteAll();
  } else if (id === 'reset') {
    let n = 0;
    try { n = fs.readdirSync(F.profiles).filter((d) => { try { return fs.statSync(path.join(F.profiles, d)).isDirectory(); } catch (_) { return false; } }).length; } catch (_) {}
    if (findBotPids().length) {
      showResult('RESET DENIED', false, [C.RED + 'Bot is running — use Stop Bot first' + C.R]);
    } else if (n === 0) {
      showResult('RESET CHROME PROFILES', true, ['No profiles to delete']);
    } else {
      askConfirm('RESET CHROME PROFILES?', [
        C.YEL + String(n) + ' chrome profiles will be PERMANENTLY DELETED.' + C.R,
        'All accounts will have to sign up/log in again.',
      ]);
      confirmHandler = () => {
        try { fs.rmSync(F.profiles, { recursive: true, force: true }); } catch (_) {}
        fs.mkdirSync(F.profiles, { recursive: true });
        refreshStat();
        showResult('RESET DONE', true, ['Chrome profiles deleted. Accounts will log in again when the bot runs.']);
      };
    }
  } else if (id === 'quit') {
    shutdown();
  }
}

function denyRun(msg) {
  // CLI (no TTY): print + exit; TUI: red result screen (any key returns to the menu)
  if (!process.stdout.isTTY && !FORCE_UI) { console.log(msg); process.exit(1); }
  showResult('START DENIED', false, [C.RED + msg + C.R]);
}

function runBotAttached(envExtra, banner) {
  // The bot runs DIRECTLY in this window (not a separate minimized window —
  // the old `start /MIN` + windowsHide approach closed the launcher and hid the bot window,
  // looking like "the bot isn't running"). The user presses Ctrl+C to stop.
  // spawnSync blocks the event loop, so the async menu redraw can never trash this screen.
  process.stdin.pause();
  try { process.stdin.setRawMode(false); } catch (_) {}
  try { process.stdout.write('\x1b[?25h\x1b[2J\x1b[H\x1b[0m'); } catch (_) {}
  try { fs.unlinkSync(F.pid); } catch (_) {}
  console.log(banner);
  const t0 = Date.now();
  const env = envExtra ? Object.assign({}, process.env, envExtra) : process.env;
  try {
    const r = cp.spawnSync(NODE_EXE, [F.bot], { stdio: 'inherit', cwd: BOT_DIR, env });
    console.log('\n=== BOT FINISHED (exit ' + (r.status === null ? 'killed' : r.status) + ', ' + Math.round((Date.now() - t0) / 1000) + 's) ===');
    console.log('Press any key to return to the menu...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => { backToMenu(); });
  } catch (e) {
    console.log('FAILED to run bot: ' + (e && e.message));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => { backToMenu(); });
  }
}

function runForegroundBot() {
  // anti-double-instance guard: pid file + any node process running the bot
  const busy = checkBotRunning();
  if (busy) { denyRun(busy); return; }
  if (!fs.existsSync(F.bot)) { denyRun('openrouter_bot.js not found in this folder'); return; }
  runBotAttached(null, '=== BOT FOREGROUND — log streams here. Ctrl+C = stop. ===');
}

function runDeleteAll() {
  // Delete-all sweep: attached (visible) bot run with BOT_MODE=DELETE_ALL
  const busy = checkBotRunning();
  if (busy) { denyRun(busy); return; }
  if (!fs.existsSync(F.bot)) { denyRun('openrouter_bot.js not found in this folder'); return; }
  runBotAttached({ BOT_MODE: 'DELETE_ALL' },
    '=== DELETE ALL API KEYS — sweep runs here. Ctrl+C = stop. ===' + '\n' +
    '=== Keys are removed on openrouter.ai. Local files in api/ are KEPT. ===');
  refreshStat();
}

function askDeleteAll() {
  // confirm FIRST (Enter = confirm / Esc = cancel), only then run the sweep
  if (!fs.existsSync(F.bot)) {
    showResult('DELETE ALL API KEYS', false, [C.RED + 'openrouter_bot.js not found in this folder' + C.R]);
    return;
  }
  askConfirm('DELETE ALL API KEYS?', [
    C.RED + C.B + 'Delete ALL API keys from ALL OpenRouter accounts?' + C.R,
    'Keys are removed on openrouter.ai.',
    'Local files in api/ are KEPT.',
  ]);
  confirmHandler = () => { runDeleteAll(); };
}

function showSettingsPrompt() {
  // pause the TUI (raw mode off, key handler off) and ask via readline
  mode = 'prompt';
  process.stdin.pause();
  try { process.stdin.setRawMode(false); } catch (_) {}
  process.stdin.removeListener('data', onKey);
  try { process.stdout.write('\x1b[?25h\x1b[2J\x1b[H\x1b[0m'); } catch (_) {}
  console.log('=== SETTINGS ===');
  const cur = currentKeysPerAccount();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('API keys per account [1-5] (current ' + cur + '): ', (ans) => {
    rl.close();
    const v = Number(String(ans == null ? '' : ans).trim());
    if (Number.isInteger(v) && v >= 1 && v <= 5) {
      try { fs.writeFileSync(F.settings, JSON.stringify({ keysPerAccount: v }, null, 2) + '\n'); } catch (_) {}
      STAT.kpa = v;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    backToMenu();
  });
}

/* ---------- keyboard ---------- */

let keyBuf = '';
// dispatchKey: the action for ONE final key (arrow seq / plain char / ctrl).
function dispatchKey(k) {
  if (k === '\x03') { shutdown(); return; }
  if (mode === 'menu') {
    if (k === '\x1b[A') { sel = (sel + MENU.length - 1) % MENU.length; draw(); return; }
    if (k === '\x1b[B') { sel = (sel + 1) % MENU.length; draw(); return; }
    if (k === '\r') { activate(MENU[sel].id); return; }
    if (k === 'q' || k === 'Q') { shutdown(); return; }
    const n = parseInt(k, 10);
    if (n >= 1 && n <= MENU.length) { sel = n - 1; draw(); activate(MENU[n - 1].id); }
  } else if (mode === 'result') {
    backToMenu();
  } else if (mode === 'confirm') {
    if (k === '\r' || k === 'y' || k === 'Y') { const h = confirmHandler; confirmHandler = null; if (h) h(); } // Enter = confirm
    else if (k === 'n' || k === 'N' || k === '\x1b') { confirmHandler = null; backToMenu(); }
  }
}
// onKey: split the raw chunk into final keys FIRST (batched arrow keys from
// pty/conhost often arrive as 1 chunk holding several \x1b[A/B at once —
// the old parser collapsed 4 arrows into 1, losing navigation moves). Then dispatch one by one.
function onKey(chunk) {
  let k = (typeof chunk === 'string' ? chunk : chunk.toString('binary'));
  if (keyBuf) { k = keyBuf + k; keyBuf = ''; }
  while (k.length) {
    if (k.startsWith('\x1b[')) {
      // wait for the complete CSI sequence (\x1b[ ... final letter)
      const m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(k); // '~' = final byte of PgUp/PgDn/Del (\x1b[5~ etc)
      if (!m) {
        // incomplete (e.g. just '\x1b[') — buffer it; but if it grows too long with no
        // match, the sequence is broken (paste/garbage) — drop it so it doesn't swallow the next key
        if (k.length > 8) { return; }
        keyBuf = k; return;
      }
      const seq = m[0];
      k = k.slice(seq.length);
      if (seq === '\x1b[A' || seq === '\x1b[B') dispatchKey(seq);
      continue; // other seqs (C/D/Home/5~) are ignored, DON'T leak their leftover chars
    }
    if (k.startsWith('\x1b')) {
      if (k.length === 1) { keyBuf = k; return; } // lone Esc: wait for 1 more char (a sequence, or a real Esc)
      k = k.slice(1); dispatchKey('\x1b'); continue; // \x1b + other char = treat as a lone Esc first
    }
    const ch = k[0];
    k = k.slice(1);
    if (ch === '\r') {
      if (k.startsWith('\n')) k = k.slice(1); // CRLF = ONE Enter
      dispatchKey('\r'); continue;
    }
    if (ch === '\n') { dispatchKey('\r'); continue; }
    dispatchKey(ch);
  }
}

function shutdown() {
  try { process.stdout.write('\x1b[?25h\x1b[0m\n'); } catch (_) {}
  try { process.stdin.setRawMode(false); } catch (_) {}
  process.exit(0);
}

async function interactive() {
  if (!process.stdout.isTTY && !FORCE_UI) {
    console.log('Interactive UI requires a terminal. CLI options: --status | --bg | --fg | --stop | --reset-profiles');
    process.exit(0);
  }
  try { process.stdin.setRawMode(true); } catch (_) {}
  process.stdin.resume();
  process.stdin.setEncoding('binary');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('data', onKey);

  await refreshStat();          // first status before rendering
  drawFullClear();

  // async status refresh every 2 s — never blocks keypress
  const timer = setInterval(async () => {
    if (mode !== 'menu') return;
    try { await refreshStat(); } catch (_) {}
    if (mode === 'menu') draw();
  }, 2000);

  process.on('exit', () => clearInterval(timer));
}

/* ---------- CLI ---------- */

function cliStatus() {
  const pids = findBotPids();
  const ks = readKeyStats();
  let acc = 0; try { acc = fs.readFileSync(F.accounts, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length; } catch (_) {}
  console.log(`bot      : ${pids.length ? 'RUNNING (pid ' + pids.join(', ') + ')' : 'IDLE'}`);
  console.log(`accounts : ${acc} total, ${Math.max(0, acc - ks.done)} pending`);
  console.log(`keys     : ${ks.keys} saved (${ks.runs} runs)`);
}
function cliBg() { const r = runBackground(); console.log(r.ok ? `bot running in background, pid ${r.pid} (log: ${F.log})` : r.msg); process.exit(r.ok ? 0 : 1); }
function cliStop() { const r = stopBot(); console.log(`node bot processes found ${r.found}, killed ${r.killed}; bot chrome cleaned`); }
function cliReset() {
  if (findBotPids().length) { console.log('stop the bot first (--stop)'); process.exitCode = 1; return; }
  try { fs.rmSync(F.profiles, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(F.profiles, { recursive: true });
  console.log('chrome_profiles deleted');
}
function cliFg() { runForegroundBot(); }

async function main() {
  const a = process.argv[2] || '';
  if (a === '--status') return cliStatus();
  if (a === '--bg') return cliBg();
  if (a === '--stop') return cliStop();
  if (a === '--reset-profiles') return cliReset();
  if (a === '--fg') return cliFg();
  await interactive();
}

main().catch((e) => { console.error('launcher error:', e && e.message); process.exit(1); });
