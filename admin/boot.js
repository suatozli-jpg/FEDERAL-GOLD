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
