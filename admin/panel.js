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

  CMS.registerPreviewStyle('html,body{margin:0;padding:0;background:#0b0a09}');
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
          return { ...c, paths, panel: paths.length > 0 && paths.every((p) => PANEL_PATH.test(p)) };
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

  CMS.registerCustomPage({ id: 'gecmis', label: 'Değişiklik Geçmişi', icon: 'history', component: History });
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
      return changed ? data : undefined;
    },
  });
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

  CMS.registerCustomPage({ id: 'durum', label: 'Site Durumu', icon: 'monitor_heart', component: Status });
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
