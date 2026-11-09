// Site health checks ("Site Durumu"). Run every hour by the cron trigger and on demand from the
// panel. Results are kept in KV (binding DURUM): "latest" and a rolling 7-day "history".

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
  const paths = new Set(products.map((p) => p && p.image).filter(Boolean));
  for (const v of Object.values((site && site.fotograflar) || {})) if (v) paths.add(v);
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
  const t0 = Date.now();
  try {
    const res = await timed(() => fetch(BACKUP_URL, { headers: { Accept: 'application/json' } }));
    const d = await res.json();
    if (!res.ok || !d || !d.GRA) throw new Error(`yanıt ${res.status}`);
    return ok('yedek', 'Yedek kur kaynağı', `Çalışıyor · ${Date.now() - t0} ms`);
  } catch (e) {
    return warn('yedek', 'Yedek kur kaynağı', `Yanıt vermiyor (${e.message})`);
  }
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
  ]);
  const results = parts.flat();
  const worst = results.some((r) => r.status === 'err') ? 'err' : results.some((r) => r.status === 'warn') ? 'warn' : 'ok';
  const run = { time: new Date().toISOString(), status: worst, results };
  if (env.DURUM) {
    await env.DURUM.put('latest', JSON.stringify(run));
    let history = [];
    try { history = JSON.parse((await env.DURUM.get('history')) || '[]'); } catch { history = []; }
    history.push({ time: run.time, status: worst });
    await env.DURUM.put('history', JSON.stringify(history.slice(-24 * 8)));
  }
  return run;
}

export async function readStatus(env) {
  if (!env.DURUM) return { latest: null, history: [] };
  const [latest, history] = await Promise.all([env.DURUM.get('latest'), env.DURUM.get('history')]);
  return { latest: latest ? JSON.parse(latest) : null, history: history ? JSON.parse(history) : [] };
}
