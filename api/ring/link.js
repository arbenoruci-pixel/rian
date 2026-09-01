import { authenticateRingManager, safeRingError } from './_common.js';
import { completeOneWayLink } from '../../lib/ringOneWayServer.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function rawLinkPath(nonce, time) {
  const params = new URLSearchParams();
  if (nonce) params.set('nonce', String(nonce));
  if (time) params.set('time', String(time));
  return `/api/ring/link?${params.toString()}`;
}

function page({ nonce, time, error = '', authRequired = false }) {
  const n = esc(nonce);
  const t = esc(time);
  const e = esc(error);
  const returnTo = rawLinkPath(nonce, time);
  const loginHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;
  return `<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#05070d"><title>Lidh Ring • TEPIHA</title><style>body{margin:0;background:#05070d;color:#fff;font-family:system-ui,-apple-system,sans-serif}.w{max-width:560px;margin:auto;padding:40px 18px}.c{background:#0b1220;border:1px solid #25334a;border-radius:22px;padding:22px}h1{margin:0 0 8px;font-size:28px}p{color:#cbd5e1;line-height:1.5}.b{display:block;width:100%;box-sizing:border-box;border:0;border-radius:16px;padding:16px;font-weight:900;font-size:17px;background:#2563eb;color:#fff;text-align:center;text-decoration:none}.b2{margin-top:12px;background:#172033;border:1px solid #2a3850}.e{color:#fca5a5;font-weight:800;margin:12px 0}.hint{margin:12px 0;color:#bfdbfe;font-size:13px;line-height:1.45}</style></head><body><main class="w"><section class="c"><h1>Lidh Ring me TEPIHA</h1><p>Ky hap e lidh Ring account-in e autorizuar me llogarinë OWNER/ADMIN të TEPIHA-s.</p>${e ? `<div class="e">${e}</div>` : ''}${authRequired ? `<div class="hint">Kyçu në TEPIHA në këtë browser. Pas hyrjes kthehesh automatikisht te kjo lidhje pa e humbur nonce-in e Ring.</div><a class="b" href="${esc(loginHref)}">KYÇU NË TEPIHA</a>` : `<form method="post" action="/api/ring/link"><input type="hidden" name="nonce" value="${n}"><input type="hidden" name="time" value="${t}"><button class="b" type="submit">KONFIRMO LIDHJEN</button></form>`}<a class="b b2" href="/ring.html?v=one-way-v1">RING CAMERAS</a></section></main></body></html>`;
}

function successPage() {
  return `<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#05070d"><title>Ring u lidh</title><style>body{margin:0;background:#05070d;color:#fff;font-family:system-ui,-apple-system,sans-serif}.w{max-width:560px;margin:auto;padding:50px 18px}.c{background:#0b1220;border:1px solid #25334a;border-radius:22px;padding:24px}.ok{color:#86efac;font-weight:900;font-size:24px}a{display:block;text-align:center;margin-top:18px;background:#2563eb;color:#fff;text-decoration:none;padding:15px;border-radius:15px;font-weight:900}</style></head><body><main class="w"><section class="c"><div class="ok">Ring u lidh me sukses.</div><p>Mundesh me i hap kamerat e autorizuara në TEPIHA.</p><a href="/ring.html?v=one-way-v1">HAPE RING CAMERAS</a></section></main></body></html>`;
}

async function parsePost(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = String(req.body || '');
  const p = new URLSearchParams(raw);
  return { nonce: p.get('nonce') || '', time: p.get('time') || '' };
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  const method = String(req.method || '').toUpperCase();
  const nonce = String(req.query?.nonce || '').trim();
  const time = String(req.query?.time || '').trim();

  if (method === 'GET') {
    if (!nonce || !time) return res.status(400).send(page({ nonce, time, error: 'Mungon nonce ose time nga Ring.' }));
    try {
      await authenticateRingManager(req);
      return res.status(200).send(page({ nonce, time }));
    } catch {
      return res.status(401).send(page({
        nonce,
        time,
        error: 'Duhet me u kyç si OWNER ose ADMIN.',
        authRequired: true,
      }));
    }
  }

  if (method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  let payload = {};
  try { payload = await parsePost(req); } catch {}
  const postNonce = String(payload?.nonce || '').trim();
  const postTime = String(payload?.time || '').trim();
  try {
    const { supabase } = await authenticateRingManager(req);
    await completeOneWayLink({ supabase, nonce: postNonce, timeParam: postTime, accountIdentifier: 'a***i@yahoo.com' });
    return res.status(200).send(successPage());
  } catch (error) {
    const safe = safeRingError(error);
    console.error('[ring-link]', { code: safe.code, status: safe.httpStatus, extra: safe.extra || null });
    const authRequired = safe.code === 'AUTH_REQUIRED' || safe.httpStatus === 401;
    return res.status(safe.httpStatus).send(page({ nonce: postNonce, time: postTime, error: safe.code, authRequired }));
  }
}
