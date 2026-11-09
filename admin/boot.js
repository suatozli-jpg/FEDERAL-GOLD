// Runs before the panel loads. The password page has already set the session cookie, and the
// site worker adds the real GitLab token to every request, so the panel only needs a placeholder.
(() => {
  try {
    const key = 'sveltia-cms.user';
    const user = JSON.parse(localStorage.getItem(key) || 'null');
    if (!user || user.backendName !== 'gitlab' || !user.token) {
      localStorage.setItem(key, JSON.stringify({ backendName: 'gitlab', token: 'panel-session' }));
    }
  } catch { /* storage blocked: the token sign-in button still works */ }

  // Dark theme like the site, unless the user picked a theme in the panel settings
  try {
    const prefs = JSON.parse(localStorage.getItem('sveltia-cms.prefs') || '{}') || {};
    if (!prefs.theme || prefs.theme === 'auto') { prefs.theme = 'dark'; localStorage.setItem('sveltia-cms.prefs', JSON.stringify(prefs)); }
  } catch { /* ignore */ }

  // Session expired: go back to the password page instead of showing a GitLab error
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    try {
      const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
      if (res.status === 401 && res.headers.get('X-Panel-Session') === 'expired' && url.origin === location.origin) {
        location.href = '/admin/login';
      }
    } catch { /* ignore */ }
    return res;
  };

  // "Federal Gold Paneli" instead of the CMS name, in the tab title and on screen
  const NAME = 'Federal Gold Paneli';
  const swap = (node) => {
    if (node.nodeType === 3) { if (node.nodeValue.includes('Sveltia CMS')) node.nodeValue = node.nodeValue.replace(/Sveltia CMS/g, NAME); return; }
    if (node.nodeType !== 1 || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes('Sveltia CMS')) n.nodeValue = n.nodeValue.replace(/Sveltia CMS/g, NAME);
  };
  new MutationObserver((list) => {
    if (document.title.includes('Sveltia CMS')) document.title = document.title.replace('Sveltia CMS', NAME);
    for (const m of list) {
      if (m.type === 'characterData') swap(m.target);
      else m.addedNodes.forEach(swap);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  // ---- Photos: shrink big ones (max 1600 px, WebP or JPEG) and give them a plain file name before the panel sees them ----
  // (phones send 3–5 MB photos and names like "IMG_2911" that some steps turn into "ımg_2911")
  const MAX_SIDE = 1600, MAX_BYTES = 600 * 1024;
  const TR = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', I: 'i', Ö: 'o', Ş: 's', Ü: 'u' };
  const cleanName = (name, ext) => {
    const base = String(name || 'foto').replace(/\.[^.]+$/, '').replace(/[çğıöşüÇĞİIÖŞÜ]/g, (c) => TR[c] || c).toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'foto';
    return `${base}.${ext}`;
  };
  const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || '') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return file;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { return file; }
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const plainName = /^[a-z0-9-]+\.(webp|jpe?g|png)$/.test(file.name);
    if (scale === 1 && file.size <= MAX_BYTES && plainName && /webp|jpeg/.test(file.type)) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    let blob = await toBlob(canvas, 'image/webp', 0.82);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.85); // Safari cannot write WebP
    if (!blob) return file;
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], cleanName(file.name, ext), { type: blob.type, lastModified: Date.now() });
  }
  const shrinkAll = async (files) => Promise.all([...files].map((f) => shrink(f).catch(() => f)));
  const asFileList = (files) => { const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); return dt.files; };
  // file picker
  document.addEventListener('change', async (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || input.__fgDone || !input.files || !input.files.length) return;
    e.stopImmediatePropagation();
    const files = await shrinkAll(input.files);
    try { input.files = asFileList(files); } catch { /* keep the originals */ }
    input.__fgDone = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.__fgDone = false;
  }, true);
  // drag and drop
  document.addEventListener('drop', async (e) => {
    if (e.__fgDone || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    const target = e.target;
    e.preventDefault(); e.stopImmediatePropagation();
    const files = await shrinkAll(e.dataTransfer.files);
    const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f));
    const again = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    again.__fgDone = true;
    target.dispatchEvent(again);
  }, true);

  // A preview copy of the panel (any address other than federalgold.org) saves to its preview only: say so, always on screen
  if (!/(^|\.)federalgold\.org$/.test(location.hostname)) {
    const show = () => {
      if (document.getElementById('fg-preview-bar')) return;
      const bar = document.createElement('a');
      bar.id = 'fg-preview-bar';
      bar.href = 'https://federalgold.org/admin/';
      bar.textContent = '⚠ ÖNİZLEME PANELİ — burada kaydettiklerin canlı siteye geçmez. Gerçek panel: federalgold.org/admin (dokun)';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:block;padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:#b3261e;color:#fff;font:600 14px/1.35 Manrope,system-ui,sans-serif;text-align:center;text-decoration:none';
      document.body.append(bar);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
})();
