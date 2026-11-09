// Site health checks ("Site Durumu"). Run every hour by the cron trigger and on demand from the
// panel. Results are kept in KV (binding DURUM): "latest" and a rolling 7-day "history".
// When the send_email binding ALERT exists, a problem seen in two runs in a row is e-mailed, and so is the recovery.

import { EmailMessage } from 'cloudflare:email';
import { visitors } from './ziyaret.js';

const SITE = 'https://federalgold.org';
const REPO_API = 'https://gitlab.com/api/v4/projects/sozlu99-hue%2Ffederal-gold';
const HAREM_WS = 'https://hrmsocketonly.haremaltin.com/socket.io/?EIO=4&transport=websocket';
const BACKUP_URL = 'https://finans.truncgil.com/v4/today.json';
const RDAP = 'https://rdap.publicinterestregistry.org/rdap/domain/federalgold.org';
const CATEGORIES = ['bracelets', 'rings', 'necklaces', 'earrings', 'watches', 'other'];

const ok = (id, title, detail) => ({ id, title, status: 'ok', detail });
const warn = (id, title, detail) => ({ id, title, status: 'warn', detail });
const err = (id, title, detail) => ({ id, title, status: 'err', detail });
const days = (iso) => Math.floor((new Date(iso).getTime() - Date.now()) / 864e5);

const timed = async (fn, ms = 10000) => {
  let t;
  return Promise.race([fn(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('zaman aşımı')), ms); })]).finally(() => clearTimeout(t));
};

const asset = (env, path, method = 'GET') => env.ASSETS.fetch(new Request(new URL(path, SITE), { method }));

async function checkHome(env, renderHome) {
  const t0 = Date.now();
  const res = await renderHome(new Request(`${SITE}/`), env);
  const html = await res.text();
  const ms = Date.now() - t0;
  if (res.status !== 200 || !html.includes('<h1')) return err('site', 'Site açılıyor', `Ana sayfa hata veriyor (${res.status})`);
  return ok('site', 'Site açılıyor', `Ana sayfa hazırlandı · ${ms} ms`);
}

async function checkProductsAndPhotos(env) {
  const out = [];
  let products = [];
  try {
    const res = await asset(env, '/data/products.json');
    products = await res.json();
    if (!Array.isArray(products)) throw new Error('liste değil');
  } catch (e) {
    return [err('urunler', 'Ürün dosyası', `products.json okunamadı (${e.message})`)];
  }
  const issues = [];
  products.forEach((p, i) => {
    const label = (p && p.name) || `${i + 1}. ürün`;
    if (!p || !String(p.name || '').trim()) issues.push(`${i + 1}. ürünün adı boş (sitede görünmez)`);
    if (!p || !p.image) issues.push(`${label}: fotoğraf yok`);
    if (p && p.category && !CATEGORIES.includes(p.category)) issues.push(`${label}: kategori geçersiz`);
  });
  const shown = products.filter((p) => p && p.visible !== false).length;
  out.push(issues.length
    ? warn('urunler', 'Ürün dosyası', `${products.length} ürün · ${issues.slice(0, 3).join(' · ')}`)
    : ok('urunler', 'Ürün dosyası', `${products.length} ürün (${shown} tanesi sitede görünüyor) · sorun yok`));

  let site = {};
  try { site = await (await asset(env, '/data/site.json')).json(); } catch { /* defaults */ }
  const paths = new Set(products.flatMap((p) => (p ? [p.image, ...[].concat(p.images || [])] : [])).filter(Boolean));
  for (const v of Object.values((site && site.fotograflar) || {})) for (const x of [].concat(v || [])) if (x) paths.add(typeof x === 'object' ? x.foto : x);
  ['/assets/hero.webp', '/assets/logo-full.webp', '/assets/logo-mark.webp'].forEach((p) => paths.add(p));
  const broken = [];
  await Promise.all([...paths].map(async (p) => {
    try {
      const r = await asset(env, p.startsWith('/') ? p : `/${p}`, 'HEAD');
      if (!r.ok || !(r.headers.get('Content-Type') || '').startsWith('image/')) broken.push(p);
    } catch { broken.push(p); }
  }));
  out.push(broken.length
    ? err('foto', 'Fotoğraflar', `${broken.length} kırık fotoğraf: ${broken.slice(0, 3).join(', ')}`)
    : ok('foto', 'Fotoğraflar', `${paths.size} fotoğraf kontrol edildi · kırık yok`));
  return out;
}

