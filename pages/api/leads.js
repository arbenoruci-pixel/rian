export default async function handler(req, res){
  const { q, start = 0 } = req.query;
  if(!q){ return res.status(400).json({ error: 'Missing q' }); }
  const key = process.env.SERPAPI_KEY;
  if(!key){ return res.status(500).json({ error: 'Missing SERPAPI_KEY on server' }); }
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&google_domain=google.com&gl=us&hl=en&start=${start}&api_key=${key}`;
  try{
    const r = await fetch(url);
    if(!r.ok){ return res.status(502).json({ error: 'Upstream error', status: r.status }); }
    const j = await r.json();
    return res.status(200).json(j);
  }catch(e){
    return res.status(500).json({ error: 'Fetch failed', detail: String(e) });
  }
}
