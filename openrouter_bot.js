'use strict';

/*
 * OpenRouter Auto Signup Bot
 * Alur: openrouter.ai -> Sign Up -> Google icon -> Google OAuth -> API key (copy icon)
 *       -> onboarding questions (role, name, referral, dll) -> done.
 * Arsitektur: state machine (mirip google_login_bot.js) + stealth + Chrome asli headful.
 * Setiap transisi state menyimpan screenshot + HTML dump ke logs/ untuk audit visual.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const CONFIG = {
  accountsFile: 'account.txt',
  apiKeysFile: 'api_keys.txt',
  homeUrl: 'https://openrouter.ai/',
  keysUrl: 'https://openrouter.ai/settings/keys',
  headless: process.env.HEADLESS === 'true',
  gotoTimeoutMs: 45000,
  detectTimeoutMs: 3000,
  actionTimeoutMs: 6000,
  typingDelay: [5, 12],
  maxStateMachineSteps: 40,
  oauthTimeoutMs: 90000, // total budget OAuth
  interAccountDelayMs: [300, 600],
  logRotateBytes: 10 * 1024 * 1024,
};

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-infobars',
  '--disable-features=site-per-process,Translate',
  '--disable-blink-features=AutomationControlled',
  '--disable-session-crashed-bubble',
  '--no-first-run',
  '--no-default-browser-check',
  '--lang=en-US',
  '--window-size=1366,850',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

function nowTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const fileTs = () => nowTs().replace(/[-: ]/g, '');
const safeName = (s) => s.replace(/[^a-zA-Z0-9@._-]/g, '_');

let __logWrites = 0;
function log(tag, state, detail) {
  const line = `[${nowTs()}] [${tag}] [${state}] -> ${detail}`;
  console.log(line);
  try {
    const logPath = path.join('logs', 'bot.log');
    // rotasi: >10MB -> bot.log.old (cek tiap 50 baris, murah)
    if ((++__logWrites % 50) === 1) {
      try {
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > CONFIG.logRotateBytes) {
          try { fs.unlinkSync(logPath + '.old'); } catch (_) {}
          fs.renameSync(logPath, logPath + '.old');
        }
      } catch (_) {}
    }
    fs.appendFileSync(logPath, line + '\n');
  } catch (_) {}
}

function ensureDirs() {
  for (const d of ['logs', path.join('logs', 'screenshots'), path.join('logs', 'html')]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

function parseAccountLine(line) {
  // Dukung dua format: "email|password" dan "email:password".
  // Pilih separator yang muncul SETELAH bagian email (biar aman walau password mengandung ':' atau '|').
  const at = line.indexOf('@');
  if (at < 0) return null;
  const afterAt = line.slice(at);
  let i = afterAt.indexOf('|');
  let sep = '|';
  if (i < 0) { i = afterAt.indexOf(':'); sep = ':'; }
  if (i < 0) return null;
  const email = line.slice(0, at + i).trim();
  const password = line.slice(at + i + 1).trim();
  if (!email.includes('@') || !password) return null;
  return { email, password };
}

function readAccounts() {
  const accounts = [];
  try {
    if (!fs.existsSync(CONFIG.accountsFile)) return accounts;
    for (const raw of fs.readFileSync(CONFIG.accountsFile, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const acc = parseAccountLine(line);
      if (acc) accounts.push(acc);
    }
  } catch (_) {}
  return accounts;
}

function loadExistingEmails() {
  // Skip hanya jika akun PASTI sudah sukses:
  //  1) ada di api_keys.txt (key tersimpan), ATAU
  //  2) baris terakhirnya di logs/results.jsonl berstatus ok=true.
  // FAIL/GAGAL tidak skip -> di-retry run berikutnya (mulai dari line pertama account.txt).
  const existing = new Set();
  try {
    if (fs.existsSync(CONFIG.apiKeysFile)) {
      for (const raw of fs.readFileSync(CONFIG.apiKeysFile, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const i = line.indexOf('|');
        if (i > 0) existing.add(line.slice(0, i).trim().toLowerCase());
      }
    }
  } catch (_) {}
  return existing;
}

function recordResult(email, ok, stage, detail) {
  try {
    fs.appendFileSync(
      'logs/results.jsonl',
      JSON.stringify({ ts: new Date().toISOString(), email, ok, stage, detail }) + '\n'
    );
  } catch (_) {}
}

function appendApiKey(email, apiKey) {
  try {
    // replace baris lama untuk email yang sama (re-run -> key baru, tanpa duplikat)
    let rows = [];
    try { rows = fs.readFileSync(CONFIG.apiKeysFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) {}
    const kept = rows.filter((r) => r.split('|')[0].trim().toLowerCase() !== email.toLowerCase());
    kept.push(`${email}|${apiKey}`);
    fs.writeFileSync(CONFIG.apiKeysFile, kept.join('\n') + '\n');
    log(email, 'SAVED', `API key tersimpan ke ${CONFIG.apiKeysFile}`);
  } catch (e) { log(email, 'ERROR', `Gagal simpan API key: ${e.message}`); }
}

function resolveChromeExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

async function captureArtifacts(page, email, state, prefix) {
  // Jalur NORMAL (bukan error) tidak menulis screenshot/HTML — hemat I/O & disk.
  // Error/stuck tetap terekam. Set BOT_DEBUG=1 untuk mencatat semuanya.
  const isNormalFlow = state === 'HOME' || state === 'OAUTH_END' || /^ONBOARDING_R\d+$/.test(state);
  if (isNormalFlow && process.env.BOT_DEBUG !== '1') return;
  const tag = `${safeName(email)}_${fileTs()}`;
  const shot = path.join('logs', 'screenshots', `${(prefix || 'error_')}${state}_${tag}.png`);
  const html = path.join('logs', 'html', `dump_${state}_${tag}.html`);
  try { await page.screenshot({ path: shot }); } catch (_) {}
  try { fs.writeFileSync(html, await page.content()); } catch (_) {}
}

// ===================== STATE DETECTOR =====================

async function classifyOpenRouter(page) {
  return page
    .evaluate(() => {
      const url = location.href.toLowerCase();
      const txt = ((document.body && document.body.innerText) || '').toLowerCase();
      // Guard: hanya klasifikasi kalau benar-benar di openrouter.ai (URL Google memuat
      // 'openrouter.ai' di query param continue — jangan sampai salah klasifikasi)
      if (location.hostname !== 'openrouter.ai' && !location.hostname.endsWith('.openrouter.ai')) {
        return 'OR_NOT_OPENROUTER';
      }
      const has = (s) => { try { return !!document.querySelector(s); } catch (_) { return false; } };
      const hasVisible = (s) => {
        try {
          const el = document.querySelector(s);
          if (!el) return false;
          const st = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      };

      // Sudah login di keys page: ada tombol create key / tabel keys
      if (url.includes('/settings/keys') || url.includes('/keys')) return 'OR_KEYS_PAGE';
      if (url.includes('/settings') && !url.includes('sign')) return 'OR_SETTINGS_PAGE';

      // Legal consent (sign-up/continue): "I agree to the Terms of Service..."
      if (
        url.includes('/sign-up') ||
        txt.includes('legal consent') ||
        (txt.includes('i agree to the terms of service'))
      ) return 'OR_LEGAL_CONSENT';

      // Wizard step "Your workspace is ready" / "Your API Key" (setelah Individual/Next)
      if (
        txt.includes('your workspace is ready') ||
        (txt.includes('your api key') && txt.includes('this is the only time'))
      ) return 'OR_WIZARD_KEY_STEP';

      // Wizard step "Add a payment method" (step 3/5) -> skip via "I'll do this later"
      if (txt.includes('add a payment method') || txt.includes("i'll do this later")) return 'OR_WIZARD_PAYMENT_STEP';

      // Halaman onboarding "tentang diri kita" (role, name, dsb.)
      if (
        txt.includes('what brings you to openrouter') ||
        txt.includes('how do you plan to use openrouter') ||
        txt.includes('how will you be using openrouter') ||
        txt.includes('what is your name') ||
        txt.includes('your first name') ||
        txt.includes('tell us about yourself') ||
        txt.includes('how did you hear about us') ||
        txt.includes('where did you hear about us') ||
        txt.includes('what will you use openrouter for') ||
        txt.includes('you can change this later') ||
        has('select[name="role"]') ||
        has('select[name="rolename"]') ||
        has('select[name="referral"]')
      ) {
        return 'OR_ONBOARDING_QUESTIONS';
      }

      // Halaman sign up / login Clerk (bukan homepage anonim — home juga memuat 'sign up')
      const isAnonHome = txt.includes('the unified interface') || txt.includes('better prices, better uptime');
      if (!isAnonHome && (txt.includes('sign up') || txt.includes('sign in to openrouter') || txt.includes('welcome back'))) {
        const googleBtn =
          hasVisible('button.cl-socialButtonsIconButton') ||
          has('[data-localization-key*="continueWith"][data-localization-key*="Google"]') ||
          (() => {
            // Cari tombol apa pun yang memuat logo Google (svg/img/aria-label)
            const els = Array.from(document.querySelectorAll('button, a'));
            for (const el of els) {
              const t = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
              if (t.includes('google')) return true;
            }
            return false;
          })();
        if (googleBtn) return 'OR_AUTH_PAGE';
        return 'OR_AUTH_PAGE_NO_GOOGLE';
      }

      // Homepage anonim
      if (url === 'https://openrouter.ai/' || url.replace(/\/$/, '') === 'https://openrouter.ai' || url.includes('?')) {
        if (txt.includes('the unified interface') || txt.includes('get api key') || txt.includes('sign up')) {
          return 'OR_HOME';
        }
      }

      // Cloudflare interstitial ("checking your browser" / "verify you are human")
      if (
        txt.includes('checking your browser') ||
        txt.includes('verify you are human') ||
        (has('iframe[src*="challenges.cloudflare.com"]') && !txt.includes('sign up'))
      ) return 'OR_CLOUDFLARE';

      return null;
    })
    .catch(() => null);
}

async function classifyGoogleOauth(page) {
  return page
    .evaluate(() => {
      const url = location.href.toLowerCase();
      const txt = ((document.body && document.body.innerText) || '').toLowerCase();
      const has = (s) => { try { return !!document.querySelector(s); } catch (_) { return false; } };
      const hasVisible = (s) => {
        try {
          const el = document.querySelector(s);
          if (!el) return false;
          const st = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      };

      // Sudah kembali ke openrouter.ai (sso-callback / sign-up) -> selesaikan OAuth state machine
      // PENTING: cek hostname saja. URL Google sering memuat "openrouter.ai" di query param
      // (continue/opparams), jadi includes() pada full URL false-positive.
      if (location.hostname === 'openrouter.ai' || location.hostname.endsWith('.openrouter.ai')) return 'BACK_TO_OPENROUTER';

      // DITOLAK / bot-detected: gagal cepat, JANGAN tunggu sebagai interstitial.
      // (Log 20:12: /signin/rejected salah jatuh ke LOADING_INTERSTITIAL -> loop 9x sia-sia.)
      if (
        txt.includes('unusual activity') || txt.includes('unusual traffic') ||
        txt.includes('aktivitas tidak wajar') || txt.includes('may not be secure') ||
        has('iframe[src*="recaptcha"]') || has('iframe[title="recaptcha"]') ||
        has('#captcha-container') || url.includes('signin/rejected') ||
        (url.includes('/signin/rejected') || url.includes('rejection'))
      ) return 'CAPTCHA_OR_BOT_DETECTED';

      // Path TANPA query string — query ?continue=https://accounts.google.com/v3/signin/oauth/...
      // pernah membuat halaman password salah dianggap interstitial (log 20:20 test run 2).
      const path = (() => { try { return new URL(url).pathname; } catch (_) { return url; } })();

      // Input email/password dideteksi SEBELUM interstitial (lebih spesifik) —
      // URL challenge/pwd?continue=.../signin/oauth/ tidak boleh dianggap interstitial.
      const hasPwd = hasVisible('input[type="password"]:not([aria-hidden="true"])');
      const hasEmail =
        hasVisible('input[type="email"]') || hasVisible('input[name="identifier"]') ||
        hasVisible('input[autocomplete*="username"]');
      if (hasEmail) return 'EMAIL_INPUT';
      if (hasPwd) return 'PASSWORD_INPUT';

      // Error Google (halaman 500 "That's an error" setelah submit password) — gagal cepat,
      // jangan di-loop sebagai UNKNOWN 5x (log test run 3: 20:34-20:35).
      if (
        txt.includes("that's an error") || txt.includes('that’s an error') ||
        txt.includes('server error') ||
        (txt.includes('500') && txt.includes('error'))
      ) return 'GOOGLE_ERROR';

      // Interstitial Google yang masih loading (signin/oauth/id dsb.) -> tunggu, jangan aksi
      if (
        (path.includes('/signin/oauth/id') || path.includes('setsid') || path.includes('/signin/oauth')) &&
        !txt.includes('will allow') && !txt.includes('choose an account') && !txt.includes('sign in to')
      ) return 'LOADING_INTERSTITIAL';



      if (
        !hasPwd && !hasEmail &&
        (txt.includes('2-step verification') || txt.includes('verifikasi 2 langkah') ||
         txt.includes('tap yes on your phone') || has('#challengePickerList') ||
         has('li[data-challengetype]') ||
         ((txt.includes("verify it's you") || txt.includes('verify it’s you') || txt.includes('verifikasi bahwa ini anda')) && !hasEmail))
      ) return 'TWO_FACTOR_AUTH';



      // Workspace Terms of Service (akun Google Workspace baru): speedbump/workspacetermsofservice
      // Tombolnya bisa "I understand" (Welcome to your new account), "I accept", "Continue", dsb.
      if (
        url.includes('speedbump/workspacetermsofservice') ||
        txt.includes('welcome to your new account') ||
        txt.includes('welcome to google workspace') ||
        (txt.includes('google workspace') && txt.includes('terms of service')) ||
        txt.includes('your administrator can access')
      ) return 'WORKSPACE_TERMS';

      if (
        txt.includes('protect your account') || txt.includes('lindungi akun') ||
        txt.includes('recovery email') || txt.includes('email pemulihan') ||
        txt.includes('recovery phone') || txt.includes('nomor pemulihan') ||
        txt.includes('add a recovery')
      ) return 'RECOVERY_INFO_PROMPT';

      if (txt.includes('i agree') || txt.includes('saya setuju')) return 'TERMS_AGREEMENT';
      // Consent screen OAuth ("Sign in to OpenRouter", "Google will allow OpenRouter to access")
      if (
        (txt.includes('will allow') && txt.includes('to access')) ||
        txt.includes('sign in to openrouter') ||
        (txt.includes('continue') && txt.includes('cancel') && txt.includes('to access your data'))
      ) return 'OAUTH_CONSENT';

      if (
        txt.includes('choose an account') || txt.includes('pilih akun') ||
        has('div[data-button-type="multipleChoiceIdentifier"][data-identifier]')
      ) return 'ACCOUNT_CHOOSER';
      // Consent screen OAuth ("OpenRouter wants to access...")
      if (txt.includes('openrouter') && (txt.includes('wants to access') || txt.includes('continue to openrouter'))) return 'OAUTH_CONSENT';

      return null;
    })
    .catch(() => null);
}

async function clickByText(page, patterns, scope) {
  try {
    return await page.evaluate((pats, scopeSel) => {
      const wanted = pats.map((p) => p.toLowerCase());
      const root = scopeSel ? document.querySelector(scopeSel) || document : document;
      const els = Array.from(root.querySelectorAll('button, [role="button"], a, div[role="link"], label, span'));
      // dua putaran: putaran-1 hanya elemen teks pendek (t <= 60 char, tombol sesungguhnya),
      // putaran-2 baru longgar — supaya tidak salah klik paragraf (mis. "enterprise agreement" match 'agree')
      for (const pass of [1, 2]) {
        for (const el of els) {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          if (!t) continue;
          if (pass === 1 && t.length > 60) continue;
          if (wanted.some((p) => t === p || t.includes(p))) { el.click(); return t; }
        }
      }
      return null;
    }, patterns, scope || null);
  } catch (_) { return null; }
}

async function typeIntoField(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: CONFIG.actionTimeoutMs });
  const el = await page.$(selector);
  if (!el) throw new Error(`field ${selector} tidak ditemukan`);
  await el.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await page.type(selector, value, { delay: rand(...CONFIG.typingDelay) });
  const val = await page.evaluate((sel) => {
    const e = document.querySelector(sel);
    return e ? e.value : null;
  }, selector);
  if (val !== value) {
    await el.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.type(selector, value, { delay: 40 });
    const val2 = await page.evaluate((sel) => {
      const e = document.querySelector(sel);
      return e ? e.value : null;
    }, selector);
    if (val2 !== value) throw new Error(`nilai field tetap salah: "${val2}"`);
  }
}

async function clickGoogleNext(page, wrapperSel) {
  try {
    const clicked = await page.evaluate((sel) => {
      const wrap = document.querySelector(sel);
      if (!wrap) return false;
      const btn = wrap.querySelector('button') || wrap;
      btn.click();
      return true;
    }, wrapperSel);
    if (clicked) return true;
  } catch (_) {}
  if (await clickSelector(page, `${wrapperSel} button`)) return true;
  if (await clickSelector(page, wrapperSel)) return true;
  const byText = await clickByText(page, ['next', 'berikutnya', 'lanjut']);
  if (byText) return true;
  try { await page.keyboard.press('Enter'); return true; } catch (_) { return false; }
}

async function clickSelector(page, sel) {
  try {
    const el = await page.$(sel);
    if (!el) return false;
    await el.click();
    return true;
  } catch (_) { return false; }
}

// ===================== OPENROUTER ACTIONS =====================

async function orClickGoogleButton(page) {
  // Clerk: tombol sosial Google. Tombolnya icon-only (tidak ada teks di dalamnya).
  return page
    .evaluate(() => {
      // 1) Class khusus Clerk untuk provider Google (button.cl-socialButtonsIconButton__google)
      const g = document.querySelector('button.cl-socialButtonsIconButton__google, button.cl-socialButtonsIconButton.google, button[class*="socialButtonsIconButton__google"]');
      if (g) { g.click(); return 'clerk-google-class'; }
      // 2) Span ikon provider Google dengan aria-label
      const iconSpan = document.querySelector('span.cl-socialButtonsProviderIcon__google, span[aria-label*="Google" i]');
      if (iconSpan) {
        const b = iconSpan.closest('button');
        if (b) { b.click(); return 'clerk-icon-span'; }
      }
      // 3) Tombol apa pun dengan aria-label "Sign in with Google"
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], [aria-label]'));
      for (const el of els) {
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        if (al.includes('google')) { const b = el.closest('button') || el; b.click(); return 'aria-label: ' + al.slice(0, 40); }
      }
      // 4) Fallback teks (untuk halaman auth non-Clerk)
      const els2 = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const el of els2) {
        const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        if (t.includes('google') && t.length < 60) { el.click(); return 'text: ' + t.trim().slice(0, 40); }
      }
      return null;
    })
    .catch(() => null);
}

async function orHandleOnboarding(page, email) {
  // Form onboarding OpenRouter: role select, name, referral, dsb.
  // Strategi: isi nama (dari email prefix), pilih opsi pertama yang wajar pada tiap select, klik continue/save.
  return page
    .evaluate(async () => {
      const out = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };

      // a) Select native (role / rolename / referral) — pilih opsi non-empty pertama
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        if (!vis(sel)) continue;
        const opts = Array.from(sel.options).filter((o) => o.value && o.value !== '' && !/select|choose|pick/i.test(o.text));
        if (!opts.length) continue;
        // Pilih berdasar nama field: role -> developer-ish, referral -> default pertama
        const name = (sel.name || sel.id || '').toLowerCase();
        let chosen = opts[0];
        if (name.includes('role') || name.includes('rolename')) {
          const pref = opts.find((o) => /developer|engineer|building|personal|other|student/i.test(o.text) && !/company|business|organization|org/i.test(o.text));
          if (pref) chosen = pref;
        }
        sel.value = chosen.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        out.push(`select[${name}]=${chosen.text.trim().slice(0, 30)}`);
      }

      // b) Input teks: name fields
      const nameInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      for (const inp of nameInputs) {
        if (!vis(inp)) continue;
        const ph = (inp.placeholder || '').toLowerCase();
        const label = ((inp.labels && inp.labels[0] && inp.labels[0].innerText) || '').toLowerCase();
        const ident = (ph + ' ' + label + ' ' + (inp.name || '') + ' ' + (inp.id || '')).toLowerCase();
        if (ident.includes('name') && !ident.includes('company') && !ident.includes('org')) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, 'Dev');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          out.push(`input[${(inp.name || inp.id || 'name').slice(0, 20)}]=Dev`);
        }
      }

      // c) Custom dropdown (klik label lalu pilih opsi) — hanya jika masih ada elemen combobox belum terisi
      // d) Radio pilihan pertama — tapi PREFERENSI: kartu "Individual" (wizard baru OpenRouter)
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const seenGroups = new Set();
      const cards = Array.from(document.querySelectorAll('[role="radio"], label, div, button')).filter((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        return t === 'individual' || t.startsWith('individual\n');
      });
      if (cards.length) {
        try { cards[0].click(); out.push('card=individual'); } catch (_) {}
        // pastikan tidak ada radio lain yang perlu diklik
      } else {
        for (const r of radios) {
          if (!vis(r)) continue;
          const g = r.name || r.id;
          if (g && seenGroups.has(g)) continue;
          try { r.click(); if (g) seenGroups.add(g); out.push(`radio[${g}]=first`); } catch (_) {}
        }
      }

      return out;
    })
    .catch(() => null);
}

async function orClickOnboardingNext(page) {
  // Klik continue/save/done/submit pada onboarding
  const clicked = await clickByText(page, ['continue', 'save', 'submit', 'done', 'next', 'lanjutkan', 'simpan', 'selesai']);
  if (clicked) return clicked;
  // Fallback: tombol primary di form
  const ok = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      const cls = (b.className || '').toLowerCase();
      if ((cls.includes('primary') || cls.includes('submit')) && !b.disabled) { b.click(); return 'primary: ' + (b.innerText || '').trim().slice(0, 30); }
    }
    return null;
  }).catch(() => null);
  if (ok) return ok;
  try { await page.keyboard.press('Enter'); return 'enter'; } catch (_) { return null; }
}

async function orClickCreateKey(page) {
  const res = await page
    .evaluate(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      // 0) Dialog "Verify your email" (Clerk) menghalangi create -> tandai VERIF
      const bodyTxt = (document.body.innerText || '').toLowerCase();
      const verifyDialog = /verify\s+your\s+email/.test(bodyTxt) && /send\s+code/.test(bodyTxt);
      if (verifyDialog) return { verify: true };
      // 1) tombol "+ New Key" (UI baru) atau variasi teks lama
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const wanted = ['new key', '+ new key', 'create key', 'create api key', 'create a new key', '+ create', 'create'];
      for (const b of btns) {
        if (b.disabled) continue;
        const t = (b.innerText || '').replace(/^\+\s*/, '').trim().toLowerCase();
        if (t && wanted.some((w) => t === w) && vis(b)) { b.click(); return { verify: false, text: t.slice(0, 40) }; }
      }
      return { verify: false, text: null };
    })
    .catch(() => ({ verify: false, text: null }));
  if (res && res.verify) {
    // Tutup dialog verify (Cancel) lalu laporkan sebagai blocker
    const closed = await page
      .evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        for (const b of btns) {
          const t = (b.innerText || '').trim().toLowerCase();
          if (t === 'cancel') { b.click(); return true; }
        }
        return false;
      })
      .catch(() => false);
    log('OR:KEYS', 'verifyEmail', `dialog "Verify your email" muncul — Cancel diklik (${closed})`);
    return 'VERIFY_EMAIL_REQUIRED';
  }
  if (res && res.text) {
    // dialog create terbuka -> isi nama lalu klik tombol "Create" di dialog
    await new Promise((r) => setTimeout(r, 300));
    const sub = await page
      .evaluate(() => {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        };
        // isi nama key: input placeholder mengandung 'chatbot key' (field Name di dialog)
        const inp = Array.from(document.querySelectorAll('input[placeholder]')).find((i) =>
          /chatbot key/i.test(i.getAttribute('placeholder') || '')
        );
        if (inp && vis(inp)) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, 'bot-key');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          // beberapa UI react perlu event 'change' juga
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // klik tombol "Create" (enabled)
        const btns = Array.from(document.querySelectorAll('button'));
        for (const b of btns) {
          const t = (b.innerText || '').trim().toLowerCase();
          if (t === 'create' && !b.disabled && vis(b)) {
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, named: !!(inp && vis(inp)) };
          }
        }
        return null;
      })
      .catch(() => null);
    if (sub) {
      try { await page.mouse.click(sub.x, sub.y); } catch (_) {}
      log('OR:KEYS', 'createDialog', `nama=${sub.named ? 'bot-key' : '(default)'}, klik Create @ (${Math.round(sub.x)},${Math.round(sub.y)})`);
      return res.text + '+dialog-create';
    }
    log('OR:KEYS', 'createDialog', 'tombol Create tidak ketemu/disabled di dialog');
    return res.text;
  }
  return null;
}