async function checkHarem() {
  const t0 = Date.now();
  try {
    const gram = await timed(async () => {
      const res = await fetch(HAREM_WS, { headers: { Upgrade: 'websocket' } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`bağlantı kurulamadı (${res.status})`);
      ws.accept();
      return new Promise((resolve, reject) => {
        ws.addEventListener('message', (e) => {
          const m = String(e.data);
          if (m.startsWith('0')) ws.send('40');
          else if (m === '2') ws.send('3');
          else if (m.startsWith('42')) {
            try {
              const data = JSON.parse(m.slice(2))[1].data || {};
              ws.close(1000);
              resolve(data.KULCEALTIN && data.KULCEALTIN.satis);
            } catch (e2) { reject(e2); }
          }
        });
        ws.addEventListener('close', () => reject(new Error('bağlantı kapandı')));
        ws.addEventListener('error', () => reject(new Error('bağlantı hatası')));
      });
    }, 12000);
    const g = Number(gram);
    return ok('harem', 'Canlı kur (Harem)', `Bağlandı · ${Date.now() - t0} ms${g ? ` · Gram ${g.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺` : ''}`);
  } catch (e) {
    return err('harem', 'Canlı kur (Harem)', `Bağlanılamadı (${e.message}) · site yedek kaynağa geçer`);
  }
}

async function checkBackup() {
  // the backup server sometimes drops a single connection from Cloudflare: try up to three times before warning
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const res = await timed(() => fetch(`${BACKUP_URL}?t=${Date.now()}`, { headers: { Accept: 'application/json' } }));
      const d = await res.json();
      if (!res.ok || !d || !d.GRA) throw new Error(`yanıt ${res.status}`);
      return ok('yedek', 'Yedek kur kaynağı', `Çalışıyor · ${Date.now() - t0} ms${attempt > 1 ? ` · ${attempt}. denemede` : ''}`);
    } catch (e) {
      lastErr = e.message;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return warn('yedek', 'Yedek kur kaynağı', `3 denemede de yanıt vermedi (${lastErr}) · site Harem'le çalışmaya devam ediyor`);
}

async function checkPanel(env) {
  if (!env.PANEL_SIFRE || !env.GITLAB_TOKEN) return err('panel', 'Ürün paneli', 'Şifre veya GitLab anahtarı Cloudflare\'de eksik');
  try {
    const res = await timed(() => fetch(REPO_API, { headers: { Authorization: `Bearer ${env.GITLAB_TOKEN}` } }));
    if (!res.ok) return err('panel', 'Ürün paneli', `GitLab anahtarı çalışmıyor (${res.status}) · panelden kayıt yapılamaz`);
    let detail = 'Giriş ve kayıt çalışıyor';
    const self = await fetch('https://gitlab.com/api/v4/personal_access_tokens/self', { headers: { Authorization: `Bearer ${env.GITLAB_TOKEN}` } });
    if (self.ok) {
      const t = await self.json();
      if (t.expires_at) {
        const d = days(t.expires_at);
        if (d < 30) return warn('panel', 'Ürün paneli', `GitLab anahtarının süresi ${d} gün içinde doluyor · yenilenmeli`);
        detail += ` · GitLab anahtarı ${d} gün geçerli`;
      }
    }
    return ok('panel', 'Ürün paneli', detail);
  } catch (e) {
    return warn('panel', 'Ürün paneli', `GitLab'a ulaşılamadı (${e.message})`);
  }
}

async function checkFiles(env) {
  const missing = [];
  for (const p of ['/sitemap.xml', '/robots.txt', '/favicon.ico', '/favicon-48.png', '/404.html']) {
    try { const r = await asset(env, p, 'HEAD'); if (!r.ok) missing.push(p); } catch { missing.push(p); }
  }
  return missing.length
    ? warn('dosya', 'Sitemap · robots · ikon', `Eksik: ${missing.join(', ')}`)
    : ok('dosya', 'Sitemap · robots · ikon', 'Hepsi yerinde');
}

async function checkVisitors(env) {
  const res = await timed(() => visitors(new Request(`${SITE}/admin/api/visitors?gun=1`), env));
  const d = await res.json();
  if (res.ok) {
    const today = (d.days || []).slice(-1)[0] || { visits: 0 };
    return ok('ziyaret', 'Ziyaretçi sayacı', `Çalışıyor · bugün ${today.visits} ziyaret`);
  }
  if (d.error === 'missing_token') return warn('ziyaret', 'Ziyaretçi sayacı', 'Cloudflare anahtarı (CF_ANALYTICS_TOKEN) eklenmemiş');
  if (d.error === 'bad_token') return err('ziyaret', 'Ziyaretçi sayacı', `Cloudflare anahtarı çalışmıyor (${d.detail || ''}) · yenilenmeli`);
  return warn('ziyaret', 'Ziyaretçi sayacı', `Sayılar alınamadı (${d.detail || d.error})`);
}

async function checkDomain() {
  try {
    const d = await (await timed(() => fetch(RDAP, { headers: { Accept: 'application/rdap+json' } }))).json();
    const exp = (d.events || []).find((e) => e.eventAction === 'expiration');
    if (!exp) return warn('alanadi', 'Alan adı', 'Bitiş tarihi okunamadı');
    const left = days(exp.eventDate);
    const date = new Date(exp.eventDate).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
    if (left < 30) return err('alanadi', 'Alan adı', `federalgold.org · ${date} · ${left} gün kaldı · hemen yenile`);
    if (left < 90) return warn('alanadi', 'Alan adı', `federalgold.org · ${date} · ${left} gün kaldı · yenilemeyi unutma`);
    return ok('alanadi', 'Alan adı', `federalgold.org · ${date} · ${left} gün kaldı`);
  } catch (e) {
    return warn('alanadi', 'Alan adı', `Kontrol edilemedi (${e.message})`);
  }
}

export async function runChecks(env, renderHome) {
  const settle = async (fn, id, title) => { try { return await fn(); } catch (e) { return err(id, title, `Kontrol çalışmadı (${e.message})`); } };
  const parts = await Promise.all([
    settle(() => checkHome(env, renderHome), 'site', 'Site açılıyor'),
    settle(() => checkProductsAndPhotos(env), 'urunler', 'Ürünler ve fotoğraflar'),
    settle(checkHarem, 'harem', 'Canlı kur (Harem)'),
    settle(checkBackup, 'yedek', 'Yedek kur kaynağı'),
    settle(() => checkPanel(env), 'panel', 'Ürün paneli'),
    settle(() => checkFiles(env), 'dosya', 'Sitemap · robots · ikon'),
    settle(checkDomain, 'alanadi', 'Alan adı'),
    settle(() => checkVisitors(env), 'ziyaret', 'Ziyaretçi sayacı'),
  ]);
  const results = parts.flat();
  const worst = results.some((r) => r.status === 'err') ? 'err' : results.some((r) => r.status === 'warn') ? 'warn' : 'ok';
  const run = { time: new Date().toISOString(), status: worst, results };
  if (env.DURUM) {
    let previous = null;
    try { previous = JSON.parse((await env.DURUM.get('latest')) || 'null'); } catch { previous = null; }
    await alertIfChanged(env, run, previous).catch((e) => console.warn('alert mail failed', e && e.message));
    await env.DURUM.put('latest', JSON.stringify(run));
    let history = [];
    try { history = JSON.parse((await env.DURUM.get('history')) || '[]'); } catch { history = []; }
    history.push({ time: run.time, status: worst });
    await env.DURUM.put('history', JSON.stringify(history.slice(-24 * 8)));
  }
  return run;
}

// ---- e-mail alerts ----
const ALERT_FROM = 'durum@federalgold.org';
const b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin);
};

