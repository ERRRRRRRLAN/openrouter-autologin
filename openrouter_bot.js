'use strict';

/*
 * OpenRouter Auto Signup Bot
 * Flow: openrouter.ai -> Sign Up -> Google icon -> Google OAuth -> API key (copy icon)
 *       -> onboarding questions (role, name, referral, etc) -> done.
 * Architecture: state machine (like google_login_bot.js) + stealth + real Chrome headful.
 * Every state transition saves a screenshot + HTML dump to logs/ for visual audit.
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
  oauthTimeoutMs: 90000, // total OAuth budget
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
    // rotation: >10MB -> bot.log.old (checked every 50 lines, cheap)
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
  // Support two formats: "email|password" and "email:password".
  // Pick the separator that appears AFTER the email part (safe even if the password contains ':' or '|').
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
  // Skip only if the account DEFINITELY succeeded:
  //  1) present in api_keys.txt (key saved), OR
  //  2) its last line in logs/results.jsonl has status ok=true.
  // FAIL does not skip -> retried on the next run (starting from the first line of account.txt).
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
    // replace the old row for the same email (re-run -> new key, no duplicates)
    let rows = [];
    try { rows = fs.readFileSync(CONFIG.apiKeysFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) {}
    const kept = rows.filter((r) => r.split('|')[0].trim().toLowerCase() !== email.toLowerCase());
    kept.push(`${email}|${apiKey}`);
    fs.writeFileSync(CONFIG.apiKeysFile, kept.join('\n') + '\n');
    log(email, 'SAVED', `API key saved to ${CONFIG.apiKeysFile}`);
  } catch (e) { log(email, 'ERROR', `Failed to save API key: ${e.message}`); }
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
  // The NORMAL path (not an error) writes no screenshot/HTML — saves I/O & disk.
  // Errors/stuck states are still recorded. Set BOT_DEBUG=1 to log everything.
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
      // Guard: only classify when truly on openrouter.ai (Google URLs contain
      // 'openrouter.ai' in the continue query param — avoid misclassification)
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

      // Legal consent (sign-up/continue): "I agree to the Terms of Service..."
      if (
        url.includes('/sign-up') ||
        txt.includes('legal consent') ||
        (txt.includes('i agree to the terms of service'))
      ) return 'OR_LEGAL_CONSENT';

      // Wizard step "Your workspace is ready" / "Your API Key" (after Individual/Next)
      if (
        txt.includes('your workspace is ready') ||
        (txt.includes('your api key') && txt.includes('this is the only time'))
      ) return 'OR_WIZARD_KEY_STEP';

      // Wizard step "Add a payment method" (step 3/5) -> skip via "I'll do this later"
      if (txt.includes('add a payment method') || txt.includes("i'll do this later")) return 'OR_WIZARD_PAYMENT_STEP';

      // Onboarding page "about ourselves" (role, name, etc.)
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

      // Clerk sign up / login page (not the anonymous homepage — home also contains 'sign up')
      const isAnonHome = txt.includes('the unified interface') || txt.includes('better prices, better uptime');
      if (!isAnonHome && (txt.includes('sign up') || txt.includes('sign in to openrouter') || txt.includes('welcome back'))) {
        const googleBtn =
          hasVisible('button.cl-socialButtonsIconButton') ||
          has('[data-localization-key*="continueWith"][data-localization-key*="Google"]') ||
          (() => {
            // Find any button containing the Google logo (svg/img/aria-label)
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

      // Anonymous homepage
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

      // URL fallbacks LAST — text signals are stronger: the first-run onboarding wizard
      // ("How will you be using OpenRouter?") renders AT the /keys URL and must classify
      // as OR_ONBOARDING_QUESTIONS, never as OR_KEYS_PAGE (delete/create would misfire).
      if (url.includes('/settings/keys') || url.includes('/keys')) return 'OR_KEYS_PAGE';
      if (url.includes('/settings') && !url.includes('sign')) return 'OR_SETTINGS_PAGE';

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

      // Back on openrouter.ai (sso-callback / sign-up) -> finish the OAuth state machine
      // IMPORTANT: check the hostname only. Google URLs often contain "openrouter.ai" in a query param
      // (continue/opparams), so includes() on the full URL gives false positives.
      if (location.hostname === 'openrouter.ai' || location.hostname.endsWith('.openrouter.ai')) return 'BACK_TO_OPENROUTER';

      // REJECTED / bot-detected: fail fast, do NOT wait as an interstitial.
      // (Log 20:12: /signin/rejected wrongly fell into LOADING_INTERSTITIAL -> 9x wasted loop.)
      if (
        txt.includes('unusual activity') || txt.includes('unusual traffic') ||
        txt.includes('aktivitas tidak wajar') || txt.includes('may not be secure') ||
        has('iframe[src*="recaptcha"]') || has('iframe[title="recaptcha"]') ||
        has('#captcha-container') || url.includes('signin/rejected') ||
        (url.includes('/signin/rejected') || url.includes('rejection'))
      ) return 'CAPTCHA_OR_BOT_DETECTED';

      // Path WITHOUT query string — the ?continue=https://accounts.google.com/v3/signin/oauth/... query
      // once made the password page wrongly classified as interstitial (log 20:20 test run 2).
      const path = (() => { try { return new URL(url).pathname; } catch (_) { return url; } })();

      // Email/password input is detected BEFORE the interstitial (more specific) —
      // a challenge/pwd?continue=.../signin/oauth/ URL must not be treated as an interstitial.
      const hasPwd = hasVisible('input[type="password"]:not([aria-hidden="true"])');
      const hasEmail =
        hasVisible('input[type="email"]') || hasVisible('input[name="identifier"]') ||
        hasVisible('input[autocomplete*="username"]');
      if (hasEmail) return 'EMAIL_INPUT';
      if (hasPwd) return 'PASSWORD_INPUT';

      // Google error (500 page "That's an error" after submitting the password) — fail fast,
      // don't loop it as UNKNOWN 5x (log test run 3: 20:34-20:35).
      if (
        txt.includes("that's an error") || txt.includes('that’s an error') ||
        txt.includes('server error') ||
        (txt.includes('500') && txt.includes('error'))
      ) return 'GOOGLE_ERROR';

      // "Sign in to Chrome?" sync prompt on the SetSID page (fresh Chrome profiles).
      // It has no email/password input and sits on the setsid path, so without this
      // check it fell into LOADING_INTERSTITIAL and waited forever (log 08:34 ZakyTa19).
      if (
        (txt.includes('sign in to chrome') || txt.includes('set up a work profile') ||
         txt.includes('use chrome without an account') || txt.includes('continue as ')) &&
        !hasEmail && !hasPwd
      ) return 'CHROME_SIGNIN_PROMPT';

      // Google interstitial still loading (signin/oauth/id etc.) -> wait, don't act
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



      // Workspace Terms of Service (new Google Workspace account): speedbump/workspacetermsofservice
      // The button can be "I understand" (Welcome to your new account), "I accept", "Continue", etc.
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
      // two passes: pass-1 only short-text elements (t <= 60 chars, the actual buttons),
      // pass-2 is looser — so we don't mis-click a paragraph (e.g. "enterprise agreement" matching 'agree')
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
  if (!el) throw new Error(`field ${selector} not found`);
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
    if (val2 !== value) throw new Error(`field value still wrong: "${val2}"`);
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
  // Clerk: the Google social button. It is icon-only (no text inside).
  return page
    .evaluate(() => {
      // 1) Clerk class specific to the Google provider (button.cl-socialButtonsIconButton__google)
      const g = document.querySelector('button.cl-socialButtonsIconButton__google, button.cl-socialButtonsIconButton.google, button[class*="socialButtonsIconButton__google"]');
      if (g) { g.click(); return 'clerk-google-class'; }
      // 2) Google provider icon span with aria-label
      const iconSpan = document.querySelector('span.cl-socialButtonsProviderIcon__google, span[aria-label*="Google" i]');
      if (iconSpan) {
        const b = iconSpan.closest('button');
        if (b) { b.click(); return 'clerk-icon-span'; }
      }
      // 3) Any button with aria-label "Sign in with Google"
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], [aria-label]'));
      for (const el of els) {
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        if (al.includes('google')) { const b = el.closest('button') || el; b.click(); return 'aria-label: ' + al.slice(0, 40); }
      }
      // 4) Text fallback (for non-Clerk auth pages)
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
  // OpenRouter onboarding form: role select, name, referral, etc.
  // Strategy: fill in the name (from the email prefix), pick the first reasonable option in each select, click continue/save.
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

      // a) Native select (role / rolename / referral) — pick the first non-empty option
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        if (!vis(sel)) continue;
        const opts = Array.from(sel.options).filter((o) => o.value && o.value !== '' && !/select|choose|pick/i.test(o.text));
        if (!opts.length) continue;
        // Choose based on the field name: role -> developer-ish, referral -> first default
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

      // b) Text input: name fields
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

      // c) Custom dropdown (click the label then pick an option) — only if a combobox is still unfilled
      // d) First radio choice — but PREFERENCE: the "Individual" card (new OpenRouter wizard)
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const seenGroups = new Set();
      // Prefer the radio CARD itself ([role=radio]): the generic filter can match the
      // radiogroup CONTAINER first (document order = parent before child) and .click()
      // on the container never triggers the card's React handler.
      let cards = Array.from(document.querySelectorAll('[role="radio"]')).filter((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        return t === 'individual' || t.startsWith('individual\n');
      });
      if (!cards.length) {
        cards = Array.from(document.querySelectorAll('label, div, button')).filter((el) => {
          const t = (el.innerText || '').trim().toLowerCase();
          return t === 'individual' || t.startsWith('individual\n');
        });
      }
      if (cards.length) {
        try { cards[0].click(); out.push('card=individual'); } catch (_) {}
        // make sure no other radio needs clicking
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
  // Click continue/save/done/submit on the onboarding
  const clicked = await clickByText(page, ['continue', 'save', 'submit', 'done', 'next', 'lanjutkan', 'simpan', 'selesai']);
  if (clicked) return clicked;
  // Fallback: the primary form button
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
      // 0) A "Verify your email" modal (Clerk) blocking create -> flag VERIF
      const bodyTxt = (document.body.innerText || '').toLowerCase();
      const verifyDialog = /verify\s+your\s+email/.test(bodyTxt) && /send\s+code/.test(bodyTxt);
      if (verifyDialog) return { verify: true };
      // 1) the "+ New Key" button (new UI) or old text variants
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
    // Close the verify modal (Cancel) then report it as a blocker
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
    log('OR:KEYS', 'verifyEmail', `"Verify your email" modal appeared — Cancel clicked (${closed})`);
    return 'VERIFY_EMAIL_REQUIRED';
  }
  if (res && res.text) {
    // the create modal is open -> fill in the name then click the "Create" button in the modal
    await new Promise((r) => setTimeout(r, 300));
    const sub = await page
      .evaluate(() => {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        };
        // fill in the key name: the input whose placeholder contains 'chatbot key' (the Name field in the modal)
        const inp = Array.from(document.querySelectorAll('input[placeholder]')).find((i) =>
          /chatbot key/i.test(i.getAttribute('placeholder') || '')
        );
        if (inp && vis(inp)) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, 'bot-key');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          // some React UIs also need the 'change' event
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // click the "Create" button (enabled)
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
      log('OR:KEYS', 'createDialog', `name=${sub.named ? 'bot-key' : '(default)'}, click Create @ (${Math.round(sub.x)},${Math.round(sub.y)})`);
      return res.text + '+modal-create';
    }
    log('OR:KEYS', 'createDialog', 'Create button not found/disabled in the modal');
    return res.text;
  }
  return null;
}

async function orClickCopyKeyIcon(page) {
  // Click the copy icon next to the key. Works for a NEW key (the "key created" modal) and
  // for an OLD key already in the /settings/keys table (edge case: account already has a key).
  return page
    .evaluate(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // 0) A button whose aria-label / title contains "copy" (highest priority, most specific)
      const all = Array.from(document.querySelectorAll('button, [role="button"], a, svg, span, div'));
      for (const el of all) {
        const al = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
        if (al.includes('copy') && !al.includes('copying')) {
          const b = el.closest('button, [role="button"]') || el;
          if (vis(b)) { b.click(); return 'aria-copy: ' + al.trim().slice(0, 30); }
        }
      }
      // 1) A table row / list item holding the key text (sk-or-v1-...) -> click the copy icon in that row.
      //    Old keys in the table are shown as "sk-or-v1-abc...xyz" (truncated), so also check the truncated pattern.
      const keyRow = (e) => {
        const t = (e.innerText || e.textContent || '');
        return /sk-or-v1-[a-z0-9]{4,}/i.test(t);
      };
      const holders = Array.from(document.querySelectorAll('tr, li, div'))
        .filter(keyRow)
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length); // deepest first
      for (const kh of holders) {
        let scope = kh;
        for (let i = 0; i < 4 && scope; i++) {
          // a button that is icon-only (empty text) or contains a copy svg
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
  // Detect whether the keys page already has a key (edge case "api key already exists").
  // A key on the page can appear FULL (right after creation) or MASKED (sk-or-v1-462****e30c).
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
  // Wait for the keys UI to fully render (create button / key rows / empty-state) —
  // avoid acting too early while the SPA is still loading (log 16:55: "create not found").
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
  // Delete ALL keys on the keys page.
  // WAY 1 (primary): click the "Select all rows" checkbox -> a bulk toolbar appears -> click "Delete" (n).
  // WAY 2 (fallback): per row via the "Row actions" button -> menu -> Delete item -> confirm.
  let deleted = 0;
  let fallback = false;

  // ---------- WAY 1: select all + bulk delete ----------
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
      if (!cb || !vis(cb)) return { ok: false, why: 'select-all checkbox not found' };
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
    // find the bulk delete button that appears after select-all (the toolbar)
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
      log(email, 'OR:KEYS', `click bulk delete "${bulk.t}" @ (${Math.round(bulk.x)},${Math.round(bulk.y)})`);
      try { await page.mouse.click(bulk.x, bulk.y); } catch (_) {}
      await new Promise((r) => setTimeout(r, 600));
      // confirm the "Delete" modal — PRIORITY goes to buttons inside the modal
      // (the bulk "Delete" button in the toolbar still has its text; don't click it again)
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
            // 1) the delete button inside the open modal
            if (dialogs.length) {
              const btns = dialogs[dialogs.length - 1].querySelectorAll('button, [role="button"]');
              for (const b of btns) {
                const t = (b.innerText || '').trim().toLowerCase();
                if (vis(b) && (t === 'delete' || t === 'confirm' || t === 'yes' || t === 'yes, delete' || t === 'remove' || t === 'delete keys')) {
                  const r = b.getBoundingClientRect();
                  return { x: r.x + r.width / 2, y: r.y + r.height / 2, t, inDialog: true };
                }
              }
              return null; // modal open but no delete button -> don't click bulk again
            }
            return null;
          })
          .catch(() => null);
        if (!confirm) await new Promise((r) => setTimeout(r, 700));
      }
      if (confirm) {
        try { await page.mouse.click(confirm.x, confirm.y); } catch (_) {}
        log(email, 'OR:KEYS', `click bulk confirm "${confirm.t}" (modal)`);
        await new Promise((r) => setTimeout(r, 600));
      } else {
        log(email, 'OR:KEYS', 'bulk confirmation modal not detected');
      }
      // verify: wait for the DOM re-render — need a STABLE reading (same remainder >= 2 polls
      // after the 2nd poll) OR an empty table. A single reading can be stale (React not yet
      // re-rendered) -> this used to trigger a wasted row-actions fallback (log 16:55).
      let left = null;
      let prevCount = -1;
      for (let vpoll = 0; vpoll < 10; vpoll++) {
        left = await orDetectExistingKeys(page);
        if (left && left.maskedCount === 0 && !left.full) break; // table truly empty
        if (left && left.maskedCount === prevCount && vpoll >= 2) break; // stable
        prevCount = left ? left.maskedCount : -1;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!left) left = await orDetectExistingKeys(page);
      log(email, 'OR:KEYS', `after bulk delete: keys left = ${left.maskedCount}`);
      if (left.maskedCount === 0) return 999; // full success via select-all
      log(email, 'OR:KEYS', 'bulk delete via select-all did not remove everything -> fallback to row-actions');
    } else {
      log(email, 'OR:KEYS', 'bulk delete button did not appear after select-all -> fallback to row-actions');
    }
  }
  fallback = true;

  // ---------- WAY 2 (fallback): row-actions per row ----------
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
    log(email, 'OR:KEYS', `open the row-actions menu via JS click (${opened})`);
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
      log(email, 'OR:KEYS', `click menu item "${menuItem.t}" @ (${Math.round(menuItem.x)},${Math.round(menuItem.y)}) js=${clickedOk}`);
      await new Promise((r) => setTimeout(r, 500));
    } else {
      log(email, 'OR:KEYS', 'Delete item not found in the row actions menu');
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
      log(email, 'OR:KEYS', `click confirm "${confirm.t}"`);
    }
    deleted++;
    await new Promise((r) => setTimeout(r, 600));
  }
  return deleted;
}


async function orReadKeyFromDom(page) {
  // 0) PRIORITY: the "Your new key" modal contains <onepassword-save-button value=BASE64>
  //    holding JSON with the FULL API key (even though the on-screen display is masked).
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
  // Try reading the key directly from the DOM (sometimes shown in full right after creation)
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
  // 1) find the target account row element -> click it with the MOUSE at its coordinates (a JS click
  //    does not trigger navigation on the Google chooser page)
  const target = await page
    .evaluate((email) => {
      const norm = email.toLowerCase();
      // Account cards on the chooser page: div[data-identifier="email"] (multipleChoiceIdentifier)
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
  // 2) old fallback: JS click
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
    // the OAuth popup can be silently closed by Google -> check before evaluate (avoid hanging)
    try {
      if (oauthPage.isClosed()) {
        log(account.email, 'OAUTH', 'OAuth popup CLOSED — assume the flow finished (check the main tab)');
        return { ok: true, detail: 'popup closed (proceed to check the main tab)' };
      }
      const u = oauthPage.url();
      if (!u || u === 'about:blank') {
        log(account.email, 'OAUTH', 'OAuth popup URL empty — assume finished (check the main tab)');
        return { ok: true, detail: 'popup blank (proceed to check the main tab)' };
      }
    } catch (_) {}
    let state = null;
    try {
      state = await classifyGoogleOauth(oauthPage);
    } catch (e) {
      log(account.email, 'OAUTH', `classify failed (${(e && e.message) || e}) — recheck in 2 s`);
      await sleep(800);
      continue;
    }
    if (!state) state = 'UNKNOWN_PAGE';

    repeats = state === lastState ? repeats + 1 : 0;
    lastState = state;

    if (state === 'EMAIL_INPUT' || state === 'PASSWORD_INPUT') await sleep(600);
    log(account.email, `OAUTH:${state}`, `repeats=${repeats} url=${oauthPage.url().slice(0, 80)}`);

    switch (state) {
      case 'CHROME_SIGNIN_PROMPT': {
        if (repeats >= 3) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_CHROME_SIGNIN');
          return { ok: false, detail: 'Sign-in-to-Chrome prompt could not be dismissed' };
        }
        const clicked = await clickByText(oauthPage, ['use chrome without an account', 'lanjutkan tanpa akun', 'no thanks', 'not now']);
        log(account.email, 'OAUTH:CHROME_SIGNIN', `dismiss sync prompt: "${clicked}"`);
        if (!clicked) {
          await sleep(600);
          break;
        }
        await sleep(900);
        break;
      }
      case 'EMAIL_INPUT': {
        if (repeats >= 1 || emailDone) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_EMAIL_LOOP');
          return { ok: false, detail: 'Email page reappeared (wrong email / Next failed)' };
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
          return { ok: false, detail: 'Password rejected / password page reappeared' };
        }
        await typeIntoField(oauthPage, 'input[name="Passwd"], input[type="password"]:not([aria-hidden="true"])', account.password);
        pwdDone = true;
        await clickGoogleNext(oauthPage, '#passwordNext');
        await oauthPage.waitForSelector('input[name="Passwd"], input[type="password"]:not([aria-hidden="true"])', { hidden: true, timeout: CONFIG.actionTimeoutMs }).catch(() => {});
        break;
      }
      case 'BACK_TO_OPENROUTER': {
        log(account.email, 'OAUTH', 'URL returned to openrouter.ai — OAuth finished');
        return { ok: true, detail: 'returned to openrouter.ai' };
      }
      case 'LOADING_INTERSTITIAL': {
        // signin/oauth/id = "You're signing back in" (a confirmation, body text empty/shadow)
        // OR the new account picker. Dual strategy:
        //   (a) click the <button> Continue via mouse
        //   (b) click the account card [data-identifier]
        // SAFETY: never click Next on a /challenge/ (pwd/otp) page —
        // that is not an interstitial; clicking Next there = submitting an empty password repeatedly.
        {
          let cu = '';
          try { cu = new URL(oauthPage.url()).pathname; } catch (_) { cu = oauthPage.url(); }
          if (cu.includes('/challenge/')) {
            log(account.email, 'OAUTH:INTERSTITIAL', `URL ${cu} = a challenge, not an interstitial — wait for the classifier`);
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
              // (b) the account card
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
            log(account.email, 'OAUTH:INTERSTITIAL', `mouse click "${target.what}" @ (${Math.round(target.x)},${Math.round(target.y)})`);
            await sleep(900);
            break;
          }
        }
        if (repeats >= 8) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_INTERSTITIAL_STUCK');
          return { ok: false, detail: 'Google interstitial never finishes' };
        }
        await sleep(700);
        break;
      }
      case 'ACCOUNT_CHOOSER': {
        if (repeats >= 3) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_CHOOSER_STUCK');
          return { ok: false, detail: 'Account chooser will not proceed after several clicks' };
        }
        const action = await handleAccountChooser(oauthPage, account);
        if (!action) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_CHOOSER_FAIL');
          return { ok: false, detail: 'Could not select an account in the chooser' };
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
        return { ok: false, detail: 'Google error page (500/blocked) after submitting credentials' };
      case 'RECOVERY_INFO_PROMPT': {
        if (repeats >= 1) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_RECOVERY');
          return { ok: false, detail: 'Recovery prompt keeps appearing' };
        }
        const clicked = await clickByText(oauthPage, ['not now', 'skip', 'cancel', 'later', 'nanti saja', 'lewati', 'batal']);
        if (clicked) { log(account.email, 'OAUTH:RECOVERY', `click "${clicked}"`); await sleep(500); break; }
        await captureArtifacts(oauthPage, account.email, 'OAUTH_RECOVERY');
        return { ok: false, detail: 'Not now/Skip button not found' };
      }
      case 'WORKSPACE_TERMS': {
        // Google Workspace ToS: check "I accept" then click Accept / Continue
        if (repeats >= 2) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_WS_TERMS');
          return { ok: false, detail: 'Workspace terms could not be accepted' };
        }
        // try to check the "I accept" checkbox if present
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
          log(account.email, 'OAUTH:WORKSPACE_TERMS', `click "${clicked}"`);
          await sleep(800);
          break;
        }
        // fallback 1: the Google material button (jsname LgbsSe) — the speedbump page's main button
        const ok1 = await oauthPage.evaluate(() => {
          const btn = document.querySelector('button[jsname="LgbsSe"]');
          if (btn && !btn.disabled) { btn.click(); return 'jsname-LgbsSe: ' + (btn.innerText || '').trim().slice(0, 30); }
          return null;
        }).catch(() => null);
        if (ok1) { log(account.email, 'OAUTH:WORKSPACE_TERMS', `click button "${ok1}"`); await sleep(800); break; }
        // fallback 2: a button with a workspace-terms-specific id/name
        const ok2 = await oauthPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
          for (const b of btns) {
            const id = (b.id || '') + ' ' + (b.getAttribute('name') || '');
            if (/accept|agree|continue/i.test(id) && !b.disabled) { b.click(); return id; }
          }
          return null;
        }).catch(() => null);
        if (ok2) { log(account.email, 'OAUTH:WORKSPACE_TERMS', `click button "${ok2}"`); await sleep(800); break; }
        await captureArtifacts(oauthPage, account.email, 'OAUTH_WS_TERMS');
        return { ok: false, detail: 'Workspace Terms Accept button not found' };
      }
      case 'TERMS_AGREEMENT': {
        if (repeats >= 3) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_TERMS');
          return { ok: false, detail: 'Terms page keeps appearing' };
        }
        // 1) make sure the "I agree..." checkbox is checked (button[role=checkbox] OR input)
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
        // 2) click the <button> Continue via mouse coordinates
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
          log(account.email, 'OAUTH:TERMS', `mouse click "${btn.text}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
          await sleep(900);
          break;
        }
        await captureArtifacts(oauthPage, account.email, 'OAUTH_TERMS');
        return { ok: false, detail: 'Agree button not found' };
      }
      case 'OAUTH_CONSENT': {
        // Google consent for OpenRouter: click the REAL <button> via mouse coordinates.
        // clickByText is not used here (it often mis-clicks a paragraph title span).
        if (repeats >= 3) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_CONSENT');
          return { ok: false, detail: 'Consent screen could not be continued' };
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
          log(account.email, 'OAUTH:CONSENT', `mouse click "${btn.text}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
          await sleep(900);
          break;
        }
        await captureArtifacts(oauthPage, account.email, 'OAUTH_CONSENT');
        return { ok: false, detail: 'Continue/Allow button not found' };
      }
      case 'UNKNOWN_PAGE':
      default: {
        // Google interstitial (SetSID, /signin/oauth/id while loading) — give it more time
        if (repeats >= 5) {
          await captureArtifacts(oauthPage, account.email, 'OAUTH_UNKNOWN');
          return { ok: false, detail: 'OAuth page not recognized' };
        }
        await sleep(700);
        break;
      }
    }
  }
  return { ok: true, detail: 'OAuth finished / tab back to OpenRouter' };
}

// OpenRouter state machine after login (onboarding + keys). Used both via
// full signup and an existing session (persistent profile).
async function runOrStateMachineOnly(page, email, account) {
  let lastOr = null;
  let orRepeats = 0;
  let orSteps = 0;
  let wizardFullKey = null;
  let lastMaskedCount = null;
  let keyCreated = false;
  let onboardingRounds = 0;
  let authSignInRetries = 0; // budget: max 2 Google sign-in clicks (password rejected -> fail fast)
  let apiKeyResult = null;
  while (orSteps < CONFIG.maxStateMachineSteps) {
      orSteps++;
      // wait for the spinner/loading to disappear (max 8s) before classify — avoid a wrong state during transitions
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
          // The session sometimes expires while navigating to the keys page -> sign-in appears.
          // Try to re-login: click the Google button on sign-in (the Google session is still in the profile),
          // OAuth will flash through the account chooser and return to keys.
          if (orRepeats >= 4 || authSignInRetries >= 2) {
            await captureArtifacts(page, email, 'OR_STUCK_AUTH');
            return {
              ok: false, stage: 'OR_AUTH',
              detail: authSignInRetries >= 2
                ? 'Google sign-in failed 2x (password rejected / blocked by Google) — skip to avoid wasting time'
                : 'Still on the auth page after OAuth (login failed?)',
            };
          }
          // Misclassification of a logged-in home as auth (log 16:42): the session is actually
          // valid. Before giving up, try going straight to /settings/keys — a valid login will
          // classify as KEYS_PAGE and the flow continues normally.
          if (orRepeats === 2) {
            log(email, 'OR:OR_AUTH_PAGE', 'still auth — going straight to /settings/keys (session check)...');
            await page.goto(CONFIG.keysUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch(() => {});
            break;
          }
          if (orState === 'OR_AUTH_PAGE') {
            const g = await orClickGoogleButton(page).catch(() => null);
            if (g) {
              log(email, `OR:${orState}`, `sign-in appeared — click Google (${g}), waiting for quick OAuth...`);
              authSignInRetries++;
              // wait for the return to openrouter.ai (max 25s)
              for (let w = 0; w < 40; w++) {
                await sleep(400);
                try {
                  const host = new URL(page.url()).hostname;
                  if (host === 'openrouter.ai' && !page.url().includes('/sign-in')) break;
                } catch (_) {}
                // an OAuth popup may open — handle it via the tab list
                if (w % 4 === 3) {
                  for (const p2 of await page.browser().pages()) {
                    try {
                      if (p2.url().includes('accounts.google.com')) {
                        const st = await runGoogleOauthStateMachine(p2, (account && account.email === email) ? account : { email, password: '' }, Date.now() + 25000).catch(() => null);
                        log(email, `OR:${orState}`, `oauth popup handled: ${JSON.stringify(st && st.detail ? st.detail : st)}`);
                        // popup failed (password rejected/blocked) -> count it as a sign-in attempt,
                        // don't keep clicking Google forever (log 20:12: 5 wasted attempts)
                        if (st && st.ok === false) authSignInRetries++;
                      }
                      // OAuth has clearly failed 2x -> stop the wait loop (don't
                      // run the state machine again on a stuck popup; log run4 20:50).
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
            if (c) log(email, `OR:${orState}`, `click "${c}"`);
          }
          await sleep(400);
          break;
        }

        case 'OR_ONBOARDING_QUESTIONS': {
          onboardingRounds++;
          if (orRepeats >= 6 || onboardingRounds > 10) {
            await captureArtifacts(page, email, 'OR_ONBOARDING_STUCK');
            return { ok: false, stage: 'ONBOARDING', detail: `Onboarding did not finish after ${onboardingRounds} rounds` };
          }
          const filled = await orHandleOnboarding(page, email);
          log(email, 'OR:ONBOARDING', `fill form: ${JSON.stringify(filled)}`);
          await sleep(250);
          const nxt = await orClickOnboardingNext(page);
          log(email, 'OR:ONBOARDING', `click next: "${nxt}"`);
          await sleep(500);
          await captureArtifacts(page, email, `ONBOARDING_R${onboardingRounds}`, 'step_');
          break;
        }

        case 'OR_LEGAL_CONSENT': {
          // Legal consent: check "I agree..." then click Continue (button, mouse)
          if (orRepeats >= 5) {
            await captureArtifacts(page, email, 'OR_LEGAL_CONSENT_STUCK');
            return { ok: false, stage: 'LEGAL_CONSENT', detail: 'Legal consent could not be continued' };
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
            log(email, 'OR:LEGAL_CONSENT', `mouse click "${btn.text}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
            await sleep(500);
            break;
          }
          // button not rendered yet? wait & retry within this handler (max 5x) — heavy page
          await sleep(1000);
          if (orRepeats < 5) { break; }
          await captureArtifacts(page, email, 'OR_LEGAL_CONSENT_NOBTN');
          return { ok: false, stage: 'LEGAL_CONSENT', detail: 'Legal consent Continue button not found' };
        }

        case 'OR_WIZARD_KEY_STEP': {
          // Wizard step "Your API Key": the key is created automatically (masked here).
          // The full key is shown ONCE on the previous screen; save it if found, then Continue.
          if (orRepeats >= 3) {
            await captureArtifacts(page, email, 'OR_WIZARD_STUCK');
            if (wizardFullKey) {
              apiKeyResult = { source: 'wizard-fallback', key: wizardFullKey };
              appendApiKey(email, wizardFullKey);
              return { ok: true, stage: 'DONE', detail: 'key via wizard-fallback', apiKey: wizardFullKey };
            }
            return { ok: false, stage: 'WIZARD', detail: 'Wizard "Your API Key" could not be continued' };
          }
          const fullHere = await page
            .evaluate(() => {
              const m = (document.body.innerText || '').match(/sk-or-v1-[a-zA-Z0-9]{20,}/);
              return m ? m[0] : null;
            })
            .catch(() => null);
          wizardFullKey = fullHere; // held temporarily; the keys page will delete+create a new one
          log(email, 'OR:WIZARD', fullHere ? 'wizard shows the full key (will be replaced on the keys page)' : 'wizard shows a masked key');
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
            log(email, 'OR:WIZARD', `mouse click "${btn.t}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
            await sleep(600);
            break;
          }
          await sleep(700);
          break;
        }

        case 'OR_WIZARD_PAYMENT_STEP': {
          // payment step: click "I'll do this later" (link/button at the bottom)
          if (orRepeats >= 3) {
            await captureArtifacts(page, email, 'OR_WIZARD_PAYMENT_STUCK');
            return { ok: false, stage: 'WIZARD_PAYMENT', detail: 'Wizard payment step could not be skipped' };
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
            log(email, 'OR:WIZARD', `click skip payment "${btn.t}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
            await sleep(600);
            break;
          }
          await sleep(700);
          break;
        }

        case 'OR_KEYS_PAGE': {
          // Misclassification (log 20:12: sign-in page labeled KEYS_PAGE): the classifier uses
          // content, not the URL. If the URL is clearly not /settings/keys, navigate there first.
          {
            let host = '';
            let path = '';
            try { const u = new URL(page.url()); host = u.hostname; path = u.pathname; } catch (_) {}
            // New OR UI: keys page = /workspaces/<ws>/keys. /settings/keys redirects there,
            // so the old guard (!startsWith('/settings/keys')) looped navigation 34x (log run6).
            const isKeysPath = path.startsWith('/settings/keys') || /\/keys\/?$/.test(path);
            if (host === 'openrouter.ai' && !isKeysPath) {
              log(email, 'OR:OR_KEYS_PAGE', `URL is not the keys page (${path.slice(0, 40)}) -> navigating to the keys page`);
              await page.goto(CONFIG.keysUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch(() => {});
              break;
            }
          }
          // DEFENSE: the first-run onboarding wizard renders AT the /keys URL. If the
          // classifier still routes here with the wizard visible, click through it now —
          // otherwise the delete/create flow misfires into wizard elements.
          {
            const wiz = await page
              .evaluate(() => {
                const rg = document.querySelector('[role="radiogroup"][aria-label*="how will you be using"]');
                if (!rg) return null;
                const card = Array.from(rg.querySelectorAll('[role="radio"]')).find((el) =>
                  (el.innerText || '').trim().toLowerCase().startsWith('individual')
                );
                if (card) { try { card.click(); } catch (_) {} }
                return true;
              })
              .catch(() => null);
            if (wiz) {
              log(email, 'OR:KEYS', 'onboarding wizard visible on keys page -> click Individual + Next');
              await sleep(300);
              const nx = await orClickOnboardingNext(page);
              log(email, 'OR:KEYS', `wizard next: "${nx}"`);
              await sleep(600);
              break;
            }
          }
          if (apiKeyResult) return { ok: true, stage: 'DONE', detail: 'key already obtained', apiKey: apiKeyResult.key };
          if (keyCreated && orRepeats >= 4) {
            // key created but not yet read (the "Your new key" modal didn't appear)
            await captureArtifacts(page, email, 'OR_KEY_READ_FAIL');
            return { ok: false, stage: 'KEY_READ', detail: 'Key created but could not be read' };
          }
          if (keyCreated) await sleep(400); // give the "Your new key" modal time to render
          if (!keyCreated) {
            // ==== NEW EDGE CASE: API KEY ALREADY EXISTS -> DELETE ALL -> CREATE NEW ====
            // Check the PAGE (not api_keys.txt), so it still works even if the txt is empty.
            await orWaitKeysReady(page);
            const det = await orDetectExistingKeys(page);
            if (det && (det.full || det.maskedCount > 0) && !det.noKeys) {
              // progress tracking: if the key count does NOT decrease between passes after
              // several repeats -> fail. If it decreases -> continue with the next delete pass.
              const prev = lastMaskedCount;
              if (prev !== null && det.maskedCount >= prev && orRepeats >= 3) {
                await captureArtifacts(page, email, 'OR_DELETE_FAIL');
                return { ok: false, stage: 'DELETE_OLD_KEYS', detail: `Old keys not decreasing (${det.maskedCount} masked remaining)` };
              }
              lastMaskedCount = det.maskedCount;
              log(email, 'OR:KEYS', `OLD key detected (full=${!!det.full}, masked=${det.maskedCount}, previous=${prev === null ? '-' : prev}) -> DELETE all, then create new`);
              const n = await orDeleteAllKeys(page, email);
              log(email, 'OR:KEYS', `delete old keys: ${n} delete buttons clicked`);
              await sleep(300);
              break; // loop -> re-classify (the key count must decrease)
            }
            // ==== no key (or already deleted): create a new key ====
            log(email, 'OR:KEYS', 'on the keys page, clicking Create Key...');
            await sleep(250);
            const created = await orClickCreateKey(page);
            if (created === 'VERIFY_EMAIL_REQUIRED') {
              await captureArtifacts(page, email, 'OR_VERIFY_EMAIL');
              return { ok: false, stage: 'EMAIL_VERIFY_REQUIRED', detail: 'OpenRouter requires email verification to create a key (code sent to the account email)' };
            }
            if (created) {
              log(email, 'OR:KEYS', `click "${created}"`);
              keyCreated = true;
              await sleep(900);
            } else {
              log(email, 'OR:KEYS', 'create button not found, waiting & retrying');
              if (orRepeats >= 2) {
                await captureArtifacts(page, email, 'OR_NO_CREATE_BTN');
                return { ok: false, stage: 'CREATE_KEY', detail: 'Create API Key button not found' };
              }
              await sleep(800);
            }
          } else {
            // key already created: try to read it
            const read = await orReadKeyFromDom(page);
            if (read) {
              apiKeyResult = read;
              log(email, 'OR:KEYS', `key read (${read.source}): ${read.key.slice(0, 14)}...`);
              appendApiKey(email, read.key);
              return { ok: true, stage: 'DONE', detail: `key via ${read.source}`, apiKey: read };
            }
            // try clicking the copy icon then read the clipboard
            const copyClicked = await orClickCopyKeyIcon(page);
            log(email, 'OR:KEYS', `copy icon: ${copyClicked}`);
            await sleep(800);
            const read2 = await orReadKeyFromDom(page);
            if (read2) {
              apiKeyResult = read2;
              log(email, 'OR:KEYS', `key read (${read2.source}): ${read2.key.slice(0, 14)}...`);
              appendApiKey(email, read2.key);
              return { ok: true, stage: 'DONE', detail: `key via ${read2.source}`, apiKey: read2 };
            }
            if (orRepeats >= 3) {
              await captureArtifacts(page, email, 'OR_KEY_READ_FAIL');
              return { ok: false, stage: 'KEY_READ', detail: 'Could not read the key after copy' };
            }
          }
          break;
        }

        case 'OR_SETTINGS_PAGE': {
          // login succeeded but not on keys -> navigate to keys
          log(email, 'OR:SETTINGS', 'navigating to /settings/keys');
          await page.goto(CONFIG.keysUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch(() => {});
          await sleep(500);
          break;
        }

        case 'OR_CLOUDFLARE': {
          // Cloudflare challenge: try clicking the turnstile checkbox if it appears
          const solved = await maybeSolveTurnstile(page, email);
          if (solved) log(email, 'OR:CLOUDFLARE', 'turnstile clicked');
          if (orRepeats >= 4) {
            await captureArtifacts(page, email, 'OR_CLOUDFLARE_STUCK');
            return { ok: false, stage: 'CLOUDFLARE', detail: 'Cloudflare challenge not passed' };
          }
          await sleep(500);
          break;
        }
        case 'OR_NOT_OPENROUTER': {
          // The main tab strayed to Google (same-tab OAuth) — handle it with the Google state machine,
          // real password from the account. Done -> back to openrouter, the loop continues.
          const u2 = page.url();
          if (u2.includes('accounts.google.com')) {
            if (orRepeats >= 8) {
              await captureArtifacts(page, email, 'OR_STUCK_GOOGLE');
              return { ok: false, stage: 'OR_AUTH', detail: 'Stuck on Google too long' };
            }
            log(email, `OR:${orState}`, 'main tab on Google — running the OAuth state machine (same-tab)');
            const gDone = await runGoogleOauthStateMachine(page, account || { email, password: '' }, Date.now() + 45000).catch(() => null);
            log(email, `OR:${orState}`, `same-tab oauth result: ${JSON.stringify(gDone && gDone.detail ? gDone.detail : gDone)}`);
            // same-tab OAuth failed (password rejected / Google 500) -> count it against the sign-in budget
            // so the account fails fast instead of looping 8x (log test run 3: 20:35).
            if (gDone && gDone.ok === false) {
              authSignInRetries++;
              if (authSignInRetries >= 2) {
                return { ok: false, stage: 'OR_AUTH', detail: `Google OAuth failed repeatedly (${(gDone && gDone.detail) || '?'}) — skip account` };
              }
            }
          }
          await sleep(500);
          break;
        }
        case 'OR_UNKNOWN':
        default: {
          // evaluate can throw during in-flight navigation (race) -> a Google URL must be
          // treated as same-tab OAuth, not UNKNOWN (log 16:47).
          {
            let cu = '';
            try { cu = page.url().toLowerCase(); } catch (_) {}
            if (cu.includes('accounts.google.com')) {
              const gDone = await runGoogleOauthStateMachine(page, account || { email, password: '' }, Date.now() + 45000).catch(() => null);
              log(email, 'OR:UNKNOWN', `google rescue: ${JSON.stringify(gDone && gDone.detail ? gDone.detail : gDone)}`);
              if (gDone && gDone.ok === false) {
                authSignInRetries++;
                if (authSignInRetries >= 2) {
                  return { ok: false, stage: 'OR_AUTH', detail: `Google OAuth failed repeatedly (${(gDone && gDone.detail) || '?'}) — skip account` };
                }
              }
              await sleep(400);
              break;
            }
          }
          if (orRepeats >= 3) {
            await captureArtifacts(page, email, 'OR_UNKNOWN_STUCK');
            return { ok: false, stage: 'OR_UNKNOWN', detail: `Unrecognized OpenRouter page: ${page.url().slice(0, 80)}` };
          }
          await sleep(800);
          break;
        }
      }
    }

  await captureArtifacts(page, email, 'OR_MAX_STEPS');
  return { ok: false, stage: 'MAX_STEPS', detail: `Exceeded ${CONFIG.maxStateMachineSteps} steps`, bail: true };
}

// ===================== MAIN FLOW =====================

async function maybeSolveTurnstile(page, email) {
  // Cloudflare Turnstile via Clerk: the div#clerk-captcha container holds an iframe
  // from challenges.cloudflare.com with a "Verify you are human" checkbox.
  // Strategy: get the container/iframe bounding box then click the checkbox area (left-center).
  try {
    // 1) the turnstile frame directly
    for (const f of page.frames()) {
      if (!f.url().includes('challenges.cloudflare.com')) continue;
      const el = await f.frameElement();
      if (!el) continue;
      const box = await el.boundingBox();
      if (!box || box.width < 20 || box.height < 20) continue;
      const x = box.x + Math.min(30, box.width / 4);
      const y = box.y + box.height / 2;
      await page.mouse.click(x, y);
      log(email, 'TURNSTILE', `click checkbox iframe @ (${Math.round(x)},${Math.round(y)}) box=${Math.round(box.width)}x${Math.round(box.height)}`);
      return true;
    }
    // 2) the #clerk-captcha container (its bounding box)
    const cont = await page.$('#clerk-captcha');
    if (cont) {
      const box = await cont.boundingBox();
      if (box && box.width > 20 && box.height > 20) {
        const x = box.x + Math.min(30, box.width / 4);
        const y = box.y + box.height / 2;
        await page.mouse.click(x, y);
        log(email, 'TURNSTILE', `click container @ (${Math.round(x)},${Math.round(y)}) box=${Math.round(box.width)}x${Math.round(box.height)}`);
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
        log(email, 'TURNSTILE', `click .cf-turnstile @ (${Math.round(x)},${Math.round(y)}) box=${Math.round(box.width)}x${Math.round(box.height)}`);
        return true;
      }
    }
  } catch (e) {
    log(email, 'TURNSTILE', `error: ${e.message}`);
  }
  return false;
}

async function hasTurnstile(page) {
  // Only TRUE if the turnstile widget is REALLY displayed (a visible container
  // with a real size). The #clerk-captcha element / hidden input is always present
  // in Clerk markup even when the widget is inactive -> false positive without a visibility check.
  try {
    const vis = await page.evaluate(() => {
      const visEl = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      // the Clerk captcha container that is actually displayed
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
  log(email, 'START', `account ${idx + 1}/${total}`);

  // A separate Chrome profile per account (not incognito): Google rejects
  // sign-in from automation in an incognito context ("may not be secure"),
  // but a persistent profile + stealth passes more often.
  const profileDir = path.join('chrome_profiles', safeName(email));
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) {}
  const launchOpts = {
    headless: CONFIG.headless,
    args: [...LAUNCH_ARGS],
    defaultViewport: null,
    userDataDir: profileDir,
    protocolTimeout: 20000, // an evaluate/click hanging 20 s -> throws instead of hanging forever
  };
  const exe = resolveChromeExecutable();
  if (exe) launchOpts.executablePath = exe;
  else launchOpts.channel = 'chrome';
  // HEADLESS: the headless UA contains 'HeadlessChrome' -> Google rejects login (500).
  // The UA string is overridden per-page to the headful version below.

  const browser = await puppeteer.launch(launchOpts);
  let page = null;
  let apiKeyResult = null;

  try {
    // the default context (persistent profile) — not incognito
    const context = browser.defaultBrowserContext();
    try {
      await context.overridePermissions('https://openrouter.ai', ['clipboard-read', 'clipboard-write']);
    } catch (_) {}
    const pages = await browser.pages();
    page = pages.length ? pages[0] : await context.newPage();
    // Window title = the account being processed (easy to tell apart during multi-runs)
    // Headful UA: 'HeadlessChrome/x' -> 'Chrome/x' (the rest of the string identical).
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
    log(email, 'STEP1', `open ${CONFIG.homeUrl}`);
    await page.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch((e) => {
      log(email, 'NAV_WARN', e.message);
    });
    await sleep(300);
    await captureArtifacts(page, email, 'HOME');

    // ---- STEP 1.5: check if ALREADY LOGGED IN (persistent profile) -> skip straight to the OR state machine ----
    let preState = await classifyOpenRouter(page).catch(() => null);
    for (let pc = 0; pc < 3 && !preState; pc++) {
      await sleep(400); // the home SPA hasn't finished rendering — don't decide the route from a half-built DOM
      preState = await classifyOpenRouter(page).catch(() => null);
    }
    const preLoginStates = ['OR_KEYS_PAGE', 'OR_SETTINGS_PAGE', 'OR_ONBOARDING_QUESTIONS', 'OR_LEGAL_CONSENT', 'OR_WIZARD_KEY_STEP', 'OR_WIZARD_PAYMENT_STEP'];
    // OR_HOME also signals login if home does NOT offer "Sign Up" (header user menu).
    const homeNoSignup = preState === 'OR_HOME' && await page
      .evaluate(() => {
        const txt = (document.body.innerText || '').toLowerCase();
        return !txt.includes('sign up') && !txt.includes('sign in');
      })
      .catch(() => false);
    if (preLoginStates.includes(preState) || homeNoSignup) {
      log(email, 'STEP1.5', `already logged in detected (${preState}) — skip signup, straight to the OR state machine`);
      const done = await runOrStateMachineOnly(page, email, account);
      return done;
    }

    // ---- STEP 2: click Sign Up in the header ----
    log(email, 'STEP2', 'find and click Sign Up');
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
      // Probably already on the auth page via /auth
      log(email, 'STEP2', 'Sign Up not found on home, going straight to /auth');
      await page.goto('https://openrouter.ai/auth', { waitUntil: 'domcontentloaded', timeout: CONFIG.gotoTimeoutMs }).catch(() => {});
      await sleep(800);
    } else {
      log(email, 'STEP2', `click "${clicked}"`);
      await sleep(300);
    }

    // ---- STEP 3: click the Google button on the auth page ----
    let gAttempts = 0;
    let gClicked = null;
    let authReloaded = false;
    while (gAttempts < 8 && !gClicked) {
      // if 5 attempts fail, reload the auth page once (sometimes Clerk doesn't render)
      if (gAttempts === 5 && !authReloaded) {
        authReloaded = true;
        log(email, 'STEP3', 'reloading the auth page (Google button not appearing)...');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(700);
      }
      // Turnstile can appear BEFORE clicking Google (inside the sign-up modal)
      if (await hasTurnstile(page)) {
        log(email, 'STEP3', 'Turnstile detected before clicking Google, trying to solve it...');
        let solved = false;
        for (let t = 0; t < 4 && !solved; t++) {
          solved = await maybeSolveTurnstile(page, email);
          if (!solved) { await sleep(700); }
        }
        if (!solved) {
          await captureArtifacts(page, email, 'TURNSTILE_PRE_GOOGLE');
          return { ok: false, stage: 'TURNSTILE', detail: 'Turnstile appeared on the auth page and could not be solved' };
        }
        await sleep(500);
      }
      gClicked = await orClickGoogleButton(page);
      if (!gClicked) {
        log(email, 'STEP3', `Google button not present yet (attempt ${gAttempts + 1}), waiting...`);
        await sleep(700);
      }
      gAttempts++;
    }
    if (!gClicked) {
      await captureArtifacts(page, email, 'NO_GOOGLE_BTN');
      return { ok: false, stage: 'GOOGLE_BTN', detail: 'Google button not found on the auth page' };
    }
    log(email, 'STEP3', `click Google via ${gClicked}`);
    await sleep(400);

    // ---- STEP 4: find the Google OAuth page (popup / redirect), handle Turnstile ----
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
        // The Clerk same-tab redirect takes time. Don't rush: let the polling loop
        // discover the URL change (popup OR main tab to google OR a quick sso-callback).
        try {
          const mu = page.url().toLowerCase();
          if (mu.includes('sso-callback')) {
            // Quick OAuth finished (google session still present) — immediately assume done
            log(email, 'STEP4', 'quick sso-callback detected — OAuth finished without a popup');
            oauthPage = page;
            break;
          }
        } catch (_) {}
      }
      if (!oauthPage) {
        // Turnstile can appear AFTER clicking Google (before the redirect to Google)
        if (await hasTurnstile(page)) {
          const solved = await maybeSolveTurnstile(page, email);
          if (solved) log(email, 'STEP4', 'Turnstile after clicking Google: clicked');
        }
        await sleep(400);
      }
    }
    if (!oauthPage) {
      // No popup — check the main tab: it may be same-tab OAuth, OR it went straight
      // to the OpenRouter sign-up page (legal consent) because the Google session still exists.
      const mainUrl = page.url().toLowerCase();
      if (mainUrl.includes('accounts.google.com')) {
        oauthPage = page;
        log(email, 'STEP4', 'OAuth happened in the main tab (same-tab)');
      } else if (mainUrl.startsWith('https://openrouter.ai') || mainUrl.startsWith('http://openrouter.ai') || mainUrl.includes('openrouter.ai/#') || mainUrl.includes('openrouter.ai/')) {
        log(email, 'STEP4', 'No OAuth popup; continuing to the OpenRouter state machine (Google session may still exist)');
        const r = await runGoogleOauthStateMachine(page, account, Date.now() + 20000);
        log(email, 'STEP4', `pre-OR state machine: ${JSON.stringify(r && r.detail ? r.detail : r)}`);
        // continue to STEP6 (not full OAuth)
        oauthPage = page;
      } else {
        await captureArtifacts(page, email, 'NO_OAUTH_PAGE');
        return { ok: false, stage: 'OAUTH_PAGE', detail: 'Google OAuth page did not appear' };
      }
    }
    if (oauthPage !== page) { try { await oauthPage.bringToFront(); } catch (_) {} }
    log(email, 'STEP4', `OAuth page: ${oauthPage.url().slice(0, 70)}`);

    // ---- STEP 5: run the OAuth state machine ----
    const oauthDeadline = Date.now() + CONFIG.oauthTimeoutMs;
    const oauthResult = await runGoogleOauthStateMachine(oauthPage, account, oauthDeadline);
    await captureArtifacts(oauthPage, email, 'OAUTH_END', 'step_');
    if (!oauthResult.ok) {
      return { ok: false, stage: 'OAUTH', detail: oauthResult.detail };
    }
    log(email, 'STEP5', 'OAuth OK, back to OpenRouter');

    // back to the main page
    if (oauthPage !== page) { try { await page.bringToFront(); } catch (_) {} }

    // ---- STEP 6: wait for the redirect/verification to finish on openrouter.ai ----
    // If the MAIN TAB is still on Google (chooser/consent in the main tab), finish it first.
    for (let round = 0; round < 3; round++) {
      let mainU = '';
      try { mainU = page.url().toLowerCase(); } catch (_) {}
      if (!mainU.includes('accounts.google')) break;
      log(email, 'STEP6', `main tab still on Google (${mainU.slice(0, 60)}), finishing it...`);
      const gPage = (oauthPage && !oauthPage.isClosed() && (oauthPage.url() || '').includes('accounts.google')) ? oauthPage : page;
      const extra = await runGoogleOauthStateMachine(gPage, account, Date.now() + 60000);
      if (!extra.ok) {
        await captureArtifacts(page, email, 'STEP6_GOOGLE_STUCK');
        return { ok: false, stage: 'OAUTH', detail: `Step6 still on Google: ${extra.detail}` };
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
    log(email, 'STEP6', `URL after OAuth: ${settledUrl.slice(0, 80)}`);

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

// Catch crashes not handled by try/catch (unhandledRejection kills Node 15+)
process.on('unhandledRejection', (e) => {
  log('MAIN', 'UNHANDLED_REJECTION', (e && (e.stack || e.message)) || String(e));
});
process.on('uncaughtException', (e) => {
  log('MAIN', 'UNCAUGHT_EXCEPTION', (e && (e.stack || e.message)) || String(e));
});

(async () => {
  ensureDirs();
  if (!resolveChromeExecutable() && !process.env.CHROME_PATH) {
    log('MAIN', 'FATAL', 'Chrome not found. Install Chrome or set CHROME_PATH.');
    process.exit(1);
  }
  const all = readAccounts();
  if (!all.length) {
    log('MAIN', 'FATAL', 'account.txt is empty. Format: email|password per line.');
    process.exit(1);
  }
  const done = loadExistingEmails();
  let accounts = all.filter((a) => !done.has(a.email.toLowerCase()));
  if (!accounts.length) {
    log('MAIN', 'INFO', 'All accounts already have an API key.');
    process.exit(0);
  }
  if (process.env.MAX_ACCOUNTS) {
    const n = parseInt(process.env.MAX_ACCOUNTS, 10);
    if (n > 0 && n < accounts.length) accounts = accounts.slice(0, n);
  }
  log('MAIN', 'INFO', `${accounts.length}/${all.length} accounts to be processed`);

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
  log('MAIN', 'SUMMARY', `done: ${success} succeeded, ${fail} failed of ${accounts.length} accounts`);
  process.exit(0);
})().catch((e) => {
  log('MAIN', 'FATAL', e && e.message ? e.message : String(e));
  process.exit(1);
});
