export default async function handler(req, res) {
  // Accept GET with ?q=... OR POST with { q: "..." }
  const method = req.method || 'GET';
  let { q, start = 0, num = 10 } = req.query;

  if (method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      q = body?.q ?? q;
      start = body?.start ?? start;
      num = body?.num ?? num;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }

  if (!q || String(q).trim() === '') {
    return res.status(400).json({ error: 'Missing q', hint: 'Call /api/leads?q=your+google+query' });
  }

  const key = process.env.SERPAPI_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'Missing SERPAPI_KEY on server',
      fix: 'Add SERPAPI_KEY in Vercel → Project → Settings → Environment Variables and redeploy.',
    });
  }

  const params = new URLSearchParams({
    engine: 'google',
    q: String(q),
    google_domain: 'google.com',
    gl: 'us',
    hl: 'en',
    start: String(start),
    num: String(num),        // how many results (max 100, but SerpAPI plan-dependent)
    safe: 'active',          // avoid NSFW
    api_key: key,
  });

  const url = `https://serpapi.com/search.json?${params.toString()}`;

  try {
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Upstream error from SerpAPI', status: r.status, body: text.slice(0, 500) });
    }
    const j = await r.json();
    return res.status(200).json(j);
  } catch (e) {
    return res.status(500).json({ error: 'Fetch failed', detail: String(e) });
  }
}