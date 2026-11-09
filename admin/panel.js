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
