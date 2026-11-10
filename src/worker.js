import { runChecks, readStatus } from './durum.js';
import { translateTexts } from './ceviri.js';
import { visitors } from './ziyaret.js';

// Federal Gold site worker.
// Everything is served from static assets, except /admin:
//   /admin/login   password form (secret PANEL_SIFRE), sets a signed session cookie
//   /admin/logout  clears the cookie
//   /admin/api/gitlab/*  proxy to GitLab with the server-side token (secret GITLAB_TOKEN),
//                        only for the site repository and only with a valid session
//   /admin/config.yml    panel config with this host's URLs and branch filled in
//   other /admin paths   need a valid session, otherwise redirect to the login form

const REPO = 'sozlu99-hue/federal-gold';
const REPO_ID = '88683014';
const LIVE_HOST = 'federalgold.org';
const COOKIE = 'fg_panel';
const SESSION_DAYS = 14;

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`${env.PANEL_SIFRE}\u0000${env.GITLAB_TOKEN}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// Two kinds of sign-in: the owner (PANEL_SIFRE, everything) and "abi" (PANEL_SIFRE_ABI: Vitrin and Site İçeriği,
// but no history, status or visitor pages, and nothing from the repository's history).
async function makeSession(env, role = 'owner') {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const payload = role === 'owner' ? exp : `${exp}~${role}`;
  return `${payload}.${await hmac(env, role === 'abi' ? `${payload}\u0000${env.PANEL_SIFRE_ABI}` : payload)}`;
}

// returns 'owner', 'abi' or null
async function hasSession(request, env) {
  if (!env.PANEL_SIFRE || !env.GITLAB_TOKEN) return null;
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const [exp, role = 'owner'] = payload.split('~');
  if (Number(exp) < Date.now() || !['owner', 'abi'].includes(role)) return null;
  if (role === 'abi' && !env.PANEL_SIFRE_ABI) return null; // removing the secret signs abi out everywhere
  if (!safeEqual(sig, await hmac(env, role === 'abi' ? `${payload}\u0000${env.PANEL_SIFRE_ABI}` : payload))) return null;
  return role;
}

const cookieHeader = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// browsers remember to use https only (6 months); subdomains are left alone
const HSTS = 'max-age=15552000';
const securityHeaders = {
  'Strict-Transport-Security': HSTS,
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

// ---- Wrong-password limit: 5 wrong tries per address, then 15 minutes locked ----
// Kept in the Cloudflare cache (per data centre), so it costs no storage writes.
const LOCK_TRIES = 5, LOCK_SECONDS = 900;
const lockKey = (request) => new Request(`https://login-lock.federalgold.internal/${encodeURIComponent(request.headers.get('CF-Connecting-IP') || 'unknown')}`);
async function failedTries(request) {
  try { const r = await caches.default.match(lockKey(request)); return r ? Number(await r.text()) || 0 : 0; } catch { return 0; }
}
async function setFailedTries(request, n) {
  try {
    if (n <= 0) await caches.default.delete(lockKey(request));
    else await caches.default.put(lockKey(request), new Response(String(n), { headers: { 'Cache-Control': `max-age=${LOCK_SECONDS}` } }));
  } catch { /* the delay below still slows guessing */ }
}