async function orClickCopyKeyIcon(page) {
  // Klik ikon copy di samping key. Berlaku untuk key BARU (modal "key created") maupun
  // key LAMA yang sudah ada di tabel /settings/keys (edge case: akun sudah punya key).
  return page
    .evaluate(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // 0) Tombol dengan aria-label / title mengandung "copy" (prioritas tertinggi, paling spesifik)
      const all = Array.from(document.querySelectorAll('button, [role="button"], a, svg, span, div'));
      for (const el of all) {
        const al = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
        if (al.includes('copy') && !al.includes('copying')) {
          const b = el.closest('button, [role="button"]') || el;
          if (vis(b)) { b.click(); return 'aria-copy: ' + al.trim().slice(0, 30); }
        }
      }
      // 1) Baris tabel / item list yang menampung teks key (sk-or-v1-...) -> klik ikon copy di baris itu.
      //    Key lama di tabel ditampilkan sebagai "sk-or-v1-abc...xyz" (terpotong), jadi cek pola terpotong juga.
      const keyRow = (e) => {
        const t = (e.innerText || e.textContent || '');
        return /sk-or-v1-[a-z0-9]{4,}/i.test(t);
      };
      const holders = Array.from(document.querySelectorAll('tr, li, div'))
        .filter(keyRow)
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length); // paling dalam dulu
      for (const kh of holders) {
        let scope = kh;
        for (let i = 0; i < 4 && scope; i++) {
          // tombol yang icon-only (teks kosong) atau berisi svg copy
          const btns = Array.from(scope.querySelectorAll('button')).filter((b) => {
            const t = (b.innerText || '').trim().toLowerCase();
            return t !== 'delete' && t !== 'revoke' && t !== 'remove';
          });
          if (btns.length) { btns[0].click(); return 'near-key-btn: ' + (btns[0].getAttribute('aria-label') || 'icon').slice(0, 30); }
          scope = scope.parentElement;
        }
      }
      return null;
    })
    .catch(() => null);
}

