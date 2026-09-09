'use strict';
/* OpenRouter Auto-Key Bot - Launcher TUI (v2 - responsif)
 * Fix berat: status dipoll ASYNC (bukan sync per keypress); render pakai
 * scroll-region ANSI (tanpa clear penuh -> tanpa flicker); keypress instan.
 * CLI: --status --bg --fg --stop --reset-profiles
 * Harus berada di folder yang sama dengan openrouter_bot.js.
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

/* ---------- helper sistem (semua CEPAT) ---------- */

// Cari pid bot via file pid dulu (instan), baru tasklist fallback (~150ms)
function findBotPids() {
  const pids = [];
  try {
    const s = parseInt(fs.readFileSync(F.pid, 'utf8').trim(), 10);
    if (Number.isFinite(s) && s > 0) pids.push(s);
  } catch (_) {}
  if (pids.length) {
    // verifikasi hidup via tasklist (satu kali, cepat)
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

function runBackground() {
  // Guard anti bot dobel: cek pid file DAN proses node yang menjalankan openrouter_bot.js
  const existing = findBotPids();
  if (existing.length) return { ok: false, msg: 'Bot sudah jalan (pid ' + existing.join(', ') + ')' };
  try {
    const out = cp.spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*openrouter_bot.js*' }).Count"],
      { encoding: 'utf8', windowsHide: true });
    const cnt = parseInt((out.stdout || '0').trim(), 10);
    if (cnt > 0) return { ok: false, msg: 'Bot sudah jalan di mode foreground (' + cnt + ' proses) - cek window lain / Stop Bot dulu' };
  } catch (_) {}
  if (!fs.existsSync(F.bot)) return { ok: false, msg: 'openrouter_bot.js tidak ditemukan di folder ini' };
  // BACKGROUND = HEADLESS: chrome bot tidak muncul (UA disamarkan headful oleh bot).
  const env = Object.assign({}, process.env, { HEADLESS: 'true' });
  const child = cp.spawn(NODE_EXE, [F.bot], {
    cwd: BOT_DIR, detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  try { fs.writeFileSync(F.pid, String(child.pid)); } catch (_) {}
  child.unref();
  return { ok: true, pid: child.pid };
}

/* ---------- status (async, di-cache; TIDAK dipanggil saat render) ---------- */

const STAT = { pids: [], accounts: 0, pending: 0, keys: 0, profiles: 0, line: '', tail: [] };

async function refreshStat() {
  STAT.pids = findBotPids();
  try {
    const lines = fs.readFileSync(F.accounts, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    STAT.accounts = lines.length;
    const doneSet = new Set();
    try {
      for (const l of fs.readFileSync(F.keys, 'utf8').split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        const i = t.indexOf('|');
        if (i > 0) doneSet.add(t.slice(0, i).trim().toLowerCase());
      }
    } catch (_) {}
    STAT.keys = doneSet.size;
    STAT.pending = lines.filter((l) => {
      const e = l.split('|')[0].trim().toLowerCase();
      return !doneSet.has(e);
    }).length;
  } catch (_) { STAT.accounts = 0; }
  try {
    STAT.profiles = fs.readdirSync(F.profiles).filter((d) => {
      try { return fs.statSync(path.join(F.profiles, d)).isDirectory(); } catch (_) { return false; }
    }).length;
  } catch (_) { STAT.profiles = 0; }
  // ekor log bot (multi-baris utk live view di menu) — baca maks 8KB
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
  { id: 'bg',    label: 'Run Bot - Mode BACKGROUND',  desc: 'bot jalan tersembunyi, log di logs\\bot.log' },
  { id: 'fg',    label: 'Run Bot - Mode FOREGROUND',  desc: 'log bot tampil langsung di sini (Ctrl+C stop)' },
  { id: 'stop',  label: 'Stop Bot',                  desc: 'hentikan bot + chrome bot (aman dipakai kapan saja)' },
  { id: 'edit',  label: 'Edit account.txt',          desc: 'buka notepad; setelah disimpan tekan apa pun' },
  { id: 'keys',  label: 'Lihat api_keys.txt',         desc: 'daftar akun + API key yang sudah tersimpan' },
  { id: 'reset', label: 'Reset Chrome Profiles',     desc: 'hapus semua profil chrome (login ulang semua akun)' },
  { id: 'quit',  label: 'Keluar',                    desc: 'tutup launcher' },
];
let sel = 0;
let mode = 'menu';
let confirmHandler = null;
let lastLines = 0; // jumlah baris terakhir yang dirender (untuk redraw bersih)
const W = 78;

function line(ch) { return (ch || '-').repeat(W); }
function center(s) { const pad = Math.max(0, W - 2 - s.length); const l = Math.floor(pad / 2); return ' '.repeat(l) + s + ' '.repeat(pad - l) + '|'; }
function padTo(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

// render: ANSI "move to top + clear each line" — tanpa clear layar penuh, tanpa flicker
// BUG HEADER DOBEL: versi lama join SEMUA elemen dengan '\n' — kode kursor (\x1b[?25l,
// \x1b[NF) ikut kena newline, tiap render geser ~2 baris ke bawah, header lama tersisa.
// Fix: newline HANYA antar baris konten (\r\n), kursor selalu berakhir di awal baris
// SETELAH frame -> lastLines = rows.length (tanpa +1).
function writeScreen(lines) {
  const rows = [];
  for (const l of lines) rows.push('\x1b[2K' + l);            // clear line + tulis
  const extra = lastLines - lines.length;                     // hapus baris sisa render lama
  if (extra > 0) for (let i = 0; i < extra; i++) rows.push('\x1b[2K');
  let pre = lastLines === 0 ? '\x1b[2J\x1b[H' : '\x1b[' + lastLines + 'F'; // clear penuh di awal / naik ke baris teratas render lama
  pre += '\x1b[?25l';                                        // sembunyikan kursor saat render
  process.stdout.write(pre + rows.join('\r\n') + '\r\n\x1b[?25h');
  // kursor berakhir tepat di awal baris SETELAH frame = rows.length
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
  L.push('  Status : ' + (running ? C.GRN + C.B + 'BOT RUNNING (BACKGROUND)' + C.R + C.DIM + '  pid ' + st.pids.join(', ') + C.R : C.DIM + 'MENGANGGUR' + C.R));
  L.push('  Akun   : ' + st.accounts + ' total, ' + (st.pending > 0 ? C.YEL + st.pending + ' belum diproses' + C.R : C.GRN + 'semua selesai' + C.R));
  L.push('  Key    : ' + st.keys + ' tersimpan');
  L.push('  Profil : ' + st.profiles + ' chrome');
  if (running && st.tail && st.tail.length) {
    L.push(C.DIM + line('-') + C.R);
    L.push(C.B + '  LOG BOT (live):' + C.R);
    for (const t of st.tail) L.push(C.DIM + '  ' + t.slice(0, 72) + C.R);
  }
  L.push(C.DIM + line('-') + C.R);
  MENU.forEach((m, i) => {
    const active = i === sel;
    const marker = active ? C.B + '  > ' : '    ';
    const text = padTo((i + 1) + '. ' + m.label, 34);
    const body = active ? C.INV + C.CYN + ' ' + text + ' ' + C.R : text;
    L.push(marker + body);
    if (active && m.desc) L.push('      ' + C.DIM + m.desc + C.R);
  });
  L.push(C.DIM + line('-') + C.R);
  L.push('  [' + C.B + 'Up/Down' + C.R + '] pilih   [' + C.B + 'Enter' + C.R + '] jalankan   [' + C.B + '1-7' + C.R + '] cepat   [' + C.B + 'Q' + C.R + '] keluar');
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
  L.push(C.DIM + '  [tekan tombol apa pun untuk kembali ke menu]' + C.R);
  writeScreen(L);
  mode = 'result';
}

function showKeysScreen() {
  let rows = [];
  try { rows = fs.readFileSync(F.keys, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch (_) {}
  const L = [];
  L.push('');
  L.push(C.B + C.CYN + line('=') + C.R);
  L.push(C.B + C.CYN + '|' + center('API KEYS (' + rows.length + ' akun)') + C.R);
  L.push(C.B + C.CYN + line('=') + C.R);
  if (!rows.length) L.push('  ' + C.DIM + '(api_keys.txt kosong / belum ada)' + C.R);
  rows.slice(0, 40).forEach((r) => {
    const i = r.indexOf('|');
    const email = i > 0 ? r.slice(0, i) : '(?)';
    const key = i > 0 ? r.slice(i + 1) : '';
    L.push('  ' + C.B + padTo(email, 28) + C.R + C.YEL + key + C.R);
  });
  if (rows.length > 40) L.push('  ' + C.DIM + '... dan ' + (rows.length - 40) + ' lagi (buka file untuk semua)' + C.R);
  L.push('');
  L.push(C.DIM + '  [tekan tombol apa pun untuk kembali ke menu]   file: ' + F.keys + C.R);
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
  L.push('  ' + C.B + 'Y' + C.R + ' = lanjut   ' + C.B + 'N' + C.R + ' / Esc = batal');
  L.push('');
  writeScreen(L);
  mode = 'confirm';
}

function backToMenu() { mode = 'menu'; sel = Math.min(sel, MENU.length - 1); drawFullClear(); }

/* ---------- aksi menu ---------- */

function activate(id) {
  if (id === 'fg') {
    runForegroundBot();
  } else if (id === 'bg') {
    const r = runBackground();
    if (r.ok) {
      refreshStat();
      showResult('BOT JALAN (BACKGROUND)', true, [
        C.GRN + 'Bot berjalan dengan pid ' + r.pid + C.R,
        'Log    : ' + F.log,
        C.DIM + 'Stop via menu 3 (Stop Bot) / stop.bat / launcher.exe --stop' + C.R,
      ]);
    } else {
      showResult('GAGAL START', false, [C.RED + r.msg + C.R]);
    }
  } else if (id === 'stop') {
    const r = stopBot();
    refreshStat();
    showResult('STOP BOT', true, [
      'Proses bot ditemukan : ' + r.found,
      'Dihentikan          : ' + r.killed,
      'Chrome bot          : dibersihkan',
    ]);
  } else if (id === 'edit') {
    try { cp.spawn('cmd', ['/c', 'start', '', 'notepad.exe', F.accounts], { detached: true, stdio: 'ignore' }); } catch (_) {}
    showResult('EDIT ACCOUNT.TXT', true, [
      'Notepad dibuka untuk account.txt',
      C.DIM + 'Setelah selesai edit + save, tutup notepad lalu tekan apa pun.' + C.R,
    ]);
  } else if (id === 'keys') {
    showKeysScreen();
  } else if (id === 'reset') {
    let n = 0;
    try { n = fs.readdirSync(F.profiles).filter((d) => { try { return fs.statSync(path.join(F.profiles, d)).isDirectory(); } catch (_) { return false; } }).length; } catch (_) {}
    if (findBotPids().length) {
      showResult('RESET DITOLAK', false, [C.RED + 'Bot sedang jalan — Stop Bot dulu' + C.R]);
    } else if (n === 0) {
      showResult('RESET CHROME PROFILES', true, ['Tidak ada profil untuk dihapus']);
    } else {
      askConfirm('RESET CHROME PROFILES?', [
        C.YEL + String(n) + ' profil chrome akan DIHAPUS PERMANEN.' + C.R,
        'Semua akun harus signup/login ulang.',
      ]);
      confirmHandler = () => {
        try { fs.rmSync(F.profiles, { recursive: true, force: true }); } catch (_) {}
        fs.mkdirSync(F.profiles, { recursive: true });
        refreshStat();
        showResult('RESET SELESAI', true, ['Profil chrome dihapus. Akun akan login ulang saat bot jalan.']);
      };
    }
  } else if (id === 'quit') {
    shutdown();
  }
}

function runForegroundBot() {
  // Bot jalan LANGSUNG di window ini (bukan window terpisah yang minimize —
  // dulu pakai `start /MIN` + windowsHide: launcher tertutup, window bot tersembunyi,
  // kelihatan seperti "bot tidak jalan"). User tekan Ctrl+C untuk stop.
  process.stdin.pause();
  try { process.stdin.setRawMode(false); } catch (_) {}
  try { process.stdout.write('\x1b[?25h\x1b[2J\x1b[H\x1b[0m'); } catch (_) {}
  try { fs.unlinkSync(F.pid); } catch (_) {}
  console.log('=== BOT FOREGROUND — log tampil di sini. Ctrl+C = stop. ===');
  const t0 = Date.now();
  try {
    const r = cp.spawnSync(NODE_EXE, [F.bot], { stdio: 'inherit', cwd: BOT_DIR, env: process.env });
    console.log('\n=== BOT SELESAI (exit ' + (r.status === null ? 'killed' : r.status) + ', ' + Math.round((Date.now() - t0) / 1000) + 's) ===');
    console.log('Tekan apa pun untuk kembali ke menu...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => { backToMenu(); });
  } catch (e) {
    console.log('GAGAL menjalankan bot: ' + (e && e.message));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => { backToMenu(); });
  }
}

/* ---------- keyboard ---------- */

let keyBuf = '';
// dispatchKey: aksi untuk SATU tombol final (seq arrow / karakter biasa / ctrl).
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
    if (k === 'y' || k === 'Y') { const h = confirmHandler; confirmHandler = null; if (h) h(); }
    else if (k === 'n' || k === 'N' || k === '\x1b') { confirmHandler = null; backToMenu(); }
  }
}
// onKey: pecah chunk mentah jadi tombol-tombol final DULU (batched arrow keys dari
// pty/conhost sering sampai sebagai 1 chunk berisi beberapa \x1b[A/B sekaligus —
// parser lama collapse 4 arrow jadi 1, gerakan navigasi hilang). Lalu dispatch satu-satu.
function onKey(chunk) {
  let k = (typeof chunk === 'string' ? chunk : chunk.toString('binary'));
  if (keyBuf) { k = keyBuf + k; keyBuf = ''; }
  while (k.length) {
    if (k.startsWith('\x1b[')) {
      // tunggu sequence CSI lengkap (\x1b[ ... huruf final)
      const m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(k); // '~' = final PgUp/PgDn/Del (\x1b[5~ dsb)
      if (!m) {
        // belum lengkap (mis. '\x1b[' saja) — buffer; tapi kalau terlalu panjang tanpa
        // match berarti sequence rusak (paste/kacau) — buang supaya tidak menelan key berikutnya
        if (k.length > 8) { return; }
        keyBuf = k; return;
      }
      const seq = m[0];
      k = k.slice(seq.length);
      if (seq === '\x1b[A' || seq === '\x1b[B') dispatchKey(seq);
      continue; // seq lain (C/D/Home/5~) diabaikan, JANGAN bocor sisa charnya
    }
    if (k.startsWith('\x1b')) {
      if (k.length === 1) { keyBuf = k; return; } // Esc tunggal: tunggu 1 char berikut (seq atau memang Esc)
      k = k.slice(1); dispatchKey('\x1b'); continue; // \x1b + char lain = Esc tunggal dulu
    }
    const ch = k[0];
    k = k.slice(1);
    if (ch === '\r') {
      if (k.startsWith('\n')) k = k.slice(1); // CRLF = SATU Enter
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
    console.log('UI interaktif butuh terminal. Opsi CLI: --status | --bg | --fg | --stop | --reset-profiles');
    process.exit(0);
  }
  try { process.stdin.setRawMode(true); } catch (_) {}
  process.stdin.resume();
  process.stdin.setEncoding('binary');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('data', onKey);

  await refreshStat();          // status pertama sebelum render
  drawFullClear();

  // refresh status async tiap 2 dtk — TIDAK memblokir keypress
  const timer = setInterval(async () => {
    if (mode !== 'menu') return;
    try { await refreshStat(); } catch (_) {}
    if (mode === 'menu') draw();
  }, 2000);

  process.on('exit', () => clearInterval(timer));
}

/* ---------- CLI ---------- */

function cliStatus() {
  findBotPids(); // refresh
  const pids = findBotPids();
  let keys = 0; try { keys = fs.readFileSync(F.keys, 'utf8').split(/\r?\n/).filter((l) => l.includes('|')).length; } catch (_) {}
  let acc = 0; try { acc = fs.readFileSync(F.accounts, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length; } catch (_) {}
  console.log(`bot      : ${pids.length ? 'BERJALAN (pid ' + pids.join(', ') + ')' : 'MENGANGGUR'}`);
  console.log(`akun     : ${acc} total, ${Math.max(0, acc - keys)} belum diproses`);
  console.log(`keys     : ${keys}`);
}
function cliBg() { const r = runBackground(); console.log(r.ok ? `bot jalan background, pid ${r.pid} (log: ${F.log})` : r.msg); process.exit(r.ok ? 0 : 1); }
function cliStop() { const r = stopBot(); console.log(`node bot ditemukan ${r.found}, killed ${r.killed}; chrome bot dibersihkan`); }
function cliReset() {
  if (findBotPids().length) { console.log('stop bot dulu (--stop)'); process.exitCode = 1; return; }
  try { fs.rmSync(F.profiles, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(F.profiles, { recursive: true });
  console.log('chrome_profiles dihapus');
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
