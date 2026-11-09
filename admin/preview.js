// Live preview for the panel: shows the real home page with the unsaved changes.
// The site worker renders it at POST /admin/api/preview (same session cookie as the panel).
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
