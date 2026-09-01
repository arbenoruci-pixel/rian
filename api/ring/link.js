import { authenticateRingManager, safeRingError } from './_common.js';
import { completeOneWayLink } from '../../lib/ringOneWayServer.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function page({ nonce, time, error = '' }) {
  const n = esc(nonce);
  const t = esc(time);
  const e = esc(error);
  return `<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#05070d"><title>Lidh Ring • TEPIHA</title><style>body{margin:0;background:#05070d;color:#fff;font-family:system-ui,-apple-system,sans-serif}.w{max-width:560px;margin:auto;padding:40px 18px}.c{background:#0b1220;border:1px solid #25334a;border-radius:22px;padding:22px}h1{margin:0 0 8px;font-size:28px}p{color:#cbd5e1;line-height:1.5}.b{width:100%;border:0;border-radius:16px;padding:16px;font-weight:900;font-size:17px;background:#2563eb;color:#fff}.e{color:#fca5a5;font-weight:800;margin:12px 0}.ok{color:#86efac}</style></head><body><main class="w"><section class="c"><h1>Lidh Ring me TEPIHA</h1><p>Ky hap e lidh Ring account-in e autorizuar me llogarinë OWNER/ADMIN të TEPIHA-s. Duhet me qenë i kyçur në TEPIHA në këtë browser.</p>${e ? `<div class="e">${e}</div>` : ''}<form method="post" action="/api/ring/link"><input type="hidden" name="nonce" value="${n}"><input type="hidden" name="time" value="${t}"><button class="b" type="submit">KONFIRMO LIDHJEN</button></form></section></main></body></html>`;
}

function successPage() {
  return `<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#05070d"><title>Ring u lidh</title><style>body{margin:0;background:#05070d;color:#fff;font-family:system-ui,-apple-system,sans-serif}.w{max-width:560px;margin:auto;padding:50px 18px}.c{background:#0b1220;border:1px solid #25334a;border-radius:22px;padding:24px}.ok{color:#86efac;font-weight:900;font-size:24px}a{display:block;text-align:center;margin-top:18px;background:#2563eb;color:#fff;text-decoration:none;padding:15px;border-radius:15px;font-weight:900}</style></head><body><main class="w"><section class="c"><div class="ok">Ring u lidh me sukses.</div><p>Mundesh me u kthy në TEPIHA dhe me i rifresku kamerat.</p><a href="/ring.html">HAPE RING CAMERAS</a></section></main></body></html>`;
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
    try {
      await authenticateRingManager(req);
      if (!nonce || !time) return res.status(400).send(page({ nonce, time, error: 'Mungon nonce ose time nga Ring.' }));
      return res.status(200).send(page({ nonce, time }));
    } catch {
      return res.status(401).send(page({ nonce, time, error: 'Kyçu fillimisht në TEPIHA në këtë browser si OWNER/ADMIN, pastaj hape lidhjen prapë nga Ring.' }));
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
    return res.status(safe.httpStatus).send(page({ nonce: postNonce, time: postTime, error: safe.code }));
  }
}
