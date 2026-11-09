// Panel add-ons:
// 1. Live preview: the real home page with the unsaved changes (POST /admin/api/preview).
// 2. "Değişiklik Geçmişi" page: recent panel saves with a one-click undo (GitLab revert).
(() => {
  const CMS = window.CMS;
  if (!CMS || !CMS.React) return;
  const { React } = CMS;
  const h = React.createElement;

  // Turn Immutable data into plain JSON and swap unsaved uploads for their blob: URLs
  const resolveImages = (value, getAsset) => {
    if (Array.isArray(value)) return value.map((v) => resolveImages(v, getAsset));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolveImages(v, getAsset);
      return out;
    }
    if (typeof value === 'string' && /\.(webp|jpe?g|png|gif|avif|heic)$/i.test(value)) {
      try {
        const asset = getAsset(value);
        const url = asset && (asset.url || (asset.toString && asset.toString()));
        if (url && url.startsWith('blob:')) return url;
      } catch { /* keep the path */ }
    }
    return value;
  };

  const makePreview = (kind) => function SitePreview({ entry, getAsset }) {
    const [html, setHtml] = React.useState('');
    const [error, setError] = React.useState('');
    const raw = entry.getIn(['data']);
    const data = raw && raw.toJS ? raw.toJS() : {};
    const key = JSON.stringify(data);

    React.useEffect(() => {
      const timer = setTimeout(async () => {
        try {
          const resolved = resolveImages(data, getAsset);
          const body = kind === 'site' ? { site: resolved } : { products: Array.isArray(resolved) ? resolved : resolved.products || [] };
          const res = await fetch('/admin/api/preview', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(res.status === 401 ? 'Oturum süresi doldu, panele tekrar giriş yap.' : `Önizleme alınamadı (${res.status})`);
          setHtml(await res.text()); setError('');
        } catch (e) { setError(e.message); }
      }, 500);
      return () => clearTimeout(timer);
    }, [key]);

    const style = { width: '100%', height: '100vh', border: 0, display: 'block', background: '#0b0a09' };
    if (error) return h('p', { style: { padding: '16px', font: '14px sans-serif', color: '#b00' } }, error);
    if (!html) return h('p', { style: { padding: '16px', font: '14px sans-serif' } }, 'Önizleme hazırlanıyor…');
    return h('iframe', { srcDoc: html, style, title: 'Sitenin önizlemesi', sandbox: 'allow-scripts allow-same-origin allow-popups' });
  };

  CMS.registerPreviewStyle('html,body{margin:0;padding:0;background:#0b0a09}', { raw: true });
  const sitePreview = makePreview('site');
  const productsPreview = makePreview('products');
  for (const name of ['site']) CMS.registerPreviewTemplate(name, sitePreview);
  for (const name of ['products', 'vitrin']) CMS.registerPreviewTemplate(name, productsPreview);
})();

// ---- Change history with undo ----
(() => {
  const CMS = window.CMS;
  if (!CMS || !CMS.React || !CMS.registerCustomPage) return;
  const { React } = CMS;
  const h = React.createElement;
  const PROJECT = 'sozlu99-hue%2Ffederal-gold';
  const API = `/admin/api/gitlab/v4/projects/${PROJECT}`;
  // federalgold.org edits main; a preview "<branch>-federal-gold.…" edits that branch
  const m = location.hostname.match(/^([a-z0-9-]+?)-federal-gold\./);
  const BRANCH = m ? m[1] : 'main';
  const PANEL_PATH = /^(data\/|assets\/)/;

  const areaOf = (paths) => {
    const set = new Set();
    for (const p of paths) {
      if (p === 'data/products.json') set.add('Vitrin');
      else if (p === 'data/site.json') set.add('Site İçeriği');
      else if (p.startsWith('assets/')) set.add('Fotoğraf');
      else set.add('Diğer');
    }
    return [...set].join(' · ');
  };
  const when = (iso) => new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
  const getJSON = async (url, init) => {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || `Hata ${res.status}`), { status: res.status, body });
    return body;
  };

  const box = { maxWidth: '760px', margin: '0 auto', padding: '24px 16px', fontSize: '15px', lineHeight: 1.5 };
  const row = { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px', borderBottom: '1px solid rgba(128,128,128,.25)' };
  const btn = { padding: '8px 14px', borderRadius: '8px', border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', font: 'inherit' };

  function History() {
    const [items, setItems] = React.useState(null);
    const [msg, setMsg] = React.useState('');
    const [busy, setBusy] = React.useState('');

    const load = React.useCallback(async () => {
      try {
        const commits = await getJSON(`${API}/repository/commits?ref_name=${encodeURIComponent(BRANCH)}&per_page=30`);
        const withFiles = await Promise.all(commits.map(async (c) => {
          const diff = await getJSON(`${API}/repository/commits/${c.id}/diff?per_page=100`).catch(() => []);
          const paths = diff.map((d) => d.new_path || d.old_path);
          // only saves made in the panel itself (their message starts with "Panel:")
          return { ...c, paths, panel: /^Panel:/.test(c.title || '') && paths.length > 0 && paths.every((p) => PANEL_PATH.test(p)) };
        }));
        setItems(withFiles.filter((c) => c.panel).slice(0, 20));
      } catch (e) { setMsg(`Geçmiş yüklenemedi: ${e.message}`); setItems([]); }
    }, []);
    React.useEffect(() => { load(); }, [load]);

    const undo = async (c) => {
      if (!window.confirm(`Bu değişiklik geri alınsın mı?\n\n${when(c.created_at)} · ${areaOf(c.paths)}\n\nSite yaklaşık 1 dakika içinde eski haline döner.`)) return;
      setBusy(c.id); setMsg('');
      try {
        await getJSON(`${API}/repository/commits/${c.id}/revert`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: BRANCH }),
        });
        setMsg('Geri alındı. Site yaklaşık 1 dakika içinde güncellenecek. Panel yenileniyor…');
        setTimeout(() => location.reload(), 2500);
      } catch (e) {
        setBusy('');
        setMsg(e.status === 400
          ? 'Bu değişiklikten sonra aynı yerde başka değişiklik yapılmış. Önce daha yeni olanı geri al.'
          : `Geri alınamadı: ${e.message}`);
      }
    };

    return h('div', { style: box },
      h('h2', { style: { margin: '0 0 6px', fontSize: '22px' } }, 'Değişiklik Geçmişi'),
      h('p', { style: { margin: '0 0 18px', opacity: 0.75 } }, 'Panelden kaydedilen son değişiklikler. Yanlış bir şey kaydettiysen "Geri al" ile eski haline döndürebilirsin.'),
      msg && h('p', { style: { padding: '10px 14px', borderRadius: '8px', background: 'rgba(217,176,98,.18)', margin: '0 0 14px' } }, msg),
      items === null ? h('p', null, 'Yükleniyor…')
        : items.length === 0 ? h('p', { style: { opacity: 0.75 } }, 'Henüz panelden kaydedilmiş bir değişiklik yok.')
        : h('div', { style: { border: '1px solid rgba(128,128,128,.3)', borderRadius: '12px', overflow: 'hidden' } },
          items.map((c, i) => h('div', { key: c.id, style: row },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontWeight: 600 } }, areaOf(c.paths) + (i === 0 ? '  · en son' : '')),
              h('div', { style: { fontSize: '13px', opacity: 0.7 } }, `${when(c.created_at)} · ${String(c.title || '').replace(/^Panel:\s*/, '')}`)),
            h('button', { style: btn, disabled: Boolean(busy), onClick: () => undo(c) }, busy === c.id ? 'Geri alınıyor…' : 'Geri al'))))
    );
  }

  // owner-only page (hidden for the "abi" sign-in)
  if (window.__FG_ROLE__ !== 'abi') CMS.registerCustomPage({ id: 'gecmis', label: 'Değişiklik Geçmişi', icon: 'history', component: History });
})();

// ---- Product name from the photo ----
// When a Vitrin product is saved without a name, the photo is sent (resized) to the site worker,
// which asks an image model for a Turkish name, an English name and the category.
(() => {
  const CMS = window.CMS;
  if (!CMS || !CMS.registerEventListener) return;

  const toDataUrl = async (src) => {
    const blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 768 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  const describe = async (src) => {
    const res = await fetch('/admin/api/describe', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: await toDataUrl(src) }),
    });
    if (!res.ok) throw new Error(`describe ${res.status}`);
    return res.json();
  };

  CMS.registerEventListener({
    name: 'preSave',
    handler: async ({ entry }) => {
      let data = entry.get('data');
      if (!data || !data.get) return undefined;
      const key = data.get('products') ? ['products'] : [];
      const list = key.length ? data.get('products') : data;
      if (!list || typeof list.size !== 'number' || !list.get) return undefined;
      let changed = false;
      for (let i = 0; i < list.size; i++) {
        const item = list.get(i);
        if (!item || !item.get) continue;
        const name = String(item.get('name') || '').trim();
        const image = item.get('image');
        if (name || !image) continue;
        try {
          const d = await describe(image);
          const at = [...key, i];
          data = data.setIn([...at, 'name'], d.name);
          if (!String(item.get('nameEn') || '').trim() && d.nameEn) data = data.setIn([...at, 'nameEn'], d.nameEn);
          if (!item.get('category') && d.category) data = data.setIn([...at, 'category'], d.category);
          changed = true;
        } catch (e) {
          console.warn('Ürün adı fotoğraftan çıkarılamadı', e);
          if (!item.get('category')) { data = data.setIn([...key, i, 'category'], 'other'); changed = true; }
        }
      }
      const translated = await translateChanged(data, key).catch((e) => { console.warn('Otomatik çeviri yapılamadı', e); return null; });
      if (translated) { data = translated; changed = true; }
      return changed ? data : undefined;
    },
  });

  // ---- Turkish → English: whatever was changed in Turkish gets its English side translated on save ----
  // Compared with the published files; an English text the user edited by hand in the same save is left alone.
  const published = async (path) => {
    const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  };
  const translate = async (texts) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000);
    try {
      const res = await fetch('/admin/api/translate', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }), signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`translate ${res.status}`);
      return (await res.json()).translations || {};
    } finally { clearTimeout(timer); }
  };
  const at = (obj, path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  const leaves = (obj, path = [], out = []) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, [...path, k], out);
      else if (typeof v === 'string') out.push([...path, k]);
    }
    return out;
  };

  async function translateChanged(data, key) {
    const jobs = []; // [path to the English value, Turkish text]
    if (data.get('tr') && data.get('en')) {
      const now = data.toJS();
      const old = await published('/data/site.json');
      for (const path of leaves(now.tr)) {
        const tr = at(now.tr, path), en = at(now.en, path);
        const oldTr = at(old.tr, path), oldEn = at(old.en, path);
        const enUntouched = en === oldEn || en == null || en === '';
        if (tr !== oldTr && enUntouched) jobs.push([['en', ...path], tr]);
      }
    } else {
      const list = (key.length ? data.getIn(key) : data);
      const items = list && list.toJS ? list.toJS() : [];
      let old = [];
      try { old = await published('/data/products.json'); } catch { /* new items only */ }
      items.forEach((p, i) => {
        if (!p || !String(p.name || '').trim()) return;
        const before = Array.isArray(old) ? old.find((o) => o && o.image === p.image) : null;
        const enEmpty = !String(p.nameEn || '').trim();
        const renamed = before && before.name !== p.name && (p.nameEn || '') === (before.nameEn || '');
        if (enEmpty || renamed) jobs.push([[...key, i, 'nameEn'], p.name]);
      });
    }
    if (!jobs.length) return null;
    // an emptied Turkish text empties the English one too; the rest go to the translator
    let out = data, done = 0;
    const texts = {};
    jobs.forEach(([path, tr], n) => {
      if (String(tr || '').trim()) texts[`t${n}`] = tr;
      else { out = out.setIn(path, ''); done++; }
    });
    if (Object.keys(texts).length) {
      const result = await translate(texts);
      jobs.forEach(([path], n) => { if (result[`t${n}`]) { out = out.setIn(path, result[`t${n}`]); done++; } });
    }
    return done ? out : null;
  }
})();

