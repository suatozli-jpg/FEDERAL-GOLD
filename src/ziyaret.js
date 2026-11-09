// Visitor numbers for the panel's "Ziyaretçiler" page (GET /admin/api/visitors, signed-in only).
// Read from Cloudflare Web Analytics with a read-only token (secret CF_ANALYTICS_TOKEN); panel pages are left out.

const ACCOUNT = '7d3fec0301abe106ffb37056874b1183';
const SITE_TAG = '2a213e0b7c9042689075277e985ede46';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

const groups = (name, limit, dims, order) =>
  `${name}: rumPageloadEventsAdaptiveGroups(limit: ${limit}, filter: $f, orderBy: [${order}]) { count sum { visits } dimensions { ${dims} } }`;

const QUERY = `query ($a: String!, $f: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject) {
  viewer { accounts(filter: { accountTag: $a }) {
    ${groups('days', 100, 'date', 'date_ASC')}
    ${groups('countries', 10, 'countryName', 'sum_visits_DESC')}
    ${groups('refs', 10, 'refererHost', 'sum_visits_DESC')}
    ${groups('devices', 5, 'deviceType', 'sum_visits_DESC')}
    ${groups('pages', 6, 'requestPath', 'count_DESC')}
  } }
}`;

const day = (d) => d.toISOString().slice(0, 10);
const row = (g, key) => ({ key: key(g.dimensions || {}), visits: (g.sum && g.sum.visits) || 0, views: g.count || 0 });

export async function visitors(request, env) {
  if (!env.CF_ANALYTICS_TOKEN) return Response.json({ error: 'missing_token' }, { status: 503, headers });
  const url = new URL(request.url);
  const n = Math.min(30, Math.max(1, parseInt(url.searchParams.get('gun') || '7', 10) || 7));
  const to = new Date();
  const from = new Date(to.getTime() - (n - 1) * 864e5);
  const filter = { siteTag: SITE_TAG, date_geq: day(from), date_leq: day(to), requestPath_notlike: '/admin%' };
  let res;
  try {
    res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
      body: JSON.stringify({ query: QUERY, variables: { a: ACCOUNT, f: filter } }),
    });
  } catch (e) {
    return Response.json({ error: 'unreachable', detail: String(e && e.message || e) }, { status: 502, headers });
  }
  const body = await res.json().catch(() => null);
  const acc = body && body.data && body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0];
  if (!res.ok || !acc) {
    const msg = (body && body.errors && body.errors[0] && body.errors[0].message) || `HTTP ${res.status}`;
    return Response.json({ error: /auth|permission|not authorized/i.test(msg) ? 'bad_token' : 'query_failed', detail: msg.slice(0, 200) }, { status: 502, headers });
  }
  // every day of the period, also the ones without visitors
  const byDay = new Map((acc.days || []).map((g) => [g.dimensions.date, row(g, (d) => d.date)]));
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = day(new Date(to.getTime() - i * 864e5));
    days.push(byDay.get(d) || { key: d, visits: 0, views: 0 });
  }
  return Response.json({
    from: day(from), to: day(to), days,
    countries: (acc.countries || []).map((g) => row(g, (d) => d.countryName)),
    refs: (acc.refs || []).map((g) => row(g, (d) => d.refererHost || '')),
    devices: (acc.devices || []).map((g) => row(g, (d) => d.deviceType)),
    pages: (acc.pages || []).map((g) => row(g, (d) => d.requestPath)),
  }, { headers });
}