async function orDetectExistingKeys(page) {
  // Deteksi apakah keys page punya key (edge case "api key sudah ada").
  // Key di halaman bisa tampil FULL (saat baru dibuat) atau MASKED (sk-or-v1-462****e30c).
  // Return { full: string|null, maskedCount: number }
  return page
    .evaluate(() => {
      const txt = document.body.innerText || '';
      const full = txt.match(/sk-or-v1-[a-zA-Z0-9]{20,}/);
      const masked = (txt.match(/sk-or-v1-[a-zA-Z0-9]*(?:\.\.\.|[\u2022\u25cf*])[a-zA-Z0-9]*/g) || []).length;
      const noKeys = /no api keys yet|you haven't created any keys/i.test(txt);
      return { full: full ? full[0] : null, maskedCount: masked, noKeys };
    })
    .catch(() => ({ full: null, maskedCount: 0, noKeys: false }));
}

async function orWaitKeysReady(page, timeoutMs = 4000) {
  // Tunggu UI keys benar-benar render (tombol create / baris key / empty-state) —
  // hindari aksi terlalu cepat saat SPA masih loading (log 16:55: "create tidak ketemu").
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => {
        const txt = (document.body.innerText || '');
        const hasCreate = Array.from(document.querySelectorAll('button, [role="button"]')).some((b) => {
          const t = (b.innerText || '').replace(/^\+\s*/, '').trim().toLowerCase();
          return t === 'new key' || t === 'create key' || t === 'create api key' || t === 'create a new key';
        });
        const hasRows = /sk-or-v1-/i.test(txt) || /no api keys yet/i.test(txt);
        return hasCreate || hasRows;
      })
      .catch(() => false);
    if (ready) return true;
    await sleep(250);
  }
  return false;
}

async function orDeleteAllKeys(page, email) {
  // Hapus SEMUA key di keys page.
  // CARA 1 (utama): klik checkbox "Select all rows" -> muncul bulk toolbar -> klik "Delete" (n).
  // CARA 2 (fallback): per baris via tombol "Row actions" -> menu -> item Delete -> konfirmasi.
  let deleted = 0;
  let fallback = false;

  // ---------- CARA 1: select all + bulk delete ----------
  const selectAllResult = await page
    .evaluate(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const cb = Array.from(document.querySelectorAll('[role="checkbox"]')).find((c) =>
        (c.getAttribute('aria-label') || '').toLowerCase().includes('select all')
      );
      if (!cb || !vis(cb)) return { ok: false, why: 'checkbox select-all tidak ditemukan' };
      const checked = cb.getAttribute('aria-checked') === 'true';
      const r = cb.getBoundingClientRect();
      return { ok: true, checked, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })
    .catch(() => ({ ok: false, why: 'evaluate error' }));
  log(email, 'OR:KEYS', `select-all checkbox: ${JSON.stringify(selectAllResult && selectAllResult.ok ? { checked: selectAllResult.checked } : selectAllResult.why)}`);
  if (selectAllResult && selectAllResult.ok && !selectAllResult.checked) {
    try { await page.mouse.click(selectAllResult.x, selectAllResult.y); } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }

  if (selectAllResult && selectAllResult.ok) {
    // cari tombol bulk delete yang muncul setelah select-all (toolbar)
    let bulk = null;
    for (let t = 0; t < 5 && !bulk; t++) {
      bulk = await page
        .evaluate(() => {
          const vis = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
          };
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (const b of btns) {
            const t = (b.innerText || '').trim();
            const tl = t.toLowerCase();
            if (vis(b) && (tl === 'delete' || tl === 'delete (n)' || /^delete \(\d+\)$/.test(tl) || tl === 'delete all')) {
              const r = b.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
            }
          }
          return null;
        })
        .catch(() => null);
      if (!bulk) await new Promise((r) => setTimeout(r, 600));
    }
    if (bulk) {
      log(email, 'OR:KEYS', `klik bulk delete "${bulk.t}" @ (${Math.round(bulk.x)},${Math.round(bulk.y)})`);
      try { await page.mouse.click(bulk.x, bulk.y); } catch (_) {}
      await new Promise((r) => setTimeout(r, 600));
      // konfirmasi dialog "Delete" — PRIORITAS tombol di dalam modal/dialog
      // (tombol bulk "Delete" di toolbar masih ada teksnya; jangan klik itu lagi)
      let confirm = null;
      for (let t = 0; t < 4 && !confirm; t++) {
        confirm = await page
          .evaluate(() => {
            const vis = (el) => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const inDialog = (b) => !!b.closest('[role="dialog"], [data-slot="dialog"], dialog, [data-state="open"][role="alertdialog"]');
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [role="alertdialog"]')).filter(vis);
            // 1) tombol delete di dalam dialog yang terbuka
            if (dialogs.length) {
              const btns = dialogs[dialogs.length - 1].querySelectorAll('button, [role="button"]');
              for (const b of btns) {
                const t = (b.innerText || '').trim().toLowerCase();
                if (vis(b) && (t === 'delete' || t === 'confirm' || t === 'yes' || t === 'yes, delete' || t === 'remove' || t === 'delete keys')) {
                  const r = b.getBoundingClientRect();
                  return { x: r.x + r.width / 2, y: r.y + r.height / 2, t, inDialog: true };
                }
              }
              return null; // dialog terbuka tapi tombol delete tidak ada -> jangan klik bulk lagi
            }
            return null;
          })
          .catch(() => null);
        if (!confirm) await new Promise((r) => setTimeout(r, 700));
      }
      if (confirm) {
        try { await page.mouse.click(confirm.x, confirm.y); } catch (_) {}
        log(email, 'OR:KEYS', `klik konfirmasi bulk "${confirm.t}" (dialog)`);
        await new Promise((r) => setTimeout(r, 600));
      } else {
        log(email, 'OR:KEYS', 'dialog konfirmasi bulk tidak terdeteksi');
      }
      // verifikasi: tunggu DOM re-render — butuh bacaan STABIL (sisa sama >= 2 poll
      // setelah poll ke-2) ATAU tabel kosong. Satu bacaan bisa stale (React belum
      // re-render) -> dulu memicu fallback row-actions sia-sia (log 16:55).
      let left = null;
      let prevCount = -1;
      for (let vpoll = 0; vpoll < 10; vpoll++) {
        left = await orDetectExistingKeys(page);
        if (left && left.maskedCount === 0 && !left.full) break; // tabel benar-benar kosong
        if (left && left.maskedCount === prevCount && vpoll >= 2) break; // stabil
        prevCount = left ? left.maskedCount : -1;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!left) left = await orDetectExistingKeys(page);
      log(email, 'OR:KEYS', `setelah bulk delete: sisa key = ${left.maskedCount}`);
      if (left.maskedCount === 0) return 999; // sukses penuh via select-all
      log(email, 'OR:KEYS', 'bulk delete via select-all tidak menghapus semua -> fallback row-actions');
    } else {
      log(email, 'OR:KEYS', 'tombol bulk delete tidak muncul setelah select-all -> fallback row-actions');
    }
  }
  fallback = true;

  // ---------- CARA 2 (fallback): row-actions per baris ----------
  for (let round = 0; round < 30; round++) {
    const target = await page
      .evaluate(() => {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        };
        const rowActionBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter((b) => {
          if (!vis(b)) return false;
          const al = (b.getAttribute('aria-label') || '').toLowerCase();
          return al === 'row actions';
        });
        if (rowActionBtns.length) {
          const b = rowActionBtns[0];
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, kind: 'row-actions', openMenu: true };
        }
        return null;
      })
      .catch(() => null);
    if (!target) {
      const left = await orDetectExistingKeys(page);
      if (left.maskedCount === 0 && !left.full) return deleted;
      if (round >= 3) return deleted;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const opened = await page
      .evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter((b) => {
          const al = (b.getAttribute('aria-label') || '').toLowerCase();
          return al === 'row actions';
        });
        if (btns.length) { btns[0].click(); return true; }
        return false;
      })
      .catch(() => false);
    log(email, 'OR:KEYS', `buka menu row-actions via JS click (${opened})`);
    await new Promise((r) => setTimeout(r, 450));
    let menuItem = await page
      .evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="button"], [data-slot="menu-item"]'));
        for (const it of items) {
          const t = (it.innerText || '').trim().toLowerCase();
          if (t === 'delete' || t === 'delete key' || t === 'remove') {
            const r = it.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
          }
        }
        return null;
      })
      .catch(() => null);
    if (!menuItem) {
      await new Promise((r) => setTimeout(r, 500));
      menuItem = await page
        .evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="button"], [data-slot="menu-item"]'));
          for (const it of items) {
            const t = (it.innerText || '').trim().toLowerCase();
            if (t === 'delete' || t === 'delete key' || t === 'remove') {
              const r = it.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
            }
          }
          return null;
        })
        .catch(() => null);
    }
    if (menuItem) {
      const clickedOk = await page
        .evaluate((mi) => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="button"], [data-slot="menu-item"]'));
          for (const it of items) {
            const t = (it.innerText || '').trim().toLowerCase();
            if (t === mi.t) { it.click(); return true; }
          }
          return false;
        }, menuItem)
        .catch(() => false);
      try { await page.mouse.click(menuItem.x, menuItem.y); } catch (_) {}
      log(email, 'OR:KEYS', `klik menu item "${menuItem.t}" @ (${Math.round(menuItem.x)},${Math.round(menuItem.y)}) js=${clickedOk}`);
      await new Promise((r) => setTimeout(r, 500));
    } else {
      log(email, 'OR:KEYS', 'item Delete tidak ketemu di menu row actions');
    }
    const confirm = await page
      .evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of btns) {
          const t = (b.innerText || '').trim().toLowerCase();
          if (t === 'delete' || t === 'confirm' || t === 'yes' || t === 'yes, delete' || t === 'remove') {
            const r = b.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
          }
        }
        return null;
      })
      .catch(() => null);
    if (confirm) {
      try { await page.mouse.click(confirm.x, confirm.y); } catch (_) {}
      log(email, 'OR:KEYS', `klik konfirmasi "${confirm.t}"`);
    }
    deleted++;
    await new Promise((r) => setTimeout(r, 600));
  }
  return deleted;
}


async function orReadKeyFromDom(page) {
  // 0) PRIORITAS: dialog "Your new key" memuat <onepassword-save-button value=BASE64>
  //    yang berisi JSON dengan API key FULL (meski tampilan di layar masked).
  const fromOnePassword = await page
    .evaluate(() => {
      try {
        const el = document.querySelector('onepassword-save-button');
        if (!el) return null;
        const raw = el.getAttribute('value') || '';
        const pad = '='.repeat((4 - (raw.length % 4)) % 4);
        const decoded = atob(raw + pad);
        const m = decoded.match(/sk-or-v1-[a-zA-Z0-9]+/);
        return m ? m[0] : null;
      } catch (_) { return null; }
    })
    .catch(() => null);
  if (fromOnePassword) return { source: 'onepassword-widget', key: fromOnePassword };
  // Coba baca key langsung dari DOM (kadang ditampilkan full saat baru dibuat)
  const fromDom = await page
    .evaluate(() => {
      const m = (document.body.innerText || '').match(/sk-or-v1-[a-zA-Z0-9]{20,}/);
      return m ? m[0] : null;
    })
    .catch(() => null);
  if (fromDom) return { source: 'dom-text', key: fromDom };
  const fromClipboard = await page
    .evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch (_) { return null; }
    })
    .catch(() => null);
  if (fromClipboard && /^sk-or-v1-/.test(fromClipboard.trim())) return { source: 'clipboard', key: fromClipboard.trim() };
  return null;
}

// ===================== GOOGLE OAUTH SUB-STATE MACHINE =====================

async function handleAccountChooser(page, account) {
  // 1) temukan elemen baris akun target -> klik dengan MOUSE di koordinatnya (JS click tidak
  //    memicu navigasi di halaman chooser Google)
  const target = await page
    .evaluate((email) => {
      const norm = email.toLowerCase();
      // Kartu akun di halaman chooser: div[data-identifier="email"] (multipleChoiceIdentifier)
      const cards = Array.from(document.querySelectorAll('[data-identifier]'));
      for (const card of cards) {
        if ((card.getAttribute('data-identifier') || '').toLowerCase() === norm) {
          const r = card.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, found: true };
        }
      }
      const rows = Array.from(document.querySelectorAll('div[role="link"], li[role], div[role="button"]'));
      for (const row of rows) {
        const t = ((row.innerText || '') + ' ' + (row.getAttribute('data-identifier') || '')).toLowerCase();
        if (t.includes(norm)) {
          const r = row.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, found: true };
        }
      }
      const wanted = ['use another account', 'gunakan akun lain', 'add another account', 'tambahkan akun lain'];
      const els = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="link"]'));
      for (const el of els) {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (t && wanted.some((w) => t.includes(w))) {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, found: true, other: true };
        }
      }
      return null;
    }, account.email)
    .catch(() => null);
  if (target && target.found) {
    try {
      await page.mouse.click(target.x, target.y);
      return target.other ? 'USE_ANOTHER_ACCOUNT (mouse)' : 'EXISTING_SESSION (mouse)';
    } catch (_) {}
  }
  // 2) fallback lama: JS click
  return page
    .evaluate((email) => {
      const norm = email.toLowerCase();
      const rows = Array.from(document.querySelectorAll('div[role="link"], [data-identifier], li, div[role="button"]'));
      for (const row of rows) {
        const t = ((row.innerText || '') + ' ' + (row.getAttribute('data-identifier') || '')).toLowerCase();
        if (t.includes(norm)) { row.click(); return 'EXISTING_SESSION (js)'; }
      }
      return null;
    }, account.email)
    .catch(() => null);
}

async function runGoogleOauthStateMachine(oauthPage, account, deadline) {
  let lastState = null;
  let repeats = 0;
  let emailDone = false;
  let pwdDone = false;

  while (Date.now() < deadline) {
    // popup OAuth bisa ditutup diam-diam oleh Google -> cek sebelum evaluate (hindari hang)
    try {
      if (oauthPage.isClosed()) {
        log(account.email, 'OAUTH', 'Popup OAuth TERCLOSED — anggap flow selesai (cek tab utama)');
        return { ok: true, detail: 'popup closed (lanjut cek tab utama)' };
      }
      const u = oauthPage.url();
      if (!u || u === 'about:blank') {
        log(account.email, 'OAUTH', 'Popup OAuth URL kosong — anggap selesai (cek tab utama)');
        return { ok: true, detail: 'popup blank (lanjut cek tab utama)' };
      }
    } catch (_) {}
    let state = null;
    try {
      state = await classifyGoogleOauth(oauthPage);
    } catch (e) {
      log(account.email, 'OAUTH', `classify gagal (${(e && e.message) || e}) — cek ulang 2 dtk`);
      await sleep(800);
      continue;
    }
    if (!state) state = 'UNKNOWN_PAGE';

    repeats = state === lastState ? repeats + 1 : 0;
    lastState = state;

    if (state === 'EMAIL_INPUT' || state === 'PASSWORD_INPUT') await sleep(600);
    log(account.email, `OAUTH:${state}`, `repeats=${repeats} url=${oauthPage.url().slice(0, 80)}`);

    switch (state) {
      case 'EMAIL_INPUT': {
        if (repeats >= 1 || emailDone) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_EMAIL_LOOP');
          return { ok: false, detail: 'Halaman email muncul lagi (email salah / Next gagal)' };
        }
        const sel = 'input[name="identifier"], input[type="email"]';
        const current = await oauthPage.evaluate((s) => {
          const e = document.querySelector(s);
          return e ? e.value : '';
        }, sel);
        if (current !== account.email) await typeIntoField(oauthPage, sel, account.email);
        emailDone = true;
        await clickGoogleNext(oauthPage, '#identifierNext');
        await oauthPage.waitForSelector('input[name="identifier"]:not([aria-hidden="true"]), input[type="email"]', { hidden: true, timeout: CONFIG.actionTimeoutMs }).catch(() => {});
        break;
      }
      case 'PASSWORD_INPUT': {
        if (repeats >= 1 || pwdDone) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_PWD_LOOP');
          return { ok: false, detail: 'Password ditolak / halaman password muncul kembali' };
        }
        await typeIntoField(oauthPage, 'input[name="Passwd"], input[type="password"]:not([aria-hidden="true"])', account.password);
        pwdDone = true;
        await clickGoogleNext(oauthPage, '#passwordNext');
        await oauthPage.waitForSelector('input[name="Passwd"], input[type="password"]:not([aria-hidden="true"])', { hidden: true, timeout: CONFIG.actionTimeoutMs }).catch(() => {});
        break;
      }
      case 'BACK_TO_OPENROUTER': {
        log(account.email, 'OAUTH', 'URL kembali ke openrouter.ai — OAuth selesai');
        return { ok: true, detail: 'kembali ke openrouter.ai' };
      }
      case 'LOADING_INTERSTITIAL': {
        // signin/oauth/id = "You're signing back in" (konfirmasi, body text kosong/shadow)
        // ATAU account picker baru. Strategi ganda:
        //   (a) klik <button> Continue via mouse
        //   (b) klik kartu akun [data-identifier]
        // SAFETY: jangan pernah klik Next di halaman /challenge/ (pwd/otp) —
        // itu bukan interstitial; klik Next di sana = submit password kosong berulang.
        {
          let cu = '';
          try { cu = new URL(oauthPage.url()).pathname; } catch (_) { cu = oauthPage.url(); }
          if (cu.includes('/challenge/')) {
            log(account.email, 'OAUTH:INTERSTITIAL', `URL ${cu} = challenge, bukan interstitial — tunggu classifier`);
            await sleep(600);
            break;
          }
        }
        if (repeats >= 1) {
          const target = await oauthPage
            .evaluate((em) => {
              const norm = em.toLowerCase();
              // (a) button Continue/Next
              const btns = Array.from(document.querySelectorAll('button'));
              for (const b of btns) {
                const t = (b.innerText || '').trim().toLowerCase();
                if ((t === 'continue' || t === 'next' || t === 'lanjutkan') && !b.disabled) {
                  const r = b.getBoundingClientRect();
                  if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, what: 'button:' + t };
                }
              }
              // (b) kartu akun
              const els = Array.from(document.querySelectorAll('[data-identifier]'));
              for (const el of els) {
                if ((el.getAttribute('data-identifier') || '').toLowerCase() === norm) {
                  const r = el.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, what: 'card' };
                }
              }
              return null;
            }, account.email)
            .catch(() => null);
          if (target) {
            try { await oauthPage.mouse.click(target.x, target.y); } catch (_) {}
            log(account.email, 'OAUTH:INTERSTITIAL', `klik mouse "${target.what}" @ (${Math.round(target.x)},${Math.round(target.y)})`);
            await sleep(900);
            break;
          }
        }
        if (repeats >= 8) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_INTERSTITIAL_STUCK');
          return { ok: false, detail: 'Interstitial Google tidak selesai-selesai' };
        }
        await sleep(700);
        break;
      }
      case 'ACCOUNT_CHOOSER': {
        if (repeats >= 3) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_CHOOSER_STUCK');
          return { ok: false, detail: 'Account chooser tidak mau lanjut setelah beberapa klik' };
        }
        const action = await handleAccountChooser(oauthPage, account);
        if (!action) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_CHOOSER_FAIL');
          return { ok: false, detail: 'Tidak bisa memilih akun di chooser' };
        }
        log(account.email, 'OAUTH:ACCOUNT_CHOOSER', action);
        await sleep(900);
        break;
      }
      case 'TWO_FACTOR_AUTH':
        await captureArtifacts(oauthPage, account.email, 'OAUTH_2FA');
        return { ok: false, detail: '2FA_REQUIRED' };
      case 'CAPTCHA_OR_BOT_DETECTED':
        await captureArtifacts(oauthPage, account.email, 'OAUTH_CAPTCHA');
        return { ok: false, detail: 'NEEDS_MANUAL_VERIFICATION' };
      case 'GOOGLE_ERROR':
        await captureArtifacts(oauthPage, account.email, 'OAUTH_GOOGLE_ERROR');
        return { ok: false, detail: 'Google error page (500/blokir) setelah submit kredensial' };
      case 'RECOVERY_INFO_PROMPT': {
        if (repeats >= 1) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_RECOVERY');
          return { ok: false, detail: 'Prompt recovery tetap muncul' };
        }
        const clicked = await clickByText(oauthPage, ['not now', 'skip', 'cancel', 'later', 'nanti saja', 'lewati', 'batal']);
        if (clicked) { log(account.email, 'OAUTH:RECOVERY', `klik "${clicked}"`); await sleep(500); break; }
        await captureArtifacts(oauthPage, account.email, 'OAUTH_RECOVERY');
        return { ok: false, detail: 'Tombol Not now/Skip tidak ditemukan' };
      }
      case 'WORKSPACE_TERMS': {
        // Google Workspace ToS: centang "I accept" lalu klik Accept / Continue
        if (repeats >= 2) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_WS_TERMS');
          return { ok: false, detail: 'Workspace terms tidak bisa diterima' };
        }
        // coba centang checkbox "I accept" kalau ada
        try {
          await oauthPage.evaluate(() => {
            const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            for (const cb of cbs) { if (!cb.checked) cb.click(); }
          });
        } catch (_) {}
        await sleep(300);
        const clicked = await clickByText(oauthPage, [
          'i understand', 'accept', 'i accept', 'agree', 'i agree', 'continue', 'accept all', 'lanjutkan', 'setuju', 'got it',
        ]);
        if (clicked) {
          log(account.email, 'OAUTH:WORKSPACE_TERMS', `klik "${clicked}"`);
          await sleep(800);
          break;
        }
        // fallback 1: tombol Google material (jsname LgbsSe) — tombol utama halaman speedbump
        const ok1 = await oauthPage.evaluate(() => {
          const btn = document.querySelector('button[jsname="LgbsSe"]');
          if (btn && !btn.disabled) { btn.click(); return 'jsname-LgbsSe: ' + (btn.innerText || '').trim().slice(0, 30); }
          return null;
        }).catch(() => null);
        if (ok1) { log(account.email, 'OAUTH:WORKSPACE_TERMS', `klik tombol "${ok1}"`); await sleep(800); break; }
        // fallback 2: tombol dengan id/nama khas workspace terms
        const ok2 = await oauthPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
          for (const b of btns) {
            const id = (b.id || '') + ' ' + (b.getAttribute('name') || '');
            if (/accept|agree|continue/i.test(id) && !b.disabled) { b.click(); return id; }
          }
          return null;
        }).catch(() => null);
        if (ok2) { log(account.email, 'OAUTH:WORKSPACE_TERMS', `klik tombol "${ok2}"`); await sleep(800); break; }
        await captureArtifacts(oauthPage, account.email, 'OAUTH_WS_TERMS');
        return { ok: false, detail: 'Tombol Accept Workspace Terms tidak ditemukan' };
      }
      case 'TERMS_AGREEMENT': {
        if (repeats >= 3) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_TERMS');
          return { ok: false, detail: 'Halaman terms tetap muncul' };
        }
        // 1) pastikan checkbox "I agree..." tercentang (button[role=checkbox] OR input)
        try {
          await oauthPage.evaluate(() => {
            const cbs = Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]'));
            for (const cb of cbs) {
              const checked = cb.getAttribute('aria-checked') === 'true' || (cb.checked === true);
              if (!checked) cb.click();
            }
          });
        } catch (_) {}
        await sleep(400);
        // 2) klik tombol <button> Continue via koordinat mouse
        const btn = await oauthPage
          .evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const wanted = ['continue', 'accept', 'agree', 'lanjutkan', 'setuju'];
            for (const b of btns) {
              const t = (b.innerText || '').trim().toLowerCase();
              if (t && wanted.some((w) => t === w) && !b.disabled) {
                const r = b.getBoundingClientRect();
                if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: t.slice(0, 30) };
              }
            }
            return null;
          })
          .catch(() => null);
        if (btn) {
          try { await oauthPage.mouse.click(btn.x, btn.y); } catch (_) {}
          log(account.email, 'OAUTH:TERMS', `klik mouse "${btn.text}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
          await sleep(900);
          break;
        }
        await captureArtifacts(oauthPage, account.email, 'OAUTH_TERMS');
        return { ok: false, detail: 'Tombol agree tidak ditemukan' };
      }
      case 'OAUTH_CONSENT': {
        // Google consent untuk OpenRouter: klik tombol <button> ASLI via koordinat mouse.
        // clickByText tidak dipakai di sini (sering salah klik span judul paragraf).
        if (repeats >= 3) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_CONSENT');
          return { ok: false, detail: 'Consent screen tidak bisa dilanjutkan' };
        }
        const btn = await oauthPage
          .evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const wanted = ['continue', 'allow', 'confirm', 'lanjutkan', 'izinkan'];
            for (const b of btns) {
              const t = (b.innerText || '').trim().toLowerCase();
              if (t && wanted.some((w) => t === w || t.includes(w)) && !b.disabled) {
                const r = b.getBoundingClientRect();
                if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: t.slice(0, 30) };
              }
            }
            return null;
          })
          .catch(() => null);
        if (btn) {
          try { await oauthPage.mouse.click(btn.x, btn.y); } catch (_) {}
          log(account.email, 'OAUTH:CONSENT', `klik mouse "${btn.text}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
          await sleep(900);
          break;
        }
        await captureArtifacts(oauthPage, account.email, 'OAUTH_CONSENT');
        return { ok: false, detail: 'Tombol Continue/Allow tidak ditemukan' };
      }
      case 'UNKNOWN_PAGE':
      default: {
        // interstisial Google (SetSID, /signin/oauth/id saat loading) — beri waktu lebih
        if (repeats >= 5) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_UNKNOWN');
          return { ok: false, detail: 'Halaman OAuth tidak dikenali' };
        }
        await sleep(700);
        break;
      }
    }
  }
  return { ok: true, detail: 'OAuth selesai / tab kembali ke OpenRouter' };
}