// ---- "Site Durumu" page: results of the hourly checks run by the site worker ----
(() => {
  const CMS = window.CMS;
  if (!CMS || !CMS.React || !CMS.registerCustomPage) return;
  const { React } = CMS;
  const h = React.createElement;
  const ICON = { ok: '✓', warn: '!', err: '✕' };
  const COLOR = { ok: '#2e9e5b', warn: '#c98a06', err: '#d0442f' };
  const when = (iso) => new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });

  function Status() {
    const [data, setData] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [msg, setMsg] = React.useState('');
    const load = React.useCallback(async () => {
      try { setData(await (await fetch('/admin/api/status', { credentials: 'same-origin' })).json()); }
      catch (e) { setMsg(`Durum okunamadı: ${e.message}`); }
    }, []);
    React.useEffect(() => { load(); }, [load]);
    const runNow = async () => {
      setBusy(true); setMsg('');
      try {
        const res = await fetch('/admin/api/status/run', { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.status);
        await load();
      } catch (e) { setMsg(`Kontrol çalıştırılamadı (${e.message})`); }
      setBusy(false);
    };

    const latest = data && data.latest;
    const counts = latest ? latest.results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}) : {};
    // last 7 days: worst status per day
    const daysRow = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const runs = ((data && data.history) || []).filter((x) => { const t = new Date(x.time); return t >= d && t < new Date(d.getTime() + 864e5); });
      const worst = runs.some((x) => x.status === 'err') ? 'err' : runs.some((x) => x.status === 'warn') ? 'warn' : runs.length ? 'ok' : '';
      daysRow.push({ label: i === 0 ? 'Bugün' : d.toLocaleDateString('tr-TR', { weekday: 'short' }), worst });
    }

    const box = { maxWidth: '760px', margin: '0 auto', padding: '24px 16px', fontSize: '15px', lineHeight: 1.5 };
    const card = { border: '1px solid rgba(128,128,128,.3)', borderRadius: '12px', overflow: 'hidden', marginBottom: '18px' };
    const btn = { padding: '10px 16px', borderRadius: '8px', border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' };

    return h('div', { style: box },
      h('h2', { style: { margin: '0 0 6px', fontSize: '22px' } }, 'Site Durumu'),
      h('p', { style: { margin: '0 0 16px', opacity: 0.75 } }, 'Site her saat kendiliğinden kontrol edilir. Bir sorun olursa burada kırmızı ya da sarı görünür.'),
      msg && h('p', { style: { padding: '10px 14px', borderRadius: '8px', background: 'rgba(208,68,47,.12)' } }, msg),
      !data ? h('p', null, 'Yükleniyor…') : !latest ? h('p', null, 'Henüz kontrol yapılmadı. "Şimdi kontrol et"e bas.') : [
        h('div', { key: 'sum', style: { ...card, padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' } },
          h('span', { style: { width: '42px', height: '42px', borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '20px', color: '#fff', background: COLOR[latest.status] } }, ICON[latest.status]),
          h('div', null,
            h('div', { style: { fontWeight: 600, fontSize: '17px' } },
              latest.status === 'ok' ? 'Her şey yolunda' : latest.status === 'warn' ? `${counts.warn} konu dikkat istiyor` : `${counts.err} sorun var`),
            h('div', { style: { fontSize: '13px', opacity: 0.7 } }, `Son kontrol: ${when(latest.time)} · ${counts.ok || 0} kontrol sorunsuz`))),
        h('div', { key: 'list', style: card }, latest.results.map((r) =>
          h('div', { key: r.id, style: { display: 'flex', gap: '12px', padding: '12px 16px', borderTop: '1px solid rgba(128,128,128,.2)' } },
            h('span', { style: { flex: 'none', width: '24px', height: '24px', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: '13px', fontWeight: 700, color: '#fff', background: COLOR[r.status] } }, ICON[r.status]),
            h('div', null, h('div', { style: { fontWeight: 600 } }, r.title), h('div', { style: { fontSize: '13px', opacity: 0.75 } }, r.detail))))),
        h('div', { key: 'days', style: { ...card, padding: '14px 16px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '10px' } }, 'Son 7 gün'),
          h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, daysRow.map((d) =>
            h('div', { key: d.label, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.85 } },
              h('span', { style: { width: '24px', height: '34px', borderRadius: '6px', background: d.worst ? COLOR[d.worst] : 'rgba(128,128,128,.25)' } }), d.label)))),
      ],
      h('button', { style: btn, disabled: busy, onClick: runNow }, busy ? 'Kontrol ediliyor…' : 'Şimdi kontrol et'));
  }

  // owner-only page (hidden for the "abi" sign-in)
  if (window.__FG_ROLE__ !== 'abi') CMS.registerCustomPage({ id: 'durum', label: 'Site Durumu', icon: 'monitor_heart', component: Status });
})();