async function sendMail(env, subject, text) {
  const to = env.ALERT_TO || 'federalgold@hotmail.com';
  const raw = [
    `From: Federal Gold Site Durumu <${ALERT_FROM}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@federalgold.org>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  await env.ALERT.send(new EmailMessage(ALERT_FROM, to, raw));
}

// Problems (warn/err) present in this run and the previous one; a single blip (e.g. Harem for one hour) is not mailed.
async function alertIfChanged(env, run, previous) {
  if (!env.ALERT || !env.DURUM) return;
  const before = new Map(((previous && previous.results) || []).filter((r) => r.status !== 'ok').map((r) => [r.id, r.status]));
  const problems = run.results.filter((r) => r.status !== 'ok' && before.has(r.id));
  const sig = problems.map((r) => `${r.id}:${r.status}`).sort().join(',');
  const last = (await env.DURUM.get('alerted')) || '';
  if (sig === last) return;
  if (sig) {
    const worst = problems.some((r) => r.status === 'err');
    await sendMail(env, `${worst ? '🔴' : '🟡'} federalgold.org: ${problems.length} sorun`, [
      'Site Durumu kontrolünde şu sorunlar art arda iki kez görüldü:', '',
      ...problems.map((r) => `${r.status === 'err' ? '✕' : '!'} ${r.title}: ${r.detail}`), '',
      'Ayrıntılar: https://federalgold.org/admin/#/pages/durum',
      'Sorun düzelince ayrıca haber verilir.',
    ].join('\n'));
  } else {
    await sendMail(env, '🟢 federalgold.org: her şey yolunda', 'Önceki mailde bildirilen sorunlar düzeldi; bütün kontroller şu an yeşil.\n\nhttps://federalgold.org/admin/#/pages/durum');
  }
  await env.DURUM.put('alerted', sig);
}

export async function readStatus(env) {
  if (!env.DURUM) return { latest: null, history: [] };
  const [latest, history] = await Promise.all([env.DURUM.get('latest'), env.DURUM.get('history')]);
  return { latest: latest ? JSON.parse(latest) : null, history: history ? JSON.parse(history) : [] };
}