// State machine OpenRouter setelah login (onboarding + keys). Dipakai baik via
// signup penuh maupun session yang sudah ada (profil persist).
async function runOrStateMachineOnly(page, email, account) {
  let lastOr = null;
  let orRepeats = 0;
  let orSteps = 0;
  let wizardFullKey = null;
  let lastMaskedCount = null;
  let keyCreated = false;
  let onboardingRounds = 0;
  let authSignInRetries = 0; // budget: max 2 klik sign-in Google (password ditolak -> gagal cepat)
  let apiKeyResult = null;
  while (orSteps < CONFIG.maxStateMachineSteps) {
      orSteps++;
      // tunggu spinner/loading hilang (maks 8s) sebelum classify — hindari salah state saat transit
      try {
        for (let lw = 0; lw < 26; lw++) {
          const loading = await page.evaluate(() => {
            const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 30; };
            const sp = document.querySelector('[data-loading], .animate-spin, .cl-spinner, [class*="loading"]');
            if (sp && vis(sp)) return true;
            return false;
          }).catch(() => false);
          if (!loading) break;
          await sleep(300);
        }
      } catch (_) {}
      let orState = await classifyOpenRouter(page);
      if (!orState) orState = 'OR_UNKNOWN';
      orRepeats = orState === lastOr ? orRepeats + 1 : 0;
      lastOr = orState;
      log(email, `OR:${orState}`, `step ${orSteps} repeats=${orRepeats} url=${page.url().slice(0, 80)}`);

      switch (orState) {
        case 'OR_HOME':
        case 'OR_AUTH_PAGE':
        case 'OR_AUTH_PAGE_NO_GOOGLE': {
          // Session kadang expired saat navigate keys page -> sign-in muncul.
          // Coba re-login: klik tombol Google di sign-in (session Google masih ada di profil),
          // OAuth akan kilat lewat account chooser lalu balik ke keys.
          if (orRepeats >= 4 || authSignInRetries >= 2) {
            await captureArtifacts(page, email, 'OR_STUCK_AUTH');
            return {
              ok: false, stage: 'OR_AUTH',
              detail: authSignInRetries >= 2
                ? 'Sign-in Google gagal 2x (password ditolak / diblokir Google) — skip agar tidak membuang waktu'
                : 'Masih di halaman auth setelah OAuth (login gagal?)',
            };
          }
          // Salah-klasifikasi home-terlogin-sebagai-auth (log 16:42): session sebenarnya
          // valid. Sebelum menyerah, coba langsung ke /settings/keys — login valid akan
          // klasifikasi sebagai KEYS_PAGE dan flow lanjut normal.
          if (orRepeats === 2) {
            log(email, 'OR:OR_AUTH_PAGE', 'masih auth — coba langsung ke /settings/keys (cek session)...');
            await page.goto(CONFIG.keysUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch(() => {});
            break;
          }
          if (orState === 'OR_AUTH_PAGE') {
            const g = await orClickGoogleButton(page).catch(() => null);
            if (g) {
              log(email, `OR:${orState}`, `sign-in muncul — klik Google (${g}), tunggu OAuth kilat...`);
              authSignInRetries++;
              // tunggu balik ke openrouter.ai (maks 25s)
              for (let w = 0; w < 40; w++) {
                await sleep(400);
                try {
                  const host = new URL(page.url()).hostname;
                  if (host === 'openrouter.ai' && !page.url().includes('/sign-in')) break;
                } catch (_) {}
                // popup OAuth bisa terbuka — tangani via tab list
                if (w % 4 === 3) {
                  for (const p2 of await page.browser().pages()) {
                    try {
                      if (p2.url().includes('accounts.google.com')) {
                        const st = await runGoogleOauthStateMachine(p2, (account && account.email === email) ? account : { email, password: '' }, Date.now() + 25000).catch(() => null);
                        log(email, `OR:${orState}`, `oauth popup handled: ${JSON.stringify(st && st.detail ? st.detail : st)}`);
                        // popup gagal (password ditolak/diblokir) -> hitung sebagai attempt sign-in,
                        // jangan ulangi klik Google selamanya (log 20:12: 5 attempt sia-sia)
                        if (st && st.ok === false) authSignInRetries++;
                      }
                      // OAuth sudah jelas gagal 2x -> hentikan loop tunggu (jangan
                      // jalankan state machine lagi di popup yang stuck; log run4 20:50).
                      if (authSignInRetries >= 2) { w = 999; break; }
                    } catch (_) {}
                  }
                }
              }
              break;
            }
          }
          if (orState === 'OR_HOME') {
            const c = await page.evaluate(() => {
              const els = Array.from(document.querySelectorAll('a, button'));
              for (const el of els) {
                const t = (el.innerText || '').trim().toLowerCase();
                if (t === 'sign up' || t === 'get api key') { el.click(); return t; }
              }
              return null;
            }).catch(() => null);
            if (c) log(email, `OR:${orState}`, `klik "${c}"`);
          }
          await sleep(400);
          break;
        }

        case 'OR_ONBOARDING_QUESTIONS': {
          onboardingRounds++;
          if (orRepeats >= 3 || onboardingRounds > 6) {
            await captureArtifacts(page, email, 'OR_ONBOARDING_STUCK');
            return { ok: false, stage: 'ONBOARDING', detail: `Onboarding tidak selesai setelah ${onboardingRounds} ronde` };
          }
          const filled = await orHandleOnboarding(page, email);
          log(email, 'OR:ONBOARDING', `isi form: ${JSON.stringify(filled)}`);
          await sleep(250);
          const nxt = await orClickOnboardingNext(page);
          log(email, 'OR:ONBOARDING', `klik next: "${nxt}"`);
          await sleep(500);
          await captureArtifacts(page, email, `ONBOARDING_R${onboardingRounds}`, 'step_');
          break;
        }

        case 'OR_LEGAL_CONSENT': {
          // Legal consent: centang "I agree..." lalu klik Continue (button, mouse)
          if (orRepeats >= 5) {
            await captureArtifacts(page, email, 'OR_LEGAL_CONSENT_STUCK');
            return { ok: false, stage: 'LEGAL_CONSENT', detail: 'Legal consent tidak bisa dilanjutkan' };
          }
          try {
            await page.evaluate(() => {
              const cbs = Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]'));
              for (const cb of cbs) {
                const checked = cb.getAttribute('aria-checked') === 'true' || cb.checked === true;
                if (!checked) cb.click();
              }
            });
          } catch (_) {}
          await sleep(500);
          const btn = await page
            .evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              for (const b of btns) {
                const t = (b.innerText || '').trim().toLowerCase();
                if ((t === 'continue' || t === 'accept' || t === 'agree' || t === 'lanjutkan' || t === 'setuju') && !b.disabled) {
                  const r = b.getBoundingClientRect();
                  if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: t };
                }
              }
              return null;
            })
            .catch(() => null);
          if (btn) {
            try { await page.mouse.click(btn.x, btn.y); } catch (_) {}
            log(email, 'OR:LEGAL_CONSENT', `klik mouse "${btn.text}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
            await sleep(500);
            break;
          }
          // tombol belum render? tunggu & retry dalam handler ini (maks 5x) — halaman berat
          await sleep(1000);
          if (orRepeats < 5) { break; }
          await captureArtifacts(page, email, 'OR_LEGAL_CONSENT_NOBTN');
          return { ok: false, stage: 'LEGAL_CONSENT', detail: 'Tombol Continue legal consent tidak ditemukan' };
        }

        case 'OR_WIZARD_KEY_STEP': {
          // Wizard langkah "Your API Key": key dibuat otomatis (masked di sini).
          // Full key tampil SEKALI di layar sebelumnya; simpan kalau ketemu, lalu Continue.
          if (orRepeats >= 3) {
            await captureArtifacts(page, email, 'OR_WIZARD_STUCK');
            if (wizardFullKey) {
              apiKeyResult = { source: 'wizard-fallback', key: wizardFullKey };
              appendApiKey(email, wizardFullKey);
              return { ok: true, stage: 'DONE', detail: 'key via wizard-fallback', apiKey: wizardFullKey };
            }
            return { ok: false, stage: 'WIZARD', detail: 'Wizard "Your API Key" tidak bisa dilanjutkan' };
          }
          const fullHere = await page
            .evaluate(() => {
              const m = (document.body.innerText || '').match(/sk-or-v1-[a-zA-Z0-9]{20,}/);
              return m ? m[0] : null;
            })
            .catch(() => null);
          wizardFullKey = fullHere; // disimpan sementara; keys page akan delete+create baru
          log(email, 'OR:WIZARD', fullHere ? 'wizard menampilkan full key (akan diganti di keys page)' : 'wizard menampilkan key masked');
          const btn = await page
            .evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              for (const b of btns) {
                const t = (b.innerText || '').trim().toLowerCase();
                if ((t === 'continue' || t === 'next' || t === 'done' || t === 'finish') && !b.disabled) {
                  const r = b.getBoundingClientRect();
                  if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
                }
              }
              return null;
            })
            .catch(() => null);
          if (btn) {
            try { await page.mouse.click(btn.x, btn.y); } catch (_) {}
            log(email, 'OR:WIZARD', `klik mouse "${btn.t}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
            await sleep(600);
            break;
          }
          await sleep(700);
          break;
        }

        case 'OR_WIZARD_PAYMENT_STEP': {
          // step payment: klik "I'll do this later" (link/button di bawah)
          if (orRepeats >= 3) {
            await captureArtifacts(page, email, 'OR_WIZARD_PAYMENT_STUCK');
            return { ok: false, stage: 'WIZARD_PAYMENT', detail: 'Step payment wizard tidak bisa diskip' };
          }
          const btn = await page
            .evaluate(() => {
              const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
              for (const el of els) {
                const t = (el.innerText || '').trim().toLowerCase();
                if (t.includes("i'll do this later") || t === 'skip' || t === 'later' || t === 'skip for now') {
                  const r = el.getBoundingClientRect();
                  if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: t.slice(0, 30) };
                }
              }
              return null;
            })
            .catch(() => null);
          if (btn) {
            try { await page.mouse.click(btn.x, btn.y); } catch (_) {}
            log(email, 'OR:WIZARD', `klik skip payment "${btn.t}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
            await sleep(600);
            break;
          }
          await sleep(700);
          break;
        }

        case 'OR_KEYS_PAGE': {
          // Salah-klasifikasi (log 20:12: sign-in page berlabel KEYS_PAGE): classifier memakai
          // konten, bukan URL. Kalau URL jelas-jelas bukan /settings/keys, navigasi ke sana dulu.
          {
            let host = '';
            let path = '';
            try { const u = new URL(page.url()); host = u.hostname; path = u.pathname; } catch (_) {}
            // UI baru OR: keys page = /workspaces/<ws>/keys. /settings/keys di-redirect ke sana,
            // jadi guard lama (!startsWith('/settings/keys')) loop navigasi 34x (log run6).
            const isKeysPath = path.startsWith('/settings/keys') || /\/keys\/?$/.test(path);
            if (host === 'openrouter.ai' && !isKeysPath) {
              log(email, 'OR:OR_KEYS_PAGE', `URL bukan keys page (${path.slice(0, 40)}) -> navigate ke keys page`);
              await page.goto(CONFIG.keysUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch(() => {});
              break;
            }
          }
          if (apiKeyResult) return { ok: true, stage: 'DONE', detail: 'key sudah didapat', apiKey: apiKeyResult.key };
          if (keyCreated && orRepeats >= 4) {
            // key dibuat tapi belum kebaca (dialog "Your new key" tidak muncul)
            await captureArtifacts(page, email, 'OR_KEY_READ_FAIL');
            return { ok: false, stage: 'KEY_READ', detail: 'Key dibuat tapi tidak terbaca' };
          }
          if (keyCreated) await sleep(400); // beri waktu dialog "Your new key" render
          if (!keyCreated) {
            // ==== EDGE CASE BARU: API KEY SUDAH ADA -> DELETE SEMUA -> CREATE BARU ====
            // Cek dari HALAMAN (bukan dari api_keys.txt), jadi tetap berfungsi walau txt kosong.
            await orWaitKeysReady(page);
            const det = await orDetectExistingKeys(page);
            if (det && (det.full || det.maskedCount > 0) && !det.noKeys) {
              // progress tracking: kalau jumlah key TIDAK berkurang antar pass dan sudah
              // beberapa repeats -> gagal. Kalau berkurang -> lanjut pass delete berikutnya.
              const prev = lastMaskedCount;
              if (prev !== null && det.maskedCount >= prev && orRepeats >= 3) {
                await captureArtifacts(page, email, 'OR_DELETE_FAIL');
                return { ok: false, stage: 'DELETE_OLD_KEYS', detail: `Key lama tidak berkurang (sisa ${det.maskedCount} masked)` };
              }
              lastMaskedCount = det.maskedCount;
              log(email, 'OR:KEYS', `key LAMA terdeteksi (full=${!!det.full}, masked=${det.maskedCount}, sebelumnya=${prev === null ? '-' : prev}) -> DELETE semua, lalu create baru`);
              const n = await orDeleteAllKeys(page, email);
              log(email, 'OR:KEYS', `delete key lama: ${n} tombol delete diklik`);
              await sleep(300);
              break; // loop -> re-classify (jumlah key harus berkurang)
            }
            // ==== tidak ada key (atau sudah terhapus): buat key baru ====
            log(email, 'OR:KEYS', 'di halaman keys, klik Create Key...');
            await sleep(250);
            const created = await orClickCreateKey(page);
            if (created === 'VERIFY_EMAIL_REQUIRED') {
              await captureArtifacts(page, email, 'OR_VERIFY_EMAIL');
              return { ok: false, stage: 'EMAIL_VERIFY_REQUIRED', detail: 'OpenRouter minta verifikasi email untuk create key (kode dikirim ke email akun)' };
            }
            if (created) {
              log(email, 'OR:KEYS', `klik "${created}"`);
              keyCreated = true;
              await sleep(900);
            } else {
              log(email, 'OR:KEYS', 'tombol create tidak ketemu, tunggu & retry');
              if (orRepeats >= 2) {
                await captureArtifacts(page, email, 'OR_NO_CREATE_BTN');
                return { ok: false, stage: 'CREATE_KEY', detail: 'Tombol Create API Key tidak ditemukan' };
              }
              await sleep(800);
            }
          } else {
            // key sudah dibuat: coba baca
            const read = await orReadKeyFromDom(page);
            if (read) {
              apiKeyResult = read;
              log(email, 'OR:KEYS', `key terbaca (${read.source}): ${read.key.slice(0, 14)}...`);
              appendApiKey(email, read.key);
              return { ok: true, stage: 'DONE', detail: `key via ${read.source}`, apiKey: read };
            }
            // coba klik copy icon lalu baca clipboard
            const copyClicked = await orClickCopyKeyIcon(page);
            log(email, 'OR:KEYS', `copy icon: ${copyClicked}`);
            await sleep(800);
            const read2 = await orReadKeyFromDom(page);
            if (read2) {
              apiKeyResult = read2;
              log(email, 'OR:KEYS', `key terbaca (${read2.source}): ${read2.key.slice(0, 14)}...`);
              appendApiKey(email, read2.key);
              return { ok: true, stage: 'DONE', detail: `key via ${read2.source}`, apiKey: read2 };
            }
            if (orRepeats >= 3) {
              await captureArtifacts(page, email, 'OR_KEY_READ_FAIL');
              return { ok: false, stage: 'KEY_READ', detail: 'Tidak bisa membaca key setelah copy' };
            }
          }
          break;
        }

        case 'OR_SETTINGS_PAGE': {
          // login berhasil tapi bukan di keys -> navigasi ke keys
          log(email, 'OR:SETTINGS', 'navigasi ke /settings/keys');
          await page.goto(CONFIG.keysUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch(() => {});
          await sleep(500);
          break;
        }

        case 'OR_CLOUDFLARE': {
          // Cloudflare challenge: coba klik checkbox turnstile bila muncul
          const solved = await maybeSolveTurnstile(page, email);
          if (solved) log(email, 'OR:CLOUDFLARE', 'turnstile diklik');
          if (orRepeats >= 4) {
            await captureArtifacts(page, email, 'OR_CLOUDFLARE_STUCK');
            return { ok: false, stage: 'CLOUDFLARE', detail: 'Cloudflare challenge tidak lolos' };
          }
          await sleep(500);
          break;
        }
        case 'OR_NOT_OPENROUTER': {
          // Tab utama nyasar ke Google (same-tab OAuth) — tangani dengan state machine Google,
          // password asli dari account. Selesai -> balik openrouter, loop lanjut.
          const u2 = page.url();
          if (u2.includes('accounts.google.com')) {
            if (orRepeats >= 8) {
              await captureArtifacts(page, email, 'OR_STUCK_GOOGLE');
              return { ok: false, stage: 'OR_AUTH', detail: 'Nyangkut di Google terlalu lama' };
            }
            log(email, `OR:${orState}`, 'tab utama di Google — jalankan OAuth state machine (same-tab)');
            const gDone = await runGoogleOauthStateMachine(page, account || { email, password: '' }, Date.now() + 45000).catch(() => null);
            log(email, `OR:${orState}`, `same-tab oauth result: ${JSON.stringify(gDone && gDone.detail ? gDone.detail : gDone)}`);
            // same-tab OAuth gagal (password ditolak / Google 500) -> hitung ke budget sign-in
            // supaya akun gagal cepat, bukan loop 8x (log test run 3: 20:35).
            if (gDone && gDone.ok === false) {
              authSignInRetries++;
              if (authSignInRetries >= 2) {
                return { ok: false, stage: 'OR_AUTH', detail: `OAuth Google gagal berulang (${(gDone && gDone.detail) || '?'}) — skip akun` };
              }
            }
          }
          await sleep(500);
          break;
        }
        case 'OR_UNKNOWN':
        default: {
          // evaluate bisa throw saat navigasi in-flight (race) -> URL Google harus
          // diperlakukan sebagai OAuth same-tab, bukan UNKNOWN (log 16:47).
          {
            let cu = '';
            try { cu = page.url().toLowerCase(); } catch (_) {}
            if (cu.includes('accounts.google.com')) {
              const gDone = await runGoogleOauthStateMachine(page, account || { email, password: '' }, Date.now() + 45000).catch(() => null);
              log(email, 'OR:UNKNOWN', `google rescue: ${JSON.stringify(gDone && gDone.detail ? gDone.detail : gDone)}`);
              if (gDone && gDone.ok === false) {
                authSignInRetries++;
                if (authSignInRetries >= 2) {
                  return { ok: false, stage: 'OR_AUTH', detail: `OAuth Google gagal berulang (${(gDone && gDone.detail) || '?'}) — skip akun` };
                }
              }
              await sleep(400);
              break;
            }
          }
          if (orRepeats >= 3) {
            await captureArtifacts(page, email, 'OR_UNKNOWN_STUCK');
            return { ok: false, stage: 'OR_UNKNOWN', detail: `Halaman OpenRouter tidak dikenali: ${page.url().slice(0, 80)}` };
          }
          await sleep(800);
          break;
        }
      }
    }

  await captureArtifacts(page, email, 'OR_MAX_STEPS');
  return { ok: false, stage: 'MAX_STEPS', detail: `Melebihi ${CONFIG.maxStateMachineSteps} langkah`, bail: true };
}

// ===================== FLOW UTAMA =====================

async function maybeSolveTurnstile(page, email) {
  // Cloudflare Turnstile via Clerk: container div#clerk-captcha berisi iframe
  // challenges.cloudflare.com dengan checkbox "Verify you are human".
  // Strategi: bounding box container/iframe lalu klik area checkbox (kiri-tengah).
  try {
    // 1) frame turnstile langsung
    for (const f of page.frames()) {
      if (!f.url().includes('challenges.cloudflare.com')) continue;
      const el = await f.frameElement();
      if (!el) continue;
      const box = await el.boundingBox();
      if (!box || box.width < 20 || box.height < 20) continue;
      const x = box.x + Math.min(30, box.width / 4);
      const y = box.y + box.height / 2;
      await page.mouse.click(x, y);
      log(email, 'TURNSTILE', `klik checkbox iframe @ (${Math.round(x)},${Math.round(y)}) box=${Math.round(box.width)}x${Math.round(box.height)}`);
      return true;
    }
    // 2) container #clerk-captcha (bounding box-nya)
    const cont = await page.$('#clerk-captcha');
    if (cont) {
      const box = await cont.boundingBox();
      if (box && box.width > 20 && box.height > 20) {
        const x = box.x + Math.min(30, box.width / 4);
        const y = box.y + box.height / 2;
        await page.mouse.click(x, y);
        log(email, 'TURNSTILE', `klik container @ (${Math.round(x)},${Math.round(y)}) box=${Math.round(box.width)}x${Math.round(box.height)}`);
        return true;
      }
    }
    // 3) div cf-turnstile / [data-sitekey]
    const cont2 = await page.$('.cf-turnstile, [data-sitekey]');
    if (cont2) {
      const box = await cont2.boundingBox();
      if (box && box.width > 20 && box.height > 20) {
        const x = box.x + Math.min(30, box.width / 4);
        const y = box.y + box.height / 2;
        await page.mouse.click(x, y);
        log(email, 'TURNSTILE', `klik .cf-turnstile @ (${Math.round(x)},${Math.round(y)}) box=${Math.round(box.width)}x${Math.round(box.height)}`);
        return true;
      }
    }
  } catch (e) {
    log(email, 'TURNSTILE', `error: ${e.message}`);
  }
  return false;
}

async function hasTurnstile(page) {
  // Hanya TRUE jika widget turnstile BENAR-BENAR tampil (visible container
  // dengan ukuran nyata). Elemen #clerk-captcha / hidden input selalu ada
  // di markup Clerk walau widget belum aktif -> false positive jika tanpa cek visibilitas.
  try {
    const vis = await page.evaluate(() => {
      const visEl = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      // container Clerk captcha yang benar-benar tampil
      const cc = document.querySelector('#clerk-captcha');
      if (cc && visEl(cc)) return 'clerk-captcha';
      const cf = document.querySelector('.cf-turnstile, [data-sitekey]');
      if (cf && visEl(cf)) return 'cf-turnstile';
      const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      if (frame && visEl(frame)) return 'iframe';
      const txt = (document.body.innerText || '').toLowerCase();
      if (txt.includes('verify you are human') || txt.includes('verifikasi bahwa anda manusia')) return 'text';
      return null;
    });
    return vis || false;
  } catch (_) { return false; }
}

async function processAccount(account, idx, total) {
  const email = account.email;
  log(email, 'START', `akun ${idx + 1}/${total}`);

  // Profil Chrome terpisah per akun (bukan incognito): Google menolak
  // sign-in dari automation di incognito context ("may not be secure"),
  // tapi profil persisten + stealth lolos lebih sering.
  const profileDir = path.join('chrome_profiles', safeName(email));
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) {}
  const launchOpts = {
    headless: CONFIG.headless,
    args: [...LAUNCH_ARGS],
    defaultViewport: null,
    userDataDir: profileDir,
    protocolTimeout: 20000, // evaluate/click yang hang 20 dtk -> throw, bukan gantung selamanya
  };
  const exe = resolveChromeExecutable();
  if (exe) launchOpts.executablePath = exe;
  else launchOpts.channel = 'chrome';
  // HEADLESS: UA headless mengandung 'HeadlessChrome' -> Google menolak login (500).
  // UA string di-override per-page ke versi headful di bawah.

  const browser = await puppeteer.launch(launchOpts);
  let page = null;
  let apiKeyResult = null;

  try {
    // konteks default (profil persisten) — bukan incognito
    const context = browser.defaultBrowserContext();
    try {
      await context.overridePermissions('https://openrouter.ai', ['clipboard-read', 'clipboard-write']);
    } catch (_) {}
    const pages = await browser.pages();
    page = pages.length ? pages[0] : await context.newPage();
    // Judul jendela = akun yang sedang diproses (mudah dibedakan saat multi-run)
    // UA headful: 'HeadlessChrome/x' -> 'Chrome/x' (string lain identik).
    try {
      const cur = await page.evaluate(() => navigator.userAgent);
      if (/HeadlessChrome/i.test(cur)) {
        const fixed = cur.replace(/HeadlessChrome/, 'Chrome');
        await page.setUserAgent(fixed);
        log(email, 'UA', 'headless UA fixed -> ' + fixed);
      }
    } catch (_) {}
    const shortMail = email.split('@')[0];
    await page.evaluateOnNewDocument((t) => {
      try {
        Object.defineProperty(document, 'title', {
          get: () => t,
          set: () => {},
          configurable: true,
        });
      } catch (_) {}
    }, `BOT ${shortMail} (${idx + 1}/${total})`);

    // ---- STEP 1: homepage ----
    log(email, 'STEP1', `buka ${CONFIG.homeUrl}`);
    await page.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch((e) => {
      log(email, 'NAV_WARN', e.message);
    });
    await sleep(300);
    await captureArtifacts(page, email, 'HOME');

    // ---- STEP 1.5: cek apakah SUDAH LOGIN (profil persist) -> skip langsung ke state machine OR ----
    let preState = await classifyOpenRouter(page).catch(() => null);
    for (let pc = 0; pc < 3 && !preState; pc++) {
      await sleep(400); // home SPA belum selesai render — jangan memutuskan rute dari DOM setengah jadi
      preState = await classifyOpenRouter(page).catch(() => null);
    }
    const preLoginStates = ['OR_KEYS_PAGE', 'OR_SETTINGS_PAGE', 'OR_ONBOARDING_QUESTIONS', 'OR_LEGAL_CONSENT', 'OR_WIZARD_KEY_STEP', 'OR_WIZARD_PAYMENT_STEP'];
    // OR_HOME juga menandakan login jika home TIDAK menawarkan "Sign Up" (header user menu).
    const homeNoSignup = preState === 'OR_HOME' && await page
      .evaluate(() => {
        const txt = (document.body.innerText || '').toLowerCase();
        return !txt.includes('sign up') && !txt.includes('sign in');
      })
      .catch(() => false);
    if (preLoginStates.includes(preState) || homeNoSignup) {
      log(email, 'STEP1.5', `sudah login terdeteksi (${preState}) — skip signup, langsung state machine OR`);
      const done = await runOrStateMachineOnly(page, email, account);
      return done;
    }

    // ---- STEP 2: klik Sign Up di header ----
    log(email, 'STEP2', 'cari klik Sign Up');
    let clicked = null;
    for (let attempt = 0; attempt < 8 && !clicked; attempt++) {
      clicked = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('header a, header button, nav a, nav button, a, button'));
        const wanted = ['sign up', 'daftar'];
        for (const el of els) {
          const t = (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
          if (t && wanted.some((w) => t === w || t.includes(w)) && t.length < 30) { el.click(); return t; }
        }
        return null;
      }).catch(() => null);
      if (!clicked) await sleep(700);
    }

    if (!clicked) {
      // Kemungkinan sudah dihalaman auth via /auth
      log(email, 'STEP2', 'Sign Up tidak ketemu di home, langsung ke /auth');
      await page.goto('https://openrouter.ai/auth', { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch(() => {});
      await sleep(800);
    } else {
      log(email, 'STEP2', `klik "${clicked}"`);
      await sleep(300);
    }

    // ---- STEP 3: klik tombol Google di halaman auth ----
    let gAttempts = 0;
    let gClicked = null;
    let authReloaded = false;
    while (gAttempts < 8 && !gClicked) {
      // kalau 5x percobaan gagal, reload halaman auth sekali (kadang Clerk tidak render)
      if (gAttempts === 5 && !authReloaded) {
        authReloaded = true;
        log(email, 'STEP3', 'reload halaman auth (tombol Google tidak muncul)...');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(700);
      }
      // Turnstile bisa muncul SEBELUM klik Google (di dalam modal sign up)
      if (await hasTurnstile(page)) {
        log(email, 'STEP3', 'Turnstile terdeteksi sebelum klik Google, coba selesaikan...');
        let solved = false;
        for (let t = 0; t < 4 && !solved; t++) {
          solved = await maybeSolveTurnstile(page, email);
          if (!solved) { await sleep(700); }
        }
        if (!solved) {
          await captureArtifacts(page, email, 'TURNSTILE_PRE_GOOGLE');
          return { ok: false, stage: 'TURNSTILE', detail: 'Turnstile muncul di halaman auth dan tidak bisa diselesaikan' };
        }
        await sleep(500);
      }
      gClicked = await orClickGoogleButton(page);
      if (!gClicked) {
        log(email, 'STEP3', `tombol Google belum ada (attempt ${gAttempts + 1}), tunggu...`);
        await sleep(700);
      }
      gAttempts++;
    }
    if (!gClicked) {
      await captureArtifacts(page, email, 'NO_GOOGLE_BTN');
      return { ok: false, stage: 'GOOGLE_BTN', detail: 'Tombol Google tidak ditemukan di halaman auth' };
    }
    log(email, 'STEP3', `klik Google via ${gClicked}`);
    await sleep(400);

    // ---- STEP 4: temukan halaman Google OAuth (popup / redirect), tangani Turnstile ----
    let oauthPage = null;
    const findDeadline = Date.now() + 12000;
    while (Date.now() < findDeadline && !oauthPage) {
      for (const p of await browser.pages()) {
        try {
          const u = p.url();
          if (u.includes('accounts.google.com')) { oauthPage = p; break; }
        } catch (_) {}
      }
      if (!oauthPage && page.url().includes('accounts.google.com')) oauthPage = page;
      if (!oauthPage) {
        // Clerk redirect same-tab perlu waktu. Jangan buru-buru: biarkan loop polling yang
        // menemukan URL berubah (popup ATAU tab utama ke google ATAU sso-callback kilat).
        try {
          const mu = page.url().toLowerCase();
          if (mu.includes('sso-callback')) {
            // OAuth kilat selesai (session google masih ada) — langsung anggap selesai
            log(email, 'STEP4', 'sso-callback kilat terdeteksi — OAuth selesai tanpa popup');
            oauthPage = page;
            break;
          }
        } catch (_) {}
      }
      if (!oauthPage) {
        // Turnstile bisa muncul SETELAH klik Google (sebelum redirect ke Google)
        if (await hasTurnstile(page)) {
          const solved = await maybeSolveTurnstile(page, email);
          if (solved) log(email, 'STEP4', 'Turnstile setelah klik Google: diklik');
        }
        await sleep(400);
      }
    }
    if (!oauthPage) {
      // Tidak ada popup — cek tab utama: bisa jadi OAuth same-tab, ATAU langsung masuk
      // ke halaman sign-up OpenRouter (legal consent) karena session Google masih ada.
      const mainUrl = page.url().toLowerCase();
      if (mainUrl.includes('accounts.google.com')) {
        oauthPage = page;
        log(email, 'STEP4', 'OAuth terjadi di tab utama (same-tab)');
      } else if (mainUrl.startsWith('https://openrouter.ai') || mainUrl.startsWith('http://openrouter.ai') || mainUrl.includes('openrouter.ai/#') || mainUrl.includes('openrouter.ai/')) {
        log(email, 'STEP4', 'Tidak ada popup OAuth; lanjut ke state machine OpenRouter (session Google mungkin masih ada)');
        const r = await runGoogleOauthStateMachine(page, account, Date.now() + 20000);
        log(email, 'STEP4', `pre-OR state machine: ${JSON.stringify(r && r.detail ? r.detail : r)}`);
        // lanjut ke STEP6 (bukan OAuth penuh)
        oauthPage = page;
      } else {
        await captureArtifacts(page, email, 'NO_OAUTH_PAGE');
        return { ok: false, stage: 'OAUTH_PAGE', detail: 'Halaman Google OAuth tidak muncul' };
      }
    }
    if (oauthPage !== page) { try { await oauthPage.bringToFront(); } catch (_) {} }
    log(email, 'STEP4', `OAuth page: ${oauthPage.url().slice(0, 70)}`);

    // ---- STEP 5: jalankan OAuth state machine ----
    const oauthDeadline = Date.now() + CONFIG.oauthTimeoutMs;
    const oauthResult = await runGoogleOauthStateMachine(oauthPage, account, oauthDeadline);
    await captureArtifacts(oauthPage, email, 'OAUTH_END', 'step_');
    if (!oauthResult.ok) {
      return { ok: false, stage: 'OAUTH', detail: oauthResult.detail };
    }
    log(email, 'STEP5', 'OAuth OK, kembali ke OpenRouter');

    // kembali ke main page
    if (oauthPage !== page) { try { await page.bringToFront(); } catch (_) {} }

    // ---- STEP 6: tunggu redirect/verifikasi selesai di openrouter.ai ----
    // Kalau TAB UTAMA masih di Google (chooser/consent di tab utama), selesaikan dulu.
    for (let round = 0; round < 3; round++) {
      let mainU = '';
      try { mainU = page.url().toLowerCase(); } catch (_) {}
      if (!mainU.includes('accounts.google')) break;
      log(email, 'STEP6', `tab utama masih di Google (${mainU.slice(0, 60)}), selesaikan...`);
      const gPage = (oauthPage && !oauthPage.isClosed() && (oauthPage.url() || '').includes('accounts.google')) ? oauthPage : page;
      const extra = await runGoogleOauthStateMachine(gPage, account, Date.now() + 60000);
      if (!extra.ok) {
        await captureArtifacts(page, email, 'STEP6_GOOGLE_STUCK');
        return { ok: false, stage: 'OAUTH', detail: `Step6 masih di Google: ${extra.detail}` };
      }
      await sleep(400);
    }
    let settledUrl = '';
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      try { settledUrl = page.url().toLowerCase(); } catch (_) { break; }
      let host = '';
      try { host = new URL(page.url()).hostname; } catch (_) {}
      if (host === 'openrouter.ai') break;
    }
    log(email, 'STEP6', `URL setelah OAuth: ${settledUrl.slice(0, 80)}`);

    // ---- STEP 7: state machine OpenRouter (onboarding + keys) ----
    const orDone = await runOrStateMachineOnly(page, email, account);
    return orDone;
  } catch (err) {
    if (page) await captureArtifacts(page, email, 'FATAL').catch(() => {});
    return { ok: false, stage: 'FATAL', detail: err.message || String(err) };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// ===================== MAIN =====================

// Tangkap crash yang tidak tertangani try/catch (unhandledRejection membunuh Node 15+)
process.on('unhandledRejection', (e) => {
  log('MAIN', 'UNHANDLED_REJECTION', (e && (e.stack || e.message)) || String(e));
});
process.on('uncaughtException', (e) => {
  log('MAIN', 'UNCAUGHT_EXCEPTION', (e && (e.stack || e.message)) || String(e));
});

(async () => {
  ensureDirs();
  if (!resolveChromeExecutable() && !process.env.CHROME_PATH) {
    log('MAIN', 'FATAL', 'Chrome tidak ditemukan. Install Chrome atau set CHROME_PATH.');
    process.exit(1);
  }
  const all = readAccounts();
  if (!all.length) {
    log('MAIN', 'FATAL', 'account.txt kosong. Format: email|password per baris.');
    process.exit(1);
  }
  const done = loadExistingEmails();
  let accounts = all.filter((a) => !done.has(a.email.toLowerCase()));
  if (!accounts.length) {
    log('MAIN', 'INFO', 'Semua akun sudah punya API key.');
    process.exit(0);
  }
  if (process.env.MAX_ACCOUNTS) {
    const n = parseInt(process.env.MAX_ACCOUNTS, 10);
    if (n > 0 && n < accounts.length) accounts = accounts.slice(0, n);
  }
  log('MAIN', 'INFO', `${accounts.length}/${all.length} akun akan diproses`);

  let success = 0;
  let fail = 0;
  for (let i = 0; i < accounts.length; i++) {
    const res = await processAccount(accounts[i], i, accounts.length);
    if (res.ok) {
      success++;
      log('MAIN', 'SUCCESS', `${accounts[i].email}: ${res.detail}`);
      recordResult(accounts[i].email, true, 'OK', res.detail || '');
    } else {
      fail++;
      log('MAIN', 'FAIL', `${accounts[i].email} [${res.stage}]: ${res.detail}`);
      recordResult(accounts[i].email, false, res.stage || 'UNKNOWN', res.detail || '');
    }
    if (i < accounts.length - 1) await sleep(rand(...CONFIG.interAccountDelayMs));
  }
  log('MAIN', 'SUMMARY', `selesai: ${success} sukses, ${fail} gagal dari ${accounts.length} akun`);
  process.exit(0);
})().catch((e) => {
  log('MAIN', 'FATAL', e && e.message ? e.message : String(e));
  process.exit(1);
});