// ---- "Ziyaretçiler" page: Cloudflare Web Analytics numbers (real browsers; bots and panel pages left out) ----
(() => {
  const CMS = window.CMS;
  if (!CMS || !CMS.React || !CMS.registerCustomPage) return;
  const { React } = CMS;
  const h = React.createElement;
  const GOLD = '#d9b062';
  const fmt = (n) => new Intl.NumberFormat('tr-TR').format(n || 0);
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(['tr'], { type: 'region' }); } catch { /* old browser */ }
  const country = (code) => {
    const flag = /^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐';
    let name = code || 'Bilinmiyor';
    try { if (regionNames && code) name = regionNames.of(code) || code; } catch { /* keep the code */ }
    return `${flag} ${name}`;
  };
  const source = (host) => {
    const h0 = String(host || '').toLowerCase();
    if (!h0) return 'Doğrudan (link, WhatsApp, uygulama)';
    if (/(^|\.)google\./.test(h0)) return 'Google';
    if (/instagram/.test(h0)) return 'Instagram';
    if (/facebook|fb\.com/.test(h0)) return 'Facebook';
    if (/(^|\.)(t\.co|x\.com|twitter\.com)$/.test(h0)) return 'X (Twitter)';
    if (/bing\./.test(h0)) return 'Bing';
    if (/yandex\./.test(h0)) return 'Yandex';
    if (/whatsapp/.test(h0)) return 'WhatsApp';
    return h0.replace(/^www\./, '');
  };
  const DEVICE = { mobile: 'Telefon', desktop: 'Bilgisayar', tablet: 'Tablet' };

  function Visitors() {
    const [gun, setGun] = React.useState(0);
    const [data, setData] = React.useState(null);
    const [err, setErr] = React.useState('');
    React.useEffect(() => {
      let live = true;
      setData(null); setErr('');
      fetch(`/admin/api/visitors?gun=${gun}`, { credentials: 'same-origin' })
        .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || r.status), { code: j.error, detail: j.detail }); return j; })
        .then((j) => { if (live) setData(j); })
        .catch((e) => { if (live) setErr(e.code || e.message); });
      return () => { live = false; };
    }, [gun]);

    const box = { maxWidth: '760px', margin: '0 auto', padding: '24px 16px', fontSize: '15px', lineHeight: 1.5 };
    const card = { border: '1px solid rgba(217,176,98,.25)', borderRadius: '14px', padding: '16px', marginBottom: '16px', background: 'rgba(255,255,255,.02)' };
    const tab = (on) => ({ padding: '8px 14px', borderRadius: '999px', border: `1px solid ${on ? GOLD : 'rgba(128,128,128,.4)'}`, background: on ? GOLD : 'transparent', color: on ? '#14120f' : 'inherit', fontWeight: 600, cursor: 'pointer', font: 'inherit' });
    const title = (t) => h('div', { style: { fontWeight: 600, marginBottom: '10px' } }, t);
    const bars = (rows, label) => {
      const total = rows.reduce((a, r) => a + r.visits, 0) || 1;
      return rows.map((r) => h('div', { key: r.key, style: { margin: '8px 0' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '14px' } },
          h('span', null, label(r.key)), h('b', null, `${fmt(r.visits)} · %${Math.round(r.visits / total * 100)}`)),
        h('div', { style: { height: '6px', borderRadius: '3px', background: 'rgba(128,128,128,.2)', marginTop: '4px' } },
          h('div', { style: { width: `${Math.max(2, r.visits / total * 100)}%`, height: '100%', borderRadius: '3px', background: GOLD } }))));
    };

    let body;
    if (err === 'missing_token') {
      body = h('div', { style: card }, h('b', null, 'Ziyaretçi anahtarı henüz eklenmemiş.'),
        h('p', { style: { margin: '8px 0 0', opacity: 0.8 } }, 'Cloudflare → Workers & Pages → federal-gold → Settings → Variables and Secrets → Add: Type "Secret", isim CF_ANALYTICS_TOKEN, değer olarak "Account Analytics: Read" yetkili anahtarı yapıştırıp Deploy\'a bas.'));
    } else if (err) {
      body = h('div', { style: card }, h('b', null, err === 'bad_token' ? 'Ziyaretçi anahtarı çalışmıyor.' : 'Sayılar şu an alınamadı.'),
        h('p', { style: { margin: '8px 0 0', opacity: 0.8 } }, err === 'bad_token' ? 'Anahtarın "Account Analytics: Read" yetkisi olduğundan emin ol ya da yeni bir anahtar ekle.' : 'Biraz sonra tekrar dene.'));
    } else if (!data) {
      body = h('p', null, 'Yükleniyor…');
    } else if (gun === 0) {
      // today, hour by hour (Istanbul time)
      const hours = data.hours || [];
      const sum = hours.reduce((a, d) => ({ visits: a.visits + d.visits, views: a.views + d.views }), { visits: 0, views: 0 });
      const now = hours[hours.length - 1] || { key: '', visits: 0, views: 0 };
      const peak = hours.reduce((a, d) => (d.visits > a.visits ? d : a), { key: '', visits: 0 });
      const max = Math.max(1, ...hours.map((d) => d.visits));
      const stat = (label, big, small) => h('div', { style: { ...card, flex: '1 1 150px', marginBottom: 0 } },
        h('div', { style: { fontSize: '13px', opacity: 0.7 } }, label),
        h('div', { style: { fontSize: '30px', fontWeight: 700, color: GOLD, lineHeight: 1.2 } }, big),
        h('div', { style: { fontSize: '13px', opacity: 0.7 } }, small));
      const refs = (data.refs || []).filter((r) => r.visits > 0 && !/(^|\.)federalgold\.org$/.test(r.key));
      body = [
        h('div', { key: 'stats', style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
          stat('Bugün', fmt(sum.visits), `ziyaret · ${fmt(sum.views)} sayfa görüntüleme`),
          stat('Bu saat', fmt(now.visits), now.key ? `${now.key}:00'dan beri` : ''),
          stat('En yoğun saat', peak.visits ? `${peak.key}:00` : '—', peak.visits ? `${fmt(peak.visits)} ziyaret` : 'henüz ziyaret yok')),
        h('div', { key: 'chart', style: card }, title('Saat saat (Türkiye saati)'),
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '150px' } }, hours.map((d, i) =>
            h('div', { key: d.key, title: `${d.key}:00 — ${d.visits} ziyaret`, style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', gap: '4px', fontSize: '11px' } },
              d.visits > 0 && h('span', { style: { opacity: 0.85, fontSize: '10px' } }, d.visits),
              h('div', { style: { width: '100%', maxWidth: '26px', height: `${Math.max(2, d.visits / max * 105)}px`, borderRadius: '4px 4px 1px 1px', background: i === hours.length - 1 ? GOLD : 'rgba(217,176,98,.55)' } }),
              h('span', { style: { opacity: 0.7, visibility: i % 3 === 0 || i === hours.length - 1 ? 'visible' : 'hidden' } }, d.key))))),
        h('div', { key: 'countries', style: card }, title('Ülkeler'), (data.countries || []).length ? bars(data.countries, country) : h('p', { style: { margin: 0, opacity: 0.7 } }, 'Henüz veri yok.')),
        h('div', { key: 'refs', style: card }, title('Nereden geldiler'), refs.length ? bars(refs, source) : h('p', { style: { margin: 0, opacity: 0.7 } }, 'Henüz veri yok.')),
        h('div', { key: 'devices', style: card }, title('Cihaz'), (data.devices || []).length ? bars(data.devices, (k) => DEVICE[k] || k) : h('p', { style: { margin: 0, opacity: 0.7 } }, 'Henüz veri yok.')),
      ];
    } else {
      const days = data.days || [];
      const today = days[days.length - 1] || { visits: 0, views: 0 };
      const yesterday = days[days.length - 2] || { visits: 0, views: 0 };
      const sum = days.reduce((a, d) => ({ visits: a.visits + d.visits, views: a.views + d.views }), { visits: 0, views: 0 });
      const max = Math.max(1, ...days.map((d) => d.visits));
      const stat = (label, v) => h('div', { style: { ...card, flex: '1 1 150px', marginBottom: 0 } },
        h('div', { style: { fontSize: '13px', opacity: 0.7 } }, label),
        h('div', { style: { fontSize: '30px', fontWeight: 700, color: GOLD, lineHeight: 1.2 } }, fmt(v.visits)),
        h('div', { style: { fontSize: '13px', opacity: 0.7 } }, `ziyaret · ${fmt(v.views)} sayfa görüntüleme`));
      const refs = (data.refs || []).filter((r) => r.visits > 0 && !/(^|\.)federalgold\.org$/.test(r.key));
      body = [
        h('div', { key: 'stats', style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
          stat('Bugün', today), stat('Dün', yesterday), stat(`Son ${gun} gün`, sum)),
        h('div', { key: 'chart', style: card }, title('Günlük ziyaret'),
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: gun > 7 ? '3px' : '10px', height: '150px' } }, days.map((d, i) =>
            h('div', { key: d.key, title: `${d.key}: ${d.visits} ziyaret`, style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', gap: '4px', fontSize: '11px' } },
              gun <= 7 && h('span', { style: { opacity: 0.85 } }, fmt(d.visits)),
              h('div', { style: { width: '100%', maxWidth: '38px', height: `${Math.max(2, d.visits / max * 110)}px`, borderRadius: '6px 6px 2px 2px', background: i === days.length - 1 ? GOLD : 'rgba(217,176,98,.55)' } }),
              (gun <= 7 || i % 5 === 0 || i === days.length - 1) && h('span', { style: { opacity: 0.7, whiteSpace: 'nowrap' } },
                i === days.length - 1 ? 'Bugün' : new Date(`${d.key}T12:00:00Z`).toLocaleDateString('tr-TR', gun <= 7 ? { weekday: 'short' } : { day: 'numeric', month: 'numeric' })))))),
        h('div', { key: 'countries', style: card }, title('Ülkeler'), (data.countries || []).length ? bars(data.countries, country) : h('p', { style: { margin: 0, opacity: 0.7 } }, 'Henüz veri yok.')),
        h('div', { key: 'refs', style: card }, title('Nereden geldiler'), refs.length ? bars(refs, source) : h('p', { style: { margin: 0, opacity: 0.7 } }, 'Henüz veri yok.')),
        h('div', { key: 'devices', style: card }, title('Cihaz'), (data.devices || []).length ? bars(data.devices, (k) => DEVICE[k] || k) : h('p', { style: { margin: 0, opacity: 0.7 } }, 'Henüz veri yok.')),
      ];
    }

    return h('div', { style: box },
      h('h2', { style: { margin: '0 0 6px', fontSize: '22px' } }, 'Ziyaretçiler'),
      h('p', { style: { margin: '0 0 14px', opacity: 0.75 } }, 'Siteyi gerçekten açan kişiler. Botlar ve panel sayılmaz; sayılar birkaç dakika gecikmeli gelir.'),
      h('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px' } },
        h('button', { style: tab(gun === 0), onClick: () => setGun(0) }, 'Bugün'),
        h('button', { style: tab(gun === 7), onClick: () => setGun(7) }, '7 gün'),
        h('button', { style: tab(gun === 30), onClick: () => setGun(30) }, '30 gün')),
      body);
  }

  // owner-only page (hidden for the "abi" sign-in)
  if (window.__FG_ROLE__ !== 'abi') CMS.registerCustomPage({ id: 'ziyaretciler', label: 'Ziyaretçiler', icon: 'group', component: Visitors });
})();

