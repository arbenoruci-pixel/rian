
// /assets/healthcheck.js — shows a tiny badge if Supabase RPC next_code() works
(async () => {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/next_code_num`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const ok = res.ok;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;right:10px;bottom:10px;padding:6px 10px;border-radius:10px;font:12px/1.2 system-ui;background:#0a0;color:#fff;opacity:.9;z-index:9999';
    if (!ok) {
      const t = await res.text();
      el.style.background = '#c00';
      el.textContent = 'SUPABASE: ERR';
      el.title = t;
    } else {
      el.textContent = 'SUPABASE: OK';
    }
    document.documentElement.appendChild(el);
    setTimeout(()=>el.remove(), 5000);
  } catch (e) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;right:10px;bottom:10px;padding:6px 10px;border-radius:10px;font:12px/1.2 system-ui;background:#c00;color:#fff;opacity:.9;z-index:9999';
    el.textContent = 'SUPABASE: ERR';
    el.title = String(e && e.message || e);
    document.documentElement.appendChild(el);
    setTimeout(()=>el.remove(), 7000);
  }
})();