// Panel only on the real address; preview copies (*.workers.dev) show the site but not the panel
function panelElsewherePage() {
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Federal Gold Paneli</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0b0a09;color:#f5f0e6;font:16px/1.5 -apple-system,'Segoe UI',Arial,sans-serif;text-align:center}
a{display:inline-block;margin-top:14px;padding:12px 20px;border-radius:10px;background:#d9b062;color:#1a1307;font-weight:700;text-decoration:none}</style></head>
<body><div><p>Bu adres bir önizleme. Panel sadece gerçek sitede açılır.</p><a href="https://${LIVE_HOST}/admin/">federalgold.org/admin</a></div></body></html>`;
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders } });
}

function loginPage({ error = '', notConfigured = false, status = 200 } = {}) {
  const msg = notConfigured
    ? '<p class="err">Panel henüz yapılandırılmadı (Cloudflare\'de PANEL_SIFRE ve GITLAB_TOKEN eksik).</p>'
    : error ? `<p class="err">${error}</p>` : '';
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex, nofollow">
<title>Federal Gold — Panel Girişi</title><link rel="manifest" href="/assets/panel/manifest.webmanifest"><link rel="apple-touch-icon" href="/assets/panel/apple-touch-icon.png"><meta name="theme-color" content="#0b0a09"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="FG Panel"><meta name="apple-mobile-web-app-status-bar-style" content="black"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Manrope:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#0b0a09;--g:#d9b062;--gl:#f0d59a;--t:#f5f0e6;--m:#b9b0a2}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom));color:var(--t);font:16px/1.5 Manrope,-apple-system,'Segoe UI',Arial,sans-serif;background:var(--bg);overflow-x:hidden}
.bg{position:fixed;inset:-40px;background:url(/assets/magaza-1.webp) center 35%/cover no-repeat;filter:blur(6px) saturate(1.1);transform:scale(1.08);animation:drift 26s ease-in-out infinite alternate;z-index:-2}
.bg::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 80% at 50% 30%,rgba(11,10,9,.55),rgba(11,10,9,.92) 70%),linear-gradient(180deg,rgba(11,10,9,.3),rgba(11,10,9,.95))}
@keyframes drift{from{transform:scale(1.08) translate3d(0,0,0)}to{transform:scale(1.16) translate3d(-18px,-12px,0)}}
.card{position:relative;width:100%;max-width:400px;padding:34px 26px 26px;border-radius:22px;background:rgba(20,18,15,.62);border:1px solid rgba(217,176,98,.28);box-shadow:0 30px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.04);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);animation:rise .9s cubic-bezier(.2,.8,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(24px) scale(.98)}to{opacity:1;transform:none}}
.logo{position:relative;width:92px;height:92px;margin:0 auto 14px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 1px rgba(217,176,98,.35),0 0 40px rgba(217,176,98,.25);animation:glow 3.2s ease-in-out infinite}
.logo img{display:block;width:100%;height:100%}
.logo::after{content:"";position:absolute;inset:-40%;background:linear-gradient(115deg,transparent 40%,rgba(255,240,200,.55) 50%,transparent 60%);transform:translateX(-120%);animation:shine 3.6s ease-in-out 1s infinite}
@keyframes shine{0%{transform:translateX(-120%)}55%,100%{transform:translateX(120%)}}
@keyframes glow{0%,100%{box-shadow:0 0 0 1px rgba(217,176,98,.35),0 0 30px rgba(217,176,98,.18)}50%{box-shadow:0 0 0 1px rgba(217,176,98,.55),0 0 56px rgba(217,176,98,.38)}}
.hello{margin:0;text-align:center;font-size:14px;letter-spacing:.02em;color:var(--m)}
h1{margin:2px 0 4px;text-align:center;font:600 34px/1.1 'Cormorant Garamond',Georgia,serif;background:linear-gradient(90deg,#c9963f,#f6e2a8 40%,#d9b062 60%,#b8862f);-webkit-background-clip:text;background-clip:text;color:transparent;background-size:200% auto;animation:gold 6s linear infinite}
@keyframes gold{to{background-position:200% center}}
.sub{margin:0 0 20px;text-align:center;color:var(--m);font-size:13px}
.ticker{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin:0 0 22px;min-height:30px}
.chip{display:inline-flex;align-items:baseline;gap:6px;padding:6px 12px;border-radius:999px;background:rgba(217,176,98,.08);border:1px solid rgba(217,176,98,.28);font-size:13px;color:var(--m);opacity:0;animation:rise .6s ease both}
.chip b{color:var(--gl);font-weight:700;font-variant-numeric:tabular-nums}
label{display:block;font-size:13px;color:var(--m);margin-bottom:6px}
.field{position:relative}
input{width:100%;min-height:54px;padding:0 50px 0 16px;border-radius:14px;border:1px solid rgba(217,176,98,.3);background:rgba(11,10,9,.7);color:var(--t);font:500 17px Manrope,sans-serif;transition:border-color .2s,box-shadow .2s}
input:focus{outline:none;border-color:var(--g);box-shadow:0 0 0 4px rgba(217,176,98,.15)}
.eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:42px;height:42px;border:0;border-radius:10px;background:transparent;color:var(--m);font-size:18px;cursor:pointer}
button[type=submit]{position:relative;width:100%;min-height:54px;margin-top:16px;border:0;border-radius:14px;background:linear-gradient(135deg,#e7c47c,#c99a45);color:#1a1307;font:700 16px Manrope,sans-serif;letter-spacing:.02em;cursor:pointer;overflow:hidden;box-shadow:0 10px 30px rgba(217,176,98,.25);transition:transform .15s}
button[type=submit]:active{transform:scale(.98)}
button[type=submit]::after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 35%,rgba(255,255,255,.45) 50%,transparent 65%);transform:translateX(-120%);animation:shine 4s ease-in-out 2s infinite}
.err{margin:0 0 14px;padding:10px 12px;border-radius:12px;background:rgba(240,138,122,.12);border:1px solid rgba(240,138,122,.4);color:#f3b2a7;font-size:14px;animation:shake .4s}
@keyframes shake{25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
.foot{margin:18px 0 0;text-align:center;font-size:12px;color:rgba(185,176,162,.7)}
@media (prefers-reduced-motion:reduce){*,*::after{animation:none!important}}
</style></head><body>
<div class="bg" aria-hidden="true"></div>
<form class="card" method="post" action="/admin/login" autocomplete="on">
<div class="logo"><img src="/assets/panel/apple-touch-icon.png" alt=""></div>
<p class="hello" id="hello">Hoş geldin</p>
<h1>Federal Gold</h1><p class="sub">Yönetim Paneli · Kapalıçarşı</p>
<div class="ticker" id="ticker" aria-live="polite"></div>
${msg}
<label for="p">Şifre</label>
<div class="field"><input id="p" name="password" type="password" autocomplete="current-password" required autofocus><button class="eye" type="button" aria-label="Şifreyi göster" onclick="var i=document.getElementById('p');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'👁':'🙈'">👁</button></div>
<button type="submit">Giriş yap</button>
<p class="foot">© ${new Date().getFullYear()} Federal Gold Kuyumculuk</p>
</form>
<script>
(function(){
  var h=new Date().toLocaleString('en-US',{timeZone:'Europe/Istanbul',hour:'numeric',hour12:false})|0;
  document.getElementById('hello').textContent=h<5?'İyi geceler':h<11?'Günaydın':h<17?'İyi günler':h<22?'İyi akşamlar':'İyi geceler';
  var fmt=function(n){return new Intl.NumberFormat('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n)+' ₺'};
  fetch('https://finans.truncgil.com/v4/today.json',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
    var t=document.getElementById('ticker');
    [['Gram','GRA'],['Çeyrek','CEYREKALTIN'],['Dolar','USD']].forEach(function(x,i){
      var v=d[x[1]]&&d[x[1]].Selling; if(!v)return;
      var c=document.createElement('span');c.className='chip';c.style.animationDelay=(.15*i)+'s';
      c.textContent=x[0]+' ';var b=document.createElement('b');b.textContent=fmt(v);c.appendChild(b);t.appendChild(c);
    });
  }).catch(function(){});
})();
</script></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders } });
}

function allowedGitLabPath(path) {
  if (path === '/graphql') return true;
  if (path === '/v4/user' || path === '/v4/version') return true;
  const enc1 = encodeURIComponent(REPO);
  return path === `/v4/projects/${enc1}` || path.startsWith(`/v4/projects/${enc1}/`)
    || path === `/v4/projects/${REPO_ID}` || path.startsWith(`/v4/projects/${REPO_ID}/`);
}

// For "abi": only what the Vitrin editor needs, and every name, e-mail or note from the repository history is hidden
const ABI_FILES = /^(data\/(products|site)\.json|assets\/(products\/)?[^/]+\.(webp|jpe?g|png|gif|avif))$/i;
// Only the fields that describe who saved and why are replaced. File contents (rawTextBlob, content, diffs) and every
// other text pass through untouched, so what the panel loads and saves is exactly what is in the repository.
const WHO = /^(author|committer)$/i, WHO_TEXT = /^(author|committer|authored_by|committed_by)_?(name|email|gravatar)?$/i;
const NOTE = /^(message|full_?title|title(_?html)?|description(_?html)?|trailers|extended_trailers|signature(_?html)?)$/i;
const scrubPerson = (o) => {
  const out = {};
  for (const [k, x] of Object.entries(o)) {
    out[k] = /email/i.test(k) ? 'panel@federalgold.org' : /^(name|username|login)$/i.test(k) ? 'Federal Gold'
      : /url|avatar/i.test(k) ? '' : (x && typeof x === 'object' ? scrubPerson(x) : x);
  }
  return out;
};
const scrub = (v) => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (WHO.test(k) && x && typeof x === 'object' && !Array.isArray(x)) out[k] = scrubPerson(x);
      else if (WHO_TEXT.test(k) && typeof x === 'string') out[k] = /email/i.test(k) ? 'panel@federalgold.org' : /gravatar/i.test(k) ? '' : 'Federal Gold';
      else if (NOTE.test(k) && (typeof x === 'string' || (x && typeof x === 'object'))) out[k] = typeof x === 'string' ? 'Panel kaydı' : (Array.isArray(x) ? [] : {});
      else out[k] = scrub(x);
    }
    return out;
  }
  return v;
};

async function abiAllowed(request, rest, url) {
  const m = request.method;
  if (rest === '/graphql') {
    // read-only queries; mutations are not used by the panel's GitLab backend for saving
    const body = await request.clone().text();
    return !/\bmutation\b/i.test(body);
  }
  if (m === 'GET' || m === 'HEAD') return !/\/repository\/commits\/[^/]+\/(revert|cherry_pick)|\/(members|variables|hooks|deploy_keys|access_tokens)/.test(rest);
  if (m === 'POST' && /\/repository\/commits$/.test(rest)) {
    let body;
    try { body = await request.clone().json(); } catch { return false; }
    const actions = Array.isArray(body && body.actions) ? body.actions : [];
    return body.branch === 'main' && actions.length > 0 && actions.every((a) => a && ABI_FILES.test(String(a.file_path || ''))
      && (!a.previous_path || ABI_FILES.test(String(a.previous_path))));
  }
  return false;
}

async function proxyGitLab(request, env, url, role = 'owner') {
  // /admin/api/gitlab/v4/... -> https://gitlab.com/api/v4/... ; /admin/api/gitlab/graphql -> https://gitlab.com/api/graphql
  const rest = url.pathname.slice('/admin/api/gitlab'.length);
  // keep the raw (still encoded) path so "sozlu99-hue%2Ffederal-gold" stays one segment
  const rawRest = request.url.split('?')[0].replace(/^https?:\/\/[^/]+\/admin\/api\/gitlab/, '');
  if (!allowedGitLabPath(rest) && !allowedGitLabPath(rawRest)) {
    return new Response('Forbidden', { status: 403, headers: securityHeaders });
  }
  if (role === 'abi' && !(await abiAllowed(request, decodeURIComponent(rawRest), url))) {
    return new Response(JSON.stringify({ message: 'Bu işlem için yetkin yok.' }), { status: 403, headers: { 'Content-Type': 'application/json', ...securityHeaders } });
  }
  const target = `https://gitlab.com/api${rawRest}${url.search}`;
  const headers = new Headers();
  for (const h of ['Content-Type', 'Accept', 'If-None-Match']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Authorization', `Bearer ${env.GITLAB_TOKEN}`);
  const init = { method: request.method, headers, redirect: 'follow' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
  const res = await fetch(target, init);
  const out = new Headers(res.headers);
  out.delete('Set-Cookie');
  out.set('Cache-Control', 'no-store');
  // the panel shows the signed-in account: show the shop, not the GitLab account behind the panel
  if (rest === '/v4/user' && res.ok) {
    const u = await res.json().catch(() => ({}));
    out.delete('Content-Length'); out.delete('Content-Encoding'); out.delete('ETag');
    const shown = { ...(role === 'abi' ? {} : u), id: u.id, username: 'federalgold', name: 'Federal Gold', email: 'panel@federalgold.org',
      public_email: '', commit_email: 'panel@federalgold.org', avatar_url: `${url.origin}/assets/panel/icon-192.png`, web_url: `https://${LIVE_HOST}`, state: 'active' };
    return new Response(JSON.stringify(shown), { status: res.status, headers: out });
  }
  if (role === 'abi' && res.ok && (out.get('Content-Type') || '').includes('json')) {
    const data = await res.json().catch(() => null);
    out.delete('Content-Length'); out.delete('Content-Encoding'); out.delete('ETag');
    return new Response(JSON.stringify(scrub(data)), { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, headers: out });
}

async function panelConfig(request, env, url, role = 'owner') {
  const res = await env.ASSETS.fetch(new Request(new URL('/admin/config.yml', url), request));
  if (!res.ok) return res;
  // federalgold.org edits the live site (main); a preview like "<branch>-federal-gold.<x>.workers.dev" edits that branch
  const m = url.hostname.match(/^([a-z0-9-]+?)-federal-gold\./);
  const branch = m ? m[1] : 'main';
  let text = (await res.text())
    .replaceAll('__ORIGIN__', url.origin)
    .replaceAll('__BRANCH__', branch);
  return new Response(text, { headers: { 'Content-Type': 'text/yaml; charset=utf-8', ...securityHeaders } });
}

// ---- Site content (data/site.json, edited in the panel) applied to the home page ----
const DEFAULTS = {
  iletisim: { magazaTel: '+90 212 511 74 28', whatsapp: '+90 542 390 59 67', semdinliTel: '+90 549 405 05 00', vanTel: '+90 532 442 17 84',
    eposta: 'federalgold@hotmail.com', instagram: 'federalgoldd', instagram2: 'federal_goldd2' },
  fotograflar: { anaEkran: '/assets/hero.webp', hakkimizda: '/assets/founder.webp', kapalicarsi: '/assets/store-kapalicarsi.webp',
    semdinli: '/assets/store-semdinli.webp', van: '', bilezikler: '/assets/bracelets.webp', yuzukler: '/assets/rings.webp',
    kolyeler: '/assets/necklaces.webp', kupeler: '/assets/earrings.webp' },
};
const digits = (s) => String(s || '').replace(/\D/g, '');
const intl = (s) => { let d = digits(s); if (d.startsWith('0')) d = '9' + d; else if (d.length === 10) d = '90' + d; return d; };
const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rel = (p) => String(p || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
const safePath = (p, preview = false) => {
  // in the panel preview, not-yet-saved uploads arrive as blob: URLs of the panel page
  if (preview && /^blob:https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9-]+$/.test(String(p || ''))) return String(p);
  // letters of any language are fine (a phone may name an upload "ımg_2911.png"); no ".." or odd characters
  const r = rel('/' + rel(p));
  return /^\/?assets\/[\p{L}\p{N}/_.,() -]+\.(webp|jpe?g|png|gif|avif)$/iu.test(r) && !r.includes('..') ? rel(p) : '';
};

function flatten(lang) {
  const out = {};
  for (const sec of Object.values(lang || {})) {
    if (sec && typeof sec === 'object') for (const [k, v] of Object.entries(sec)) if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

const EDIT_BRIDGE = `(() => {
  const C = window.__FG_EDIT__ || { map: {}, phones: {} };
  const CARD = { bracelets: 'bilezikler', rings: 'yuzukler', necklaces: 'kolyeler', earrings: 'kupeler' };
  const target = (t) => {
    const lang = document.documentElement.lang === 'en' ? 'en' : 'tr';
    const prod = t.closest('#vitrin-grid [data-i]');
    if (prod) return { c: 'vitrin', p: 'products.' + prod.dataset.i + (t.closest('img, .product-img') ? '.image' : '.name') };
    const i18n = t.closest('[data-i18n]');
    if (i18n && C.map[i18n.dataset.i18n]) return { c: 'site', p: lang + '.' + C.map[i18n.dataset.i18n] + '.' + i18n.dataset.i18n };
    const a = t.closest('a[href]');
    if (a) {
      const h = a.getAttribute('href') || '';
      if (h.startsWith('tel:')) { const k = C.phones[h.replace(/\\D/g, '')]; if (k) return { c: 'site', p: 'iletisim.' + k }; }
      if (h.includes('wa.me/')) return { c: 'site', p: 'iletisim.whatsapp' };
      if (h.startsWith('mailto:')) return { c: 'site', p: 'iletisim.eposta' };
      if (h.includes('instagram.com/')) return { c: 'site', p: C.insta2 && h.includes('/' + C.insta2 + '/') ? 'iletisim.instagram2' : 'iletisim.instagram' };
    }
    if (t.closest('figure.founder-photo')) return { c: 'site', p: 'fotograflar.hakkimizda' };
    const store = t.closest('.visit-card[data-store]');
    if (store && t.closest('figure.store-photo')) return { c: 'site', p: 'fotograflar.' + store.dataset.store };
    const cat = t.closest('.category-card[data-product]');
    if (cat && CARD[cat.dataset.product]) return { c: 'site', p: 'fotograflar.' + CARD[cat.dataset.product] };
    if (t.closest('.hero')) return { c: 'site', p: 'fotograflar.anaEkran' };
    return null;
  };
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : e.target.parentElement;
    if (!t || t.closest('[data-lang], #vitrin-chips, #menu-toggle, .lb-btn, #calc select, #calc input')) return;
    e.preventDefault(); e.stopPropagation();
    const hit = target(t);
    // the preview sits in nested blob:/srcdoc frames whose origin is opaque, so no target origin can be named
    if (hit) window.top.postMessage({ fgEdit: hit.p, collection: hit.c }, '*');
  }, true);
})();`;

async function renderHome(request, env, preview = null) {
  const res = await env.ASSETS.fetch(preview ? new Request(new URL('/', request.url)) : request);
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok || !type.includes('text/html')) return res;
  let site = preview && preview.site && typeof preview.site === 'object' ? preview.site : null;
  if (!site) {
    try {
      const r = await env.ASSETS.fetch(new Request(new URL('/data/site.json', request.url)));
      site = r.ok ? await r.json() : null;
    } catch { site = null; }
  }
  if (!site && !preview) return res;
  site = site || {};
  const pv = Boolean(preview);

  let html = await res.text();
  const c = { ...DEFAULTS.iletisim, ...(site.iletisim || {}) };
  const f = { ...DEFAULTS.fotograflar, ...(site.fotograflar || {}) };

  // phones: display text, tel: links and wa.me links
  const phones = [['magazaTel', false], ['whatsapp', true], ['semdinliTel', false], ['vanTel', false]];
  for (const [key, isWa] of phones) {
    const from = DEFAULTS.iletisim[key], to = String(c[key] || '').trim();
    if (!to || to === from) continue;
    html = html.split(from).join(htmlEsc(to));
    html = html.split('+' + intl(from)).join('+' + intl(to));
    if (isWa) html = html.split('wa.me/' + intl(from)).join('wa.me/' + intl(to));
  }
  if (c.eposta && c.eposta !== DEFAULTS.iletisim.eposta) html = html.split(DEFAULTS.iletisim.eposta).join(htmlEsc(c.eposta.trim()));
  for (const key of ['instagram', 'instagram2']) {
    const from = DEFAULTS.iletisim[key], to = String(c[key] || '').trim().replace(/^@/, '');
    if (!to || to === from || !/^[A-Za-z0-9._]+$/.test(to)) continue;
    html = html.split(`instagram.com/${from}/`).join(`instagram.com/${to}/`).split(`@${from}`).join(`@${to}`);
  }
  // photos that are always shown: swap the path everywhere (CSS, preload, structured data)
  for (const key of ['anaEkran', 'bilezikler', 'yuzukler', 'kolyeler', 'kupeler']) {
    const from = rel(DEFAULTS.fotograflar[key]), to = safePath(f[key], pv);
    if (to && to !== from) html = html.split(from).join(to);
  }

  const tr = flatten(site.tr), en = flatten(site.en);
  // extra store photos ("+N fotoğraf"); a store without a main photo uses its first extra photo
  const galeri = {};
  for (const key of ['kapalicarsi', 'semdinli', 'van']) {
    let list = (Array.isArray(f[key + 'Galeri']) ? f[key + 'Galeri'] : [])
      .map((x) => safePath(x && typeof x === 'object' ? x.foto : x, pv)).filter(Boolean)
      .map((x) => (/^blob:/.test(x) ? x : '/' + x));
    if (!f[key] && list.length) { f[key] = list[0]; list = list.slice(1); }
    if (list.length) galeri[key] = list;
  }
  // rate table settings from the panel: which rows, in which order, and the shop's own margin (₺)
  const fark = (v) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) < 1e7 ? n : 0; };
  const kur = (Array.isArray(site.kurTablosu) ? site.kurTablosu : []).filter((k) => k && typeof k.kalem === 'string')
    .slice(0, 30).map((k) => ({ kalem: k.kalem.slice(0, 40), goster: k.goster !== false, satis: fark(k.satisFark), alis: fark(k.alisFark) }));
  // Mağazamız section: shelf photos
  const magaza = (Array.isArray(f.magaza) ? f.magaza : []).map((x) => safePath(x && typeof x === 'object' ? x.foto : x, pv))
    .filter(Boolean).map((x) => (/^blob:/.test(x) ? x : '/' + x)).slice(0, 24);
  const json = JSON.stringify({ tr, en, galeri, kur, magaza }).replace(/</g, '\\u003c');
  const photo = (key) => (f[key] === '' || f[key] == null) ? '' : safePath(f[key], pv);

  // Panel preview only: clicking a text, photo, number or product opens that field in the editor
  let bridge = '';
  if (pv) {
    const map = {};
    for (const [sec, obj] of Object.entries(site.tr || {})) if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) map[k] = sec;
    const phones = {};
    for (const k of ['magazaTel', 'whatsapp', 'semdinliTel', 'vanTel']) phones[intl(c[k] || DEFAULTS.iletisim[k])] = k;
    const cfg = JSON.stringify({ map, phones, insta2: String(c.instagram2 || '').replace(/^@/, '') }).replace(/</g, '\\u003c');
    bridge = `<style>[data-i18n]:hover,#vitrin-grid [data-i]:hover,figure:hover,.category-card:hover,a[href^="tel:"]:hover,.floating-whatsapp:hover{outline:2px dashed #d9b062!important;outline-offset:3px;cursor:pointer}</style>`
      + `<script>window.__FG_EDIT__=${cfg}</script><script>${EDIT_BRIDGE}</script>`;
  }
  const products = preview && Array.isArray(preview.products)
    ? `<script>window.__PRODUCTS__=${JSON.stringify(preview.products).replace(/</g, '\\u003c')}</script>` : '';
  let rw = new HTMLRewriter()
    .on('head', { element(e) {
      if (pv) e.prepend('<base href="/" target="_blank"><meta name="robots" content="noindex">', { html: true });
      e.append(`<script>window.__SITE__=${json}</script>${products}${bridge}`, { html: true });
    } })
    .on('[data-i18n]', { element(e) { const k = e.getAttribute('data-i18n'); if (tr[k] != null) e.setInnerContent(tr[k]); } })
    .on('[data-i18n-alt]', { element(e) { const k = e.getAttribute('data-i18n-alt'); if (tr[k] != null) e.setAttribute('alt', tr[k]); } })
    .on('title', { element(e) { if (tr.title) e.setInnerContent(tr.title); } })
    .on('meta[name="description"]', { element(e) { if (tr.meta) e.setAttribute('content', tr.meta); } })
    .on('meta[property="og:title"]', { element(e) { if (tr.ogTitle) e.setAttribute('content', tr.ogTitle); } })
    .on('meta[property="og:description"]', { element(e) { if (tr.ogDesc) e.setAttribute('content', tr.ogDesc); } });

  // About photo: replace or remove (text then spans the full width)
  const about = photo('hakkimizda');
  if (!about) {
    rw = rw.on('figure.founder-photo', { element(e) { e.remove(); } })
      .on('head', { element(e) { e.append('<style>.about-grid{grid-template-columns:minmax(0,760px)}</style>', { html: true }); } });
  } else if (about !== rel(DEFAULTS.fotograflar.hakkimizda)) {
    rw = rw.on('figure.founder-photo img', { element(e) { e.setAttribute('src', about); e.removeAttribute('width'); e.removeAttribute('height'); } });
  }
  // Store photos: replace, remove, or add (Van has no photo by default)
  for (const key of ['kapalicarsi', 'semdinli', 'van']) {
    const src = photo(key), def = rel(DEFAULTS.fotograflar[key]);
    if (!src) rw = rw.on(`.visit-card[data-store="${key}"] figure.store-photo`, { element(e) { e.remove(); } });
    else if (!def) rw = rw.on(`.visit-card[data-store="${key}"]`, { element(e) {
      e.prepend(`<figure class="store-photo"><img src="${htmlEsc(src)}" alt="Federal Gold ${htmlEsc(key)} şubesi" loading="lazy"></figure>`, { html: true }); } });
    else if (src !== def) rw = rw.on(`.visit-card[data-store="${key}"] figure.store-photo img`, { element(e) {
      e.setAttribute('src', src); e.removeAttribute('width'); e.removeAttribute('height'); } });
  }

  const headers = new Headers(res.headers);
  headers.delete('Content-Length');
  headers.set('Strict-Transport-Security', HSTS);
  if (pv) for (const [k, v] of Object.entries(securityHeaders)) if (k !== 'X-Frame-Options') headers.set(k, v);
  return rw.transform(new Response(html, { status: res.status, headers }));
}

// ---- Product name from photo (Workers AI, used by the panel when a product has no name) ----
const CATEGORIES = ['bracelets', 'rings', 'necklaces', 'earrings', 'watches', 'other'];
const DESCRIBE_PROMPT = `Sen Kapalıçarşı'da bir kuyumcunun vitrin ürünlerine isim veren bir asistansın.
Önce fotoğrafta en çok yer kaplayan ürün türüne bak: bilekte takılan halkalar bilezik/kelepçedir, boyna takılan
kolye/gerdanlık/zincirdir, parmakta yüzük, kulakta küpe; düz külçe ve sikkeler "other" kategorisidir.
Kuyumcu diliyle adlandır (bilezik, kelepçe, burma, hasır, gurmet, kolye, gerdanlık, set, zincir, yüzük, tektaş,
alyans, küpe, halka, çeyrek, külçe, saat). Ayar, gram, fiyat, marka ve "güzel", "şık" gibi sıfatlar YAZMA.
Emin olmadığın taş veya motif adı uydurma. Sadece şu JSON'u yaz, başka hiçbir şey yazma:
{"name": "2-4 kelimelik Türkçe ürün adı, Baş Harfleri Büyük", "nameEn": "English name", "category": "bracelets|rings|necklaces|earrings|watches|other"}`;
const DESCRIBE_MODELS = ['@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/meta/llama-4-scout-17b-16e-instruct'];

function parseDescription(out) {
  let r = out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) ?? out.result ?? out);
  if (r && typeof r === 'object' && r.name) return r;
  const m = String(typeof r === 'object' ? JSON.stringify(r) : r || '').match(/\{[^{}]*"name"[^{}]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

async function describeProduct(request, env) {
  if (!env.AI) return Response.json({ error: 'AI kullanılamıyor' }, { status: 503, headers: securityHeaders });
  let body;
  try { body = await request.json(); } catch { return new Response('Bad request', { status: 400, headers: securityHeaders }); }
  const image = String(body && body.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 2_000_000) {
    return new Response('Bad image', { status: 400, headers: securityHeaders });
  }
  let lastErr = '';
  // each model twice: the image models occasionally fail on a single call
  for (const model of [...DESCRIBE_MODELS, ...DESCRIBE_MODELS]) {
    try {
      const out = await env.AI.run(model, { max_tokens: 160, messages: [{ role: 'user', content: [
        { type: 'text', text: DESCRIBE_PROMPT }, { type: 'image_url', image_url: { url: image } }] }] });
      const d = parseDescription(out);
      if (!d || !d.name) { lastErr = 'unparsed: ' + JSON.stringify(out).slice(0, 300); continue; }
      const clean = (v) => String(v || '').replace(/["<>]/g, '').replace(/\bfederal\s*gold\b/ig, '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return Response.json({ name: clean(d.name), nameEn: clean(d.nameEn), category: CATEGORIES.includes(d.category) ? d.category : 'other' },
        { headers: securityHeaders });
    } catch (e) { lastErr = String(e && e.message || e).slice(0, 300); /* try the next model */ }
  }
  return Response.json({ error: 'Fotoğraftan isim çıkarılamadı', detail: lastErr }, { status: 502, headers: securityHeaders });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    // one address for the site: www → federalgold.org
    if (url.hostname === `www.${LIVE_HOST}`) return Response.redirect(`https://${LIVE_HOST}${p}${url.search}`, 301);
    if (p === '/' && (request.method === 'GET' || request.method === 'HEAD')) return renderHome(request, env);
    if (p !== '/admin' && !p.startsWith('/admin/')) return env.ASSETS.fetch(request);
    if (url.hostname !== LIVE_HOST && !['localhost', '127.0.0.1'].includes(url.hostname)) return panelElsewherePage();

    const configured = Boolean(env.PANEL_SIFRE && env.GITLAB_TOKEN);

    if (p === '/admin/login') {
      if (!configured) return loginPage({ notConfigured: true });
      if (request.method === 'POST') {
        // attempt limits that hold across Cloudflare's servers: 5 a minute per address, 30 a minute for everyone together
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const limits = await Promise.all([
          env.LOGIN_IP ? env.LOGIN_IP.limit({ key: ip }).catch(() => ({ success: true })) : { success: true },
          env.LOGIN_ALL ? env.LOGIN_ALL.limit({ key: 'all' }).catch(() => ({ success: true })) : { success: true },
        ]);
        if (limits.some((l) => !l.success)) {
          await new Promise((r) => setTimeout(r, 1500));
          return loginPage({ error: 'Çok fazla deneme. 1 dakika bekleyip tekrar dene.', status: 429 });
        }
        const tries = await failedTries(request);
        if (tries >= LOCK_TRIES) {
          await new Promise((r) => setTimeout(r, 1500));
          return loginPage({ error: 'Çok fazla yanlış deneme. 15 dakika sonra tekrar dene.', status: 429 });
        }
        const form = await request.formData().catch(() => null);
        const given = form ? String(form.get('password') || '') : '';
        const role = given && safeEqual(given, env.PANEL_SIFRE) ? 'owner'
          : given && env.PANEL_SIFRE_ABI && safeEqual(given, env.PANEL_SIFRE_ABI) ? 'abi' : null;
        if (role) {
          if (tries) await setFailedTries(request, 0);
          // The panel signs itself in (admin/boot.js); the real GitLab token never leaves this worker.
          return new Response(null, { status: 303, headers: {
            Location: '/admin/', 'Set-Cookie': cookieHeader(await makeSession(env, role), SESSION_DAYS * 86400), ...securityHeaders } });
        }
        await setFailedTries(request, tries + 1);
        await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
        const left = LOCK_TRIES - tries - 1;
        return loginPage({ error: left > 0 ? `Şifre yanlış. (${left} deneme hakkın kaldı)` : 'Şifre yanlış. 15 dakika boyunca giriş kapalı.' });
      }
      if (await hasSession(request, env)) return Response.redirect(`${url.origin}/admin/`, 303);
      return loginPage();
    }

    if (p === '/admin/logout') {
      return new Response(null, { status: 303, headers: { Location: '/admin/login', 'Set-Cookie': cookieHeader('', 0), ...securityHeaders } });
    }

    const role = await hasSession(request, env);
    if (!role) {
      if (p.startsWith('/admin/api/')) return new Response('Unauthorized', { status: 401, headers: { ...securityHeaders, 'X-Panel-Session': 'expired' } });
      return Response.redirect(`${url.origin}/admin/login`, 303);
    }

    if (p.startsWith('/admin/api/gitlab/')) return proxyGitLab(request, env, url, role);
    // abi: no history, status or visitor numbers
    if (role === 'abi' && /^\/admin\/api\/(status|visitors)/.test(p)) return new Response('Forbidden', { status: 403, headers: securityHeaders });
    if (p === '/admin/api/describe' && request.method === 'POST') return describeProduct(request, env);
    if (p === '/admin/api/translate' && request.method === 'POST') return translateTexts(request, env);
    if (p === '/admin/api/visitors' && request.method === 'GET') return visitors(request, env);
    if (p === '/admin/api/status' && request.method === 'GET') return Response.json(await readStatus(env), { headers: securityHeaders });
    if (p === '/admin/api/status/run' && request.method === 'POST') return Response.json(await runChecks(env, renderHome), { headers: securityHeaders });
    if (p === '/admin/api/preview' && request.method === 'POST') {
      // Live preview for the panel: the home page rendered with the unsaved entry data
      let body;
      try { body = await request.json(); } catch { return new Response('Bad request', { status: 400, headers: securityHeaders }); }
      if (JSON.stringify(body).length > 500000) return new Response('Too large', { status: 413, headers: securityHeaders });
      return renderHome(request, env, { site: body.site, products: body.products });
    }
    if (p === '/admin/config.yml') return panelConfig(request, env, url, role);

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(securityHeaders)) out.headers.set(k, v);
    // tell the panel page who signed in, so it can hide the owner-only pages
    if ((out.headers.get('Content-Type') || '').includes('text/html')) {
      return new HTMLRewriter().on('head', { element(e) { e.prepend(`<script>window.__FG_ROLE__=${JSON.stringify(role)}</script>`, { html: true }); } }).transform(out);
    }
    return out;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, renderHome));
  },
};