// ---- Click in the preview → open that field in the editor ----
(() => {
  const ENTRY = { site: '#/collections/site/entries/site', vitrin: '#/collections/vitrin/entries/products' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = (kp) => document.querySelector(`section.field[data-key-path="${CSS.escape(kp)}"]`);
  const waitFor = async (fn, ms = 6000) => {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v || Date.now() > end) return v; await sleep(80); }
  };
  const expand = async (btn) => { if (btn && btn.getAttribute('aria-expanded') === 'false') { btn.click(); await sleep(120); } };

  const reveal = async (path) => {
    const parts = path.split('.');
    for (let i = 1; i <= parts.length; i++) {
      const kp = parts.slice(0, i).join('.');
      if (/^\d+$/.test(parts[i - 1])) {
        // list item: open it in its parent list
        const list = find(parts.slice(0, i - 1).join('.'));
        await expand(list && list.querySelector(`button[aria-controls$="-item-${parts[i - 1]}-body"]`));
        continue;
      }
      const sec = await waitFor(() => find(kp), 3000);
      if (!sec) return;
      if (i < parts.length && sec.dataset.fieldType === 'object') await expand(sec.querySelector('button[aria-controls^="object-"]'));
    }
    const field = await waitFor(() => find(path), 3000);
    if (!field) return;
    field.scrollIntoView({ behavior: 'smooth', block: 'center' });
    field.classList.remove('fg-flash'); void field.offsetWidth; field.classList.add('fg-flash');
    const input = field.querySelector('input:not([type=hidden]), textarea, [contenteditable=true]');
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 350);
  };

  window.addEventListener('message', async (e) => {
    // from the preview (same origin, or the opaque origin of its nested frames); it can only move the editor's focus
    if ((e.origin !== location.origin && e.origin !== 'null') || !e.data || typeof e.data.fgEdit !== 'string' || !/^[\w.]+$/.test(e.data.fgEdit)) return;
    const hash = ENTRY[e.data.collection];
    if (!hash) return;
    if (!location.hash.startsWith(hash)) {
      location.hash = hash;
      await waitFor(() => find(e.data.collection === 'site' ? 'iletisim' : 'products'), 8000);
    }
    reveal(e.data.fgEdit);
  });
})();

