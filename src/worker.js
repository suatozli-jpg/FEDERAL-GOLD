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

async function makeSession(env) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return `${exp}.${await hmac(env, exp)}`;
}

async function hasSession(request, env) {
  if (!env.PANEL_SIFRE || !env.GITLAB_TOKEN) return false;
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env, exp));
}

const cookieHeader = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

function loginPage({ error = '', notConfigured = false } = {}) {
  const msg = notConfigured
    ? '<p class="err">Panel henüz yapılandırılmadı (Cloudflare\'de PANEL_SIFRE ve GITLAB_TOKEN eksik).</p>'
    : error ? `<p class="err">${error}</p>` : '';
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Federal Gold — Panel Girişi</title><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<style>
:root{--bg:#0b0a09;--s:#14120f;--l:#3a3022;--g:#d9b062;--gl:#f0d59a;--t:#f5f0e6;--m:#b9b0a2}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--t);font:16px/1.5 -apple-system,'Segoe UI',Arial,sans-serif}
form{width:100%;max-width:380px;background:var(--s);border:1px solid var(--l);border-radius:16px;padding:28px 22px}
img{display:block;width:64px;height:64px;margin:0 auto 10px}h1{margin:0 0 4px;text-align:center;font:600 26px/1.2 Georgia,serif;color:var(--gl)}
p.sub{margin:0 0 22px;text-align:center;color:var(--m);font-size:14px}label{display:block;font-size:14px;color:var(--m);margin-bottom:6px}
input{width:100%;min-height:50px;padding:0 14px;border-radius:10px;border:1px solid var(--l);background:#0d0b09;color:var(--t);font-size:17px}
input:focus{outline:none;border-color:var(--g)}button{width:100%;min-height:50px;margin-top:16px;border:0;border-radius:10px;background:var(--g);color:#1a1307;font-weight:700;font-size:16px}
.err{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:rgba(240,138,122,.12);border:1px solid rgba(240,138,122,.4);color:#f3b2a7;font-size:14px}
</style></head><body>
<form method="post" action="/admin/login" autocomplete="on">
<img src="/assets/logo-mark.webp" alt=""><h1>Ürün Paneli</h1><p class="sub">Federal Gold</p>${msg}
<label for="p">Şifre</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Giriş yap</button></form></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders } });
}

function allowedGitLabPath(path) {
  if (path === '/graphql') return true;
  if (path === '/v4/user' || path === '/v4/version') return true;
  const enc1 = encodeURIComponent(REPO);
  return path === `/v4/projects/${enc1}` || path.startsWith(`/v4/projects/${enc1}/`)
    || path === `/v4/projects/${REPO_ID}` || path.startsWith(`/v4/projects/${REPO_ID}/`);
}

async function proxyGitLab(request, env, url) {
  // /admin/api/gitlab/v4/... -> https://gitlab.com/api/v4/... ; /admin/api/gitlab/graphql -> https://gitlab.com/api/graphql
  const rest = url.pathname.slice('/admin/api/gitlab'.length);
  // keep the raw (still encoded) path so "sozlu99-hue%2Ffederal-gold" stays one segment
  const rawRest = request.url.split('?')[0].replace(/^https?:\/\/[^/]+\/admin\/api\/gitlab/, '');
  if (!allowedGitLabPath(rest) && !allowedGitLabPath(rawRest)) {
    return new Response('Forbidden', { status: 403, headers: securityHeaders });
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
  return new Response(res.body, { status: res.status, headers: out });
}

async function panelConfig(request, env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/admin/config.yml', url), request));
  if (!res.ok) return res;
  const branch = url.hostname === LIVE_HOST || url.hostname === `www.${LIVE_HOST}` ? 'main' : 'panel';
  const text = (await res.text())
    .replaceAll('__ORIGIN__', url.origin)
    .replaceAll('__BRANCH__', branch);
  return new Response(text, { headers: { 'Content-Type': 'text/yaml; charset=utf-8', ...securityHeaders } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p !== '/admin' && !p.startsWith('/admin/')) return env.ASSETS.fetch(request);

    const configured = Boolean(env.PANEL_SIFRE && env.GITLAB_TOKEN);

    if (p === '/admin/login') {
      if (!configured) return loginPage({ notConfigured: true });
      if (request.method === 'POST') {
        const form = await request.formData().catch(() => null);
        const given = form ? String(form.get('password') || '') : '';
        if (given && safeEqual(given, env.PANEL_SIFRE)) {
          // Sign the panel in automatically: its "sign in on another device" link carries a
          // placeholder token; the real GitLab token never leaves this worker.
          const magic = b64url(enc.encode(JSON.stringify({ token: 'panel-session' })));
          return new Response(null, { status: 303, headers: {
            Location: `/admin/#/signin/${magic}`, 'Set-Cookie': cookieHeader(await makeSession(env), SESSION_DAYS * 86400), ...securityHeaders } });
        }
        await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
        return loginPage({ error: 'Şifre yanlış.' });
      }
      if (await hasSession(request, env)) return Response.redirect(`${url.origin}/admin/`, 303);
      return loginPage();
    }

    if (p === '/admin/logout') {
      return new Response(null, { status: 303, headers: { Location: '/admin/login', 'Set-Cookie': cookieHeader('', 0), ...securityHeaders } });
    }

    if (!(await hasSession(request, env))) {
      if (p.startsWith('/admin/api/')) return new Response('Unauthorized', { status: 401, headers: securityHeaders });
      return Response.redirect(`${url.origin}/admin/login`, 303);
    }

    if (p.startsWith('/admin/api/gitlab/')) return proxyGitLab(request, env, url);
    if (p === '/admin/config.yml') return panelConfig(request, env, url);

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(securityHeaders)) out.headers.set(k, v);
    return out;
  },
};
