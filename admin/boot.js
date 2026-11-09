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

  // Tab title: "Federal Gold Paneli" instead of the CMS name
  const fixTitle = () => {
    if (document.title.includes('Sveltia CMS')) document.title = document.title.replace('Sveltia CMS', 'Federal Gold Paneli');
  };
  new MutationObserver(fixTitle).observe(document.head, { subtree: true, childList: true, characterData: true });
})();