// ---- "Ana Sayfa": the panel opens on a welcome dashboard (live rates, today at a glance, quick actions) ----
(() => {
  const CMS = window.CMS;
  if (!CMS || !CMS.React || !CMS.registerCustomPage) return;
  const { React } = CMS;
  const h = React.createElement;
  const OWNER = window.__FG_ROLE__ !== 'abi';
  const GOLD = '#d9b062';
  const money = (n) => (n ? new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₺' : '—');
  const RATES = [['Gram Altın', 'KULCEALTIN', 'GRA'], ['Çeyrek', 'CEYREK_YENI', 'CEYREKALTIN'], ['22 Ayar', 'AYAR22', 'YIA'], ['Dolar', 'USDTRY', 'USD'], ['Euro', 'EURTRY', 'EUR']];
  const hello = () => {
    const hr = Number(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul', hour: 'numeric', hour12: false })) % 24;
    return hr < 5 ? 'İyi geceler' : hr < 11 ? 'Günaydın' : hr < 17 ? 'İyi günler' : hr < 22 ? 'İyi akşamlar' : 'İyi geceler';
  };
  const css = `
  .fgd{max-width:980px;margin:0 auto;padding:28px 18px 60px;font-family:Manrope,system-ui,sans-serif;color:#f5f0e6}
  .fgd *{box-sizing:border-box}
  .fgd-hero{position:relative;overflow:hidden;border-radius:22px;padding:30px 26px;margin-bottom:18px;border:1px solid rgba(217,176,98,.3);
    background:linear-gradient(120deg,rgba(11,10,9,.92),rgba(11,10,9,.55)),url(/assets/magaza-1.webp) center 35%/cover;animation:fgUp .7s cubic-bezier(.2,.8,.2,1) both}
  .fgd-hero::after{content:"";position:absolute;inset:-50%;background:linear-gradient(115deg,transparent 45%,rgba(255,236,190,.12) 50%,transparent 55%);animation:fgShine 5s ease-in-out 1s infinite}
  .fgd-hi{margin:0;color:#b9b0a2;font-size:14px}
  .fgd-title{margin:4px 0 6px;font:600 clamp(32px,6vw,46px)/1.05 'Cormorant Garamond',Georgia,serif;background:linear-gradient(90deg,#c9963f,#f6e2a8 40%,#d9b062 60%,#b8862f);
    -webkit-background-clip:text;background-clip:text;color:transparent;background-size:200% auto;animation:fgGold 6s linear infinite}
  .fgd-date{margin:0;color:#b9b0a2;font-size:14px}
  .fgd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
  .fgd-card{position:relative;padding:16px;border-radius:16px;background:#14120f;border:1px solid rgba(217,176,98,.22);animation:fgUp .6s cubic-bezier(.2,.8,.2,1) both}
  .fgd-card small{display:block;color:#b9b0a2;font-size:12px;margin-bottom:4px}
  .fgd-card b{display:block;font-size:22px;color:#f0d59a;font-variant-numeric:tabular-nums;transition:color .4s}
  .fgd-card b.up{color:#7fd39b}.fgd-card b.down{color:#f08a7a}
  .fgd-card i{font-style:normal;font-size:12px;color:#8f877b}
  .fgd-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:18px}
  .fgd-big{padding:18px;border-radius:18px;background:#14120f;border:1px solid rgba(217,176,98,.22);animation:fgUp .6s cubic-bezier(.2,.8,.2,1) both}
  .fgd-big h3{margin:0 0 10px;font:600 20px/1.2 'Cormorant Garamond',Georgia,serif;color:#f0d59a}
  .fgd-num{font-size:40px;font-weight:700;color:#f0d59a;line-height:1}
  .fgd-muted{color:#b9b0a2;font-size:13px}
  .fgd-thumbs{display:flex;gap:8px;margin-top:12px;overflow:hidden}
  .fgd-thumbs img{flex:none}
  @media (max-width:600px){.fgd-grid .fgd-card:nth-child(5){display:none}}
  .fgd-thumbs img{width:56px;height:56px;border-radius:10px;object-fit:cover;border:1px solid rgba(217,176,98,.3)}
  .fgd-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
  .fgd-btn{display:flex;align-items:center;gap:10px;padding:14px 16px;border-radius:14px;border:1px solid rgba(217,176,98,.35);background:rgba(217,176,98,.07);
    color:#f5f0e6;font:600 15px Manrope,sans-serif;cursor:pointer;text-align:left;transition:background .2s,transform .15s}
  .fgd-btn:hover{background:rgba(217,176,98,.16)}.fgd-btn:active{transform:scale(.98)}
  .fgd-btn.main{background:linear-gradient(135deg,#e7c47c,#c99a45);color:#1a1307;border-color:transparent}
  .fgd-btn span{font-size:20px}
  .fgd-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#7fd39b;box-shadow:0 0 0 0 rgba(127,211,155,.6);animation:fgPulse 2s infinite}
  @keyframes fgUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  @keyframes fgShine{0%{transform:translateX(-60%)}60%,100%{transform:translateX(60%)}}
  @keyframes fgGold{to{background-position:200% center}}
  @keyframes fgPulse{70%{box-shadow:0 0 0 8px rgba(127,211,155,0)}100%{box-shadow:0 0 0 0 rgba(127,211,155,0)}}
  @media (prefers-reduced-motion:reduce){.fgd *,.fgd-hero::after{animation:none!important}}`;

  function useRates() {
    const [rates, setRates] = React.useState({});
    const [live, setLive] = React.useState(false);
    React.useEffect(() => {
      let ws, alive = true, data = {}, timer;
      const backup = () => fetch('https://finans.truncgil.com/v4/today.json', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
        if (!alive || live) return;
        const out = {};
        RATES.forEach(([, , b]) => { if (d[b]) out[b] = { sell: Number(d[b].Selling) }; });
        setRates((old) => (Object.keys(old).length ? old : Object.fromEntries(RATES.map(([, h0, b]) => [h0, out[b]]))));
      }).catch(() => {});
      try {
        ws = new WebSocket('wss://hrmsocketonly.haremaltin.com/socket.io/?EIO=4&transport=websocket');
        ws.onmessage = (e) => {
          const m = String(e.data);
          if (m === '2') return ws.send('3');
          if (m[0] === '0') return ws.send('40');
          if (!m.startsWith('42')) return;
          try {
            const [name, payload] = JSON.parse(m.slice(2));
            if (name !== 'price_changed' || !payload || !payload.data) return;
            Object.assign(data, payload.data);
            setLive(true);
            setRates((old) => {
              const out = { ...old };
              RATES.forEach(([, k]) => { const r = data[k]; if (r && Number(r.satis)) out[k] = { sell: Number(r.satis), prev: old[k] && old[k].sell }; });
              return out;
            });
          } catch { /* ignore */ }
        };
      } catch { /* no websocket */ }
      timer = setTimeout(backup, 5000);
      return () => { alive = false; clearTimeout(timer); try { ws && ws.close(); } catch { /* closed */ } };
    }, []);
    return [rates, live];
  }

  function Home() {
    const [rates, live] = useRates();
    const [products, setProducts] = React.useState(null);
    const [visits, setVisits] = React.useState(null);
    const [status, setStatus] = React.useState(null);
    const [last, setLast] = React.useState(null);
    React.useEffect(() => {
      fetch('/data/products.json', { cache: 'no-store' }).then((r) => r.json()).then(setProducts).catch(() => setProducts([]));
      if (!OWNER) return;
      fetch('/admin/api/visitors?gun=0', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then(setVisits).catch(() => {});
      fetch('/admin/api/status', { credentials: 'same-origin' }).then((r) => r.json()).then((d) => setStatus(d.latest)).catch(() => {});
      fetch('/admin/api/gitlab/v4/projects/sozlu99-hue%2Ffederal-gold/repository/commits?ref_name=main&per_page=20', { credentials: 'same-origin' })
        .then((r) => r.json()).then((list) => setLast((Array.isArray(list) ? list : []).find((c) => /^Panel:/.test(c.title || '')) || false)).catch(() => {});
    }, []);

    const go = (hash) => { location.hash = hash; };
    const now = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', weekday: 'long', day: 'numeric', month: 'long' });
    const list = Array.isArray(products) ? products : [];
    const shown = list.filter((p) => p && p.visible !== false);
    const thumbs = shown.filter((p) => p.image).slice(0, 5);
    const today = visits && visits.hours ? visits.hours.reduce((a, x) => a + x.visits, 0) : null;
    const ago = (iso) => {
      const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
      return m < 60 ? `${Math.max(1, m)} dk önce` : m < 1440 ? `${Math.round(m / 60)} saat önce` : `${Math.round(m / 1440)} gün önce`;
    };

    return h('div', { className: 'fgd' },
      h('style', null, css),
      h('div', { className: 'fgd-hero' },
        h('p', { className: 'fgd-hi' }, `${hello()} 👋`),
        h('div', { className: 'fgd-title' }, 'Federal Gold'),
        h('p', { className: 'fgd-date' }, now.charAt(0).toUpperCase() + now.slice(1))),
      h('div', { className: 'fgd-grid' }, RATES.map(([label, k], i) => {
        const r = rates[k];
        const dir = r && r.prev ? (r.sell > r.prev ? 'up' : r.sell < r.prev ? 'down' : '') : '';
        return h('div', { key: k, className: 'fgd-card', style: { animationDelay: `${0.08 * i + 0.1}s` } },
          h('small', null, i === 0 ? h('span', null, live && h('span', { className: 'fgd-dot' }), label) : label),
          h('b', { className: dir }, r ? money(r.sell) : '…'),
          h('i', null, 'satış'));
      })),
      h('div', { className: 'fgd-row' },
        OWNER && h('div', { className: 'fgd-big', style: { animationDelay: '.45s' } },
          h('h3', null, 'Bugün siteye gelen'),
          h('div', { className: 'fgd-num' }, today == null ? '…' : today),
          h('div', { className: 'fgd-muted' }, 'ziyaretçi · ', h('a', { href: '#/pages/ziyaretciler', style: { color: GOLD } }, 'ayrıntılar →'))),
        h('div', { className: 'fgd-big', style: { animationDelay: '.55s' } },
          h('h3', null, 'Vitrin'),
          h('div', { className: 'fgd-num' }, products ? shown.length : '…'),
          h('div', { className: 'fgd-muted' }, products ? `ürün sitede görünüyor${list.length > shown.length ? ` · ${list.length - shown.length} gizli` : ''}` : ''),
          h('div', { className: 'fgd-thumbs' }, thumbs.map((p, i) => h('img', { key: i, src: p.image, alt: p.name || '' })))),
        OWNER && h('div', { className: 'fgd-big', style: { animationDelay: '.65s' } },
          h('h3', null, 'Site'),
          status
            ? h('div', null,
              h('div', { style: { fontSize: '18px', fontWeight: 700, color: status.status === 'ok' ? '#7fd39b' : status.status === 'warn' ? '#e8b64a' : '#f08a7a' } },
                status.status === 'ok' ? '● Her şey yolunda' : status.status === 'warn' ? '● Dikkat isteyen konu var' : '● Sorun var'),
              h('div', { className: 'fgd-muted', style: { marginTop: '6px' } }, 'Son değişiklik: ', last ? `${String(last.title).replace(/^Panel:\s*/, '')} · ${ago(last.created_at)}` : last === false ? '—' : '…'),
              h('a', { href: '#/pages/durum', style: { color: GOLD, fontSize: '13px' } }, 'Site Durumu →'))
            : h('div', { className: 'fgd-muted' }, '…'))),
      h('div', { className: 'fgd-actions' },
        h('button', { className: 'fgd-btn main', onClick: () => go('#/collections/vitrin/entries/products') }, h('span', null, '💎'), 'Vitrine ürün ekle'),
        h('button', { className: 'fgd-btn', onClick: () => go('#/collections/site/entries/site') }, h('span', null, '✍️'), 'Site yazıları'),
        h('button', { className: 'fgd-btn', onClick: () => go('#/assets') }, h('span', null, '🖼️'), 'Fotoğraflar'),
        h('button', { className: 'fgd-btn', onClick: () => window.open('/', '_blank') }, h('span', null, '🌐'), 'Siteyi aç')));
  }

  CMS.registerCustomPage({ id: 'anasayfa', label: 'Ana Sayfa', icon: 'home', component: Home });
})();
