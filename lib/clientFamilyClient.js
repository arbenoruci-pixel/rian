import { normalizeClientProfilePhone } from './clientProfileIdentity.js';
export const FAMILY_INVITATION = 'Statusi dhe familjarët:';
export async function familyRequest(body, { signal, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch('/api/client-family', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw Object.assign(new Error(result.error || 'FAMILY_REQUEST_FAILED'), { code: result.error, status: response.status });
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export function newFamilyRequestId() { return crypto.randomUUID(); }
export function familyErrorText(error) {
  const code = error?.code || error?.message || '';
  if (/STALE/.test(code)) return 'Kartela ndryshoi ndërkohë. Rifreskoje dhe kontrolloje përsëri.';
  if (/PHONE_ALREADY_LINKED/.test(code)) return 'Telefoni tashmë ka kartelë familjare. Rifresko dhe zgjidhe atë kartelë.';
  if (/PHONE_CONFLICT/.test(code)) return 'Ky telefon është i lidhur me një kartelë tjetër. Kërko kontroll nga stafi para bashkimit.';
  if (/LINK_EXPIRED|LINK_INVALID/.test(code)) return 'Ky link nuk vlen më për shtimin e familjarëve. Kërko një Smart Mesazh të ri.';
  if (/INVALID/.test(code)) return 'Kontrollo emrin dhe numrin e telefonit.';
  if (/ALREADY_LINKED/.test(code)) return 'Këto kode janë tashmë në të njëjtën kartelë.';
  if (/FORBIDDEN|AUTH|DEVICE/.test(code)) return 'Hyr me një pajisje të aprovuar për këtë veprim.';
  return 'Ruajtja nuk u konfirmua. Të dhënat mbetën këtu; provo përsëri.';
}
export async function lookupFamilyPhone(source, phone, options = {}) {
  if (!normalizeClientProfilePhone(phone)) return null;
  return (await familyRequest({ action: 'RESOLVE_PHONE', source, phone }, options)).client || null;
}
export async function prepareFamilySmartMessage(text, options = {}) {
  const original = String(text || '');
  const matches = [...new Set(original.match(/https:\/\/tepiha\.vercel\.app\/k\/[^\s]+/g) || [])];
  // A multi-client bulk message cannot grant one recipient access to other families.
  if (matches.length !== 1) return original;
  let url; try { url = new URL(matches[0]); } catch { return original; }
  if (url.searchParams.has('family')) return original;
  const source = url.searchParams.get('src') === 'base' ? 'BASE' : url.searchParams.get('src') === 'transport' ? 'TRANSPORT' : '';
  const orderId = decodeURIComponent(url.pathname.slice(3));
  if (!source || !orderId) return original;
  const { token, shortUrl } = await familyRequest({ action: 'SIGN_LINK', source, orderId }, options);
  if (!token) return original;
  if (shortUrl && /^https:\/\/tepiha\.vercel\.app\/k\/s_[A-Za-z0-9_-]{22}$/.test(shortUrl)) url = new URL(shortUrl);
  else url.searchParams.set('family', token);
  // Replace an existing tracking label instead of adding a second paragraph.
  const withoutLabel = original.replace(/(?:📍\s*)?(?:Statusi:|Ndiqni statusin e tepihave tuaj live:|Ndiqni statusin e tepihave live:|Ndiqni statusin LIVE:|Për të ndjekur statusin live, preke këtë link:)\s*/g, '');
  return withoutLabel.replace(matches[0], `${FAMILY_INVITATION}\n${url.toString()}`);
}
