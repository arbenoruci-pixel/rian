import {
  apiFail,
  apiOk,
  createAdminClientOrThrow,
  pickEnv,
  asObject,
  readUsers,
  normPhone,
  normalizeName,
  orderData,
  extractClientKeys,
  pickClientCode,
  pickClientName,
  pickClientPhone,
} from '../_helpers.js';

const BASE_DONE = new Set(['dorezuar', 'dorëzuar', 'dorzim', 'dorezim', 'paguar', 'anuluar', 'arkiv', 'arkivuar', 'done', 'completed']);
const TRANSPORT_DONE = new Set(['dorezuar', 'dorëzuar', 'dorzim', 'dorezim', 'paguar', 'anuluar', 'arkiv', 'arkivuar', 'done', 'completed']);

function fmtDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('sq-AL', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Belgrade' });
  } catch {
    return String(value);
  }
}

function fmtDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('sq-AL', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Belgrade',
    });
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function normCode(value) {
  return String(value ?? '').trim().replace(/\D+/g, '').replace(/^0+/, '');
}

function cleanText(value, fallback = '-') {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s || fallback;
}

function nameOfClient(c) {
  const full = cleanText(c?.full_name || c?.name || c?.client_name || '', '');
  if (full) return full;
  const fn = cleanText(c?.first_name || '', '');
  const ln = cleanText(c?.last_name || '', '');
  return cleanText(`${fn} ${ln}`, '-');
}

function phoneOfClient(c) {
  return cleanText(c?.phone || c?.client_phone || c?.tel || c?.mobile || '', '-');
}

function payOfOrder(o) {
  const d = orderData(o);
  return d?.pay && typeof d.pay === 'object' ? d.pay : {};
}

function totalEurFromOrder(o) {
  const data = orderData(o);
  const pay = payOfOrder(o);
  const direct = Number(pay?.euro ?? pay?.total ?? data?.total ?? o?.total ?? 0);
  if (Number.isFinite(direct) && direct > 0) return Number(direct.toFixed(2));
  const rate = Number(pay?.price ?? pay?.rate ?? data?.price ?? 0) || 0;
  const m2 = Number(pay?.m2 ?? data?.total_m2 ?? data?.m2 ?? 0) || 0;
  return Number((rate * m2).toFixed(2));
}

function rowArray(...values) {
  for (const value of values) if (Array.isArray(value)) return value;
  return [];
}

function piecesSummaryFromOrder(o) {
  const d = orderData(o);
  const direct = Number(d?.pieces ?? d?.copa ?? d?.qty_total ?? o?.pieces ?? 0) || 0;
  if (direct > 0) return `${direct} COPË`;
  const tepiha = rowArray(d?.tepihaRows, d?.tepiha, d?.carpets, d?.items);
  const staza = rowArray(d?.stazaRows, d?.staza);
  const sumQty = (arr) => (arr || []).reduce((acc, r) => acc + (Number(r?.qty ?? r?.pieces ?? r?.count ?? 0) || 0), 0);
  const stairsQty = Number(d?.shkallore?.qty ?? d?.stairsQty ?? 0) || 0;
  const total = sumQty(tepiha) + sumQty(staza) + (stairsQty > 0 ? stairsQty : 0);
  return total > 0 ? `${total} COPË` : '';
}

function totalM2FromOrder(o) {
  const d = orderData(o);
  const pay = payOfOrder(o);
  const direct = Number(pay?.m2 ?? d?.total_m2 ?? d?.m2 ?? 0);
  if (Number.isFinite(direct) && direct > 0) return Number(direct.toFixed(2));
  const tepiha = rowArray(d?.tepihaRows, d?.tepiha, d?.carpets, d?.items);
  const staza = rowArray(d?.stazaRows, d?.staza);
  const sum = (arr) => (arr || []).reduce((acc, r) => acc + ((Number(r?.m2 ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? r?.count ?? 0) || 0)), 0);
  const stairsQty = Number(d?.shkallore?.qty ?? d?.stairsQty ?? 0) || 0;
  const stairsPer = Number(d?.shkallore?.per ?? d?.stairsPer ?? 0.3) || 0.3;
  const total = sum(tepiha) + sum(staza) + (stairsQty > 0 ? stairsQty * stairsPer : 0);
  return total > 0 ? Number(total.toFixed(2)) : 0;
}

function orderHandLinesBase(o) {
  const d = orderData(o);
  const tepiha = rowArray(d?.tepihaRows, d?.tepiha, d?.carpets, d?.items);
  const staza = rowArray(d?.stazaRows, d?.staza);
  const stairsQty = Number(d?.shkallore?.qty ?? d?.stairsQty ?? 0) || 0;
  const stairsPer = Number(d?.shkallore?.per ?? d?.stairsPer ?? 0.3) || 0.3;
  const lines = [];
  for (const r of tepiha) {
    const qty = Number(r?.qty ?? r?.pieces ?? r?.count ?? 0) || 0;
    const m2 = Number(r?.m2 ?? r?.area ?? 0) || 0;
    if (qty > 0 && m2 > 0) lines.push(`TEPIHA: ${qty} copë ${m2.toFixed(2)}m²`);
  }
  for (const r of staza) {
    const qty = Number(r?.qty ?? r?.pieces ?? r?.count ?? 0) || 0;
    const m2 = Number(r?.m2 ?? r?.area ?? 0) || 0;
    if (qty > 0 && m2 > 0) lines.push(`STAZA: ${qty} copë ${m2.toFixed(2)}m²`);
  }
  if (stairsQty > 0) lines.push(`SHKALLË: ${stairsQty} copë ${stairsPer}m²`);
  return lines;
}

function expandM2Lines(rows, maxLines = 12) {
  const out = [];
  for (const r of rows || []) {
    const m2 = Number(r?.m2 ?? r?.area ?? 0) || 0;
    const qty = Number(r?.qty ?? r?.pieces ?? r?.count ?? 0) || 0;
    if (m2 <= 0 || qty <= 0) continue;
    for (let i = 0; i < qty; i += 1) {
      out.push(m2);
      if (out.length >= maxLines) break;
    }
    if (out.length >= maxLines) break;
  }
  return out;
}

function orderHandLinesTransport(o) {
  const d = orderData(o);
  const tepiha = rowArray(d?.tepihaRows, d?.tepiha, d?.carpets, d?.items);
  const staza = rowArray(d?.stazaRows, d?.staza);
  const stairsQty = Number(d?.shkallore?.qty ?? d?.stairsQty ?? 0) || 0;
  const stairsPer = Number(d?.shkallore?.per ?? d?.stairsPer ?? 0.3) || 0.3;
  const lines = [];
  for (const v of expandM2Lines(tepiha, 12)) lines.push(String(v.toFixed(1)));
  for (const v of expandM2Lines(staza, 12 - lines.length)) lines.push(String(v.toFixed(1)));
  const extra = [];
  if (stairsQty > 0) extra.push(`SHKALLË: ${stairsQty} x ${stairsPer} = ${Number((stairsQty * stairsPer).toFixed(2))}m²`);
  return { lines, extra };
}

function orderNote(o) {
  const d = orderData(o);
  return cleanText(d?.note || d?.notes || d?.shenim || d?.comment || o?.note || '', '');
}

function orderAddress(o) {
  const d = orderData(o);
  return cleanText(d?.address || d?.adresa || d?.client_address || d?.pickup_address || d?.delivery_address || d?.location || o?.address || '', '');
}

function orderLocation(o) {
  const d = orderData(o);
  const slots = Array.isArray(d?.ready_slots) ? d.ready_slots.join(', ') : '';
  return cleanText(d?.ready_location || d?.location || d?.rack || slots || '', '');
}

function statusCounts(rows) {
  const counts = {};
  for (const row of rows || []) {
    const key = String(row?.status || 'PA STATUS').trim().toUpperCase() || 'PA STATUS';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function statusPills(counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { sensitivity: 'base' }));
  if (!entries.length) return '<span style="color:#666;font-size:12px;">Pa statuse.</span>';
  return entries.map(([name, count]) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:4px 8px;border:1px solid #111;border-radius:999px;background:#f8fafc;font-size:11px;font-weight:800;">${escapeHtml(name)}: ${escapeHtml(count)}</span>`).join('');
}

function cardShell({ code, name, phone, status, pieces, linesHtml, total, m2, updatedAt, note, address, location }) {
  const meta = [status, pieces].filter(Boolean).join(' • ') || '-';
  const extraRows = [
    address ? `<div style="font-size:11px;margin-top:4px;"><b>ADRESA:</b> ${escapeHtml(address)}</div>` : '',
    location ? `<div style="font-size:11px;margin-top:4px;"><b>LOKACIONI:</b> ${escapeHtml(location)}</div>` : '',
    note ? `<div style="font-size:11px;margin-top:4px;"><b>SHËNIM:</b> ${escapeHtml(note)}</div>` : '',
    updatedAt ? `<div style="font-size:10px;color:#666;margin-top:6px;">Përditësuar: ${escapeHtml(fmtDateTime(updatedAt))}</div>` : '',
  ].filter(Boolean).join('');
  return `<td style="width:50%;vertical-align:top;padding:0;"><div style="min-height:180px;border-right:2px solid #000;border-bottom:2px solid #000;padding:12px;position:relative;box-sizing:border-box;"><div style="position:absolute;right:8px;top:4px;font-size:24px;font-weight:900;color:#333;">${escapeHtml(code)}</div><div style="padding-right:88px;margin-bottom:8px;"><div style="font-size:18px;font-weight:900;text-transform:uppercase;line-height:1.1;">${escapeHtml(name)}</div></div><div style="font-size:16px;font-family:monospace;font-weight:600;margin-bottom:12px;">${escapeHtml(phone)}</div><div style="border-top:1px dashed #999;padding-top:5px;min-height:70px;"><div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;"><span style="font-size:10px;color:#666;text-transform:uppercase;">POROSIA AKTIVE:</span><span style="font-size:11px;font-weight:800;text-transform:uppercase;">${escapeHtml(meta)}</span></div><div style="font-family:monospace;font-size:13px;line-height:1.35;margin-top:6px;white-space:pre-wrap;font-weight:600;color:#333;">${linesHtml || '<span style="color:#999;">(PA MATJE AKOMA)</span>'}</div></div><div style="margin-top:8px;text-align:right;font-size:17px;font-weight:900;">Total: ${total ? escapeHtml(money(total)) : '____'} €${m2 ? `<div style="font-size:12px;color:#555;font-weight:800;">M²: ${escapeHtml(Number(m2).toFixed(2))}</div>` : ''}</div>${extraRows}</div></td>`;
}

function cardsGrid(cards) {
  if (!cards.length) return '<div style="border:2px dashed #999;padding:18px;text-align:center;font-weight:800;">NUK KA KLIENTA NË PROCES.</div>';
  let html = '<table role="presentation" style="width:100%;border-collapse:collapse;border-top:2px solid #000;border-left:2px solid #000;"><tbody>';
  for (let i = 0; i < cards.length; i += 2) {
    html += '<tr>';
    html += cards[i];
    html += cards[i + 1] || '<td style="width:50%;border-bottom:2px solid #000;border-right:2px solid #000;">&nbsp;</td>';
    html += '</tr>';
  }
  return `${html}</tbody></table>`;
}

function buildBaseClientBuckets(clients, orders) {
  const ordersByClient = new Map();
  for (const o of orders || []) {
    const d = orderData(o);
    const client = asObject(d?.client);
    const code = normCode(o?.code ?? o?.client_code ?? client?.code ?? d?.code);
    if (!code) continue;
    if (!ordersByClient.has(code)) ordersByClient.set(code, []);
    ordersByClient.get(code).push(o);
  }
  for (const [k, arr] of ordersByClient.entries()) {
    arr.sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
    ordersByClient.set(k, arr);
  }
  const activeOrderByCode = new Map();
  const activeOrderIds = new Set();
  for (const [code, arr] of ordersByClient.entries()) {
    const active = arr.find((o) => !BASE_DONE.has(String(o?.status || '').toLowerCase()));
    if (active) {
      activeOrderByCode.set(code, active);
      activeOrderIds.add(String(active?.id || ''));
    }
  }
  const activeClients = [];
  for (const rawClient of clients || []) {
    const codeRaw = rawClient?.code ?? rawClient?.nr_rendor ?? rawClient?.client_code ?? '';
    const code = normCode(codeRaw);
    if (!code || !activeOrderByCode.has(code)) continue;
    activeClients.push({ ...rawClient, code: codeRaw, full_name: nameOfClient(rawClient), phone: phoneOfClient(rawClient), _activeOrder: activeOrderByCode.get(code) });
  }
  const orphanActiveOrders = (orders || [])
    .filter((o) => !BASE_DONE.has(String(o?.status || '').toLowerCase()))
    .filter((o) => !activeOrderIds.has(String(o?.id || '')))
    .map((o) => {
      const d = orderData(o);
      const client = asObject(d?.client);
      return { code: o?.code || client?.code || d?.code || '', full_name: cleanText(o?.client_name || client?.name || d?.client_name || '', 'PA KLIENT'), phone: cleanText(o?.client_phone || client?.phone || d?.client_phone || '', '-'), _activeOrder: o, _orphan: true };
    });
  activeClients.sort((a, b) => String(a?.code || '').localeCompare(String(b?.code || ''), undefined, { numeric: true, sensitivity: 'base' }));
  orphanActiveOrders.sort((a, b) => new Date(b?._activeOrder?.created_at || 0).getTime() - new Date(a?._activeOrder?.created_at || 0).getTime());
  return { activeClients, orphanActiveOrders };
}

function baseClientCard(c) {
  const o = c?._activeOrder || {};
  const lines = orderHandLinesBase(o).map((line) => escapeHtml(line)).join('<br>');
  return cardShell({ code: `#${cleanText(c?.code, '-')}`, name: nameOfClient(c), phone: phoneOfClient(c), status: String(o?.status || '').toUpperCase() || '-', pieces: piecesSummaryFromOrder(o), linesHtml: lines, total: totalEurFromOrder(o), m2: totalM2FromOrder(o), updatedAt: o?.updated_at || o?.created_at, note: orderNote(o), location: orderLocation(o) });
}

function transportClientCard(c) {
  const o = c?._activeOrder || {};
  const lines = orderHandLinesTransport(o);
  const linesHtml = [...(lines.lines || []).map((line) => escapeHtml(line)), ...(lines.extra || []).map((line) => `<span style="font-size:11px;">${escapeHtml(line)}</span>`)].join('<br>');
  return cardShell({ code: cleanText(c?.code || o?.code || o?.code_str, '-'), name: nameOfClient(c), phone: phoneOfClient(c), status: String(o?.status || '').toUpperCase() || '-', pieces: piecesSummaryFromOrder(o), linesHtml, total: totalEurFromOrder(o), m2: totalM2FromOrder(o), updatedAt: o?.updated_at || o?.created_at, note: orderNote(o), address: orderAddress(o), location: orderLocation(o) });
}

function buildFletoreSection({ title, subtitle, count, statusSummaryHtml, cardsHtml }) {
  return `<section style="margin:0 0 36px 0;"><div style="border-bottom:2px solid #000;margin-bottom:14px;padding-bottom:8px;"><h2 style="margin:0;font-size:22px;font-weight:900;text-transform:uppercase;">${escapeHtml(title)} (${escapeHtml(count)})</h2>${subtitle ? `<div style="margin-top:4px;font-size:13px;color:#444;">${escapeHtml(subtitle)}</div>` : ''}<div style="margin-top:8px;">${statusSummaryHtml || ''}</div></div>${cardsHtml}</section>`;
}

function buildTransportGroups({ transportOrders, transportClients, users }) {
  const usersById = new Map((users || []).map((u) => [String(u?.id || '').trim(), u]));
  const clientLookup = new Map();
  for (const row of transportClients || []) {
    const keys = new Set();
    const tcode = String(row?.tcode || row?.code || '').trim();
    const id = String(row?.id || '').trim();
    const phone = normPhone(row?.phone);
    if (tcode) keys.add(`tcode:${tcode.toUpperCase()}`);
    if (id) keys.add(`id:${id}`);
    if (phone) keys.add(`phone:${phone}`);
    for (const key of keys) clientLookup.set(key, row);
  }
  const normalizedOrders = (transportOrders || []).map((row) => {
    const data = orderData(row);
    const keys = extractClientKeys(row, data);
    const clientRow = keys.map((key) => clientLookup.get(key)).find(Boolean) || null;
    const transportKey = String(row?.transport_id || '').trim();
    const transportUser = usersById.get(transportKey) || null;
    return { ...row, code: pickClientCode(row, data), client_name: pickClientName(row, data, clientRow), client_phone: pickClientPhone(row, data, clientRow), transport_name: normalizeName(transportUser?.name || data?.transport_name || row?.transport_name || transportKey || 'PA CAKTUAR'), data };
  });
  const transportMap = new Map();
  for (const order of normalizedOrders) {
    const tid = String(order?.transport_id || '').trim() || 'unassigned';
    const current = transportMap.get(tid) || { id: tid, name: normalizeName(order?.transport_name || usersById.get(tid)?.name || (tid === 'unassigned' ? 'PA CAKTUAR' : tid)), orders: [] };
    current.orders.push(order);
    transportMap.set(tid, current);
  }
  return Array.from(transportMap.values()).map((group) => {
    group.orders.sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
    const activeOrders = group.orders.filter((o) => !TRANSPORT_DONE.has(String(o?.status || '').toLowerCase()));
    const seen = new Set();
    const activeClients = [];
    for (const order of activeOrders) {
      const key = `${String(order?.code || '').trim().toUpperCase()}|${normPhone(order?.client_phone) || String(order?.id || '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      activeClients.push({ code: String(order?.code || '').trim(), full_name: normalizeName(order?.client_name || '-'), phone: String(order?.client_phone || '-').trim() || '-', _activeOrder: order });
    }
    activeClients.sort((a, b) => String(a?.code || '').localeCompare(String(b?.code || ''), undefined, { numeric: true, sensitivity: 'base' }));
    return { ...group, activeOrders, activeClients };
  }).sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }));
}

async function sendViaResend({ to, subject, html, attachments = [] }) {
  const apiKey = pickEnv('RESEND_API_KEY');
  const from = pickEnv('RESEND_FROM', 'EMAIL_NGA') || 'onboarding@resend.dev';
  if (!apiKey) throw new Error('MUNGON_KODI_I_RESEND_API');
  const body = { from, to: Array.isArray(to) ? to : String(to).split(',').map((x) => x.trim()).filter(Boolean), subject, html };
  if (attachments.length) body.attachments = attachments;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.message || json?.error || `RESEND_${response.status}`);
  return json;
}

function buildBackupAttachment(payload) {
  const json = JSON.stringify(payload, null, 2);
  if (json.length > 4_500_000) return [];
  return [{ filename: `tepiha-fletore-backup-${new Date().toISOString().slice(0, 10)}.json`, content: Buffer.from(json, 'utf8').toString('base64') }];
}

function summaryBox({ baseActiveCount, transportActiveCount, baseOrphanCount, generatedAt, transportGroups }) {
  const driverLines = transportGroups.map((g) => `${g.name}: ${g.activeClients.length}`).join(' • ') || 'Pa transport aktiv';
  return `<div style="border:2px solid #000;background:#f8fafc;padding:12px;margin:14px 0 22px 0;"><div style="font-size:13px;font-weight:900;text-transform:uppercase;margin-bottom:6px;">PËRMBLEDHJE PËR BACKUP</div><div style="font-size:13px;line-height:1.55;">Gjeneruar: <b>${escapeHtml(fmtDateTime(generatedAt))}</b><br>BAZË në proces: <b>${escapeHtml(baseActiveCount)}</b><br>BAZË pa klient/link të qartë: <b>${escapeHtml(baseOrphanCount)}</b><br>TRANSPORT në proces: <b>${escapeHtml(transportActiveCount)}</b><br>Shoferët: <b>${escapeHtml(driverLines)}</b></div><div style="font-size:12px;color:#444;margin-top:8px;">Ky email është fletore backup live. Mund të forward-ohet te bazistët ose shoferët nëse app-i nuk hapet.</div></div>`;
}

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const sb = createAdminClientOrThrow();
    const to = pickEnv('BACKUP_EMAIL_TO', 'EMAIL_KU_TE_VIJE');
    if (!to) throw new Error('BACKUP_EMAIL_TO_NOT_SET');

    const [baseRes, clientsRes, transportRes, transportClientsRes, users] = await Promise.all([
      sb.from('orders').select('id,code,client_name,client_phone,status,created_at,updated_at,data,total').order('created_at', { ascending: false }).limit(5000),
      sb.from('clients').select('*').order('code', { ascending: true }).limit(5000),
      sb.from('transport_orders').select('id,created_at,updated_at,code_str,client_id,client_tcode,client_name,client_phone,status,data,transport_id,visit_nr,ready_at,total').order('created_at', { ascending: false }).limit(5000),
      sb.from('transport_clients').select('*').order('created_at', { ascending: true }).limit(5000),
      readUsers(sb),
    ]);
    if (baseRes?.error) throw baseRes.error;
    if (transportRes?.error) throw transportRes.error;

    const generatedAt = new Date().toISOString();
    const baseOrders = Array.isArray(baseRes?.data) ? baseRes.data : [];
    const baseClients = clientsRes?.error ? [] : (Array.isArray(clientsRes?.data) ? clientsRes.data : []);
    const transportOrders = Array.isArray(transportRes?.data) ? transportRes.data : [];
    const transportClients = transportClientsRes?.error ? [] : (Array.isArray(transportClientsRes?.data) ? transportClientsRes.data : []);

    const { activeClients: baseActiveClients, orphanActiveOrders } = buildBaseClientBuckets(baseClients, baseOrders);
    const activeBaseOrders = [...baseActiveClients.map((c) => c?._activeOrder).filter(Boolean), ...orphanActiveOrders.map((c) => c?._activeOrder).filter(Boolean)];
    const transportGroups = buildTransportGroups({ transportOrders, transportClients, users });
    const activeTransportOrders = transportGroups.flatMap((group) => group.activeOrders || []);

    const baseSection = buildFletoreSection({ title: '📋 FLETORE BAZË — KLIENTAT NË PROCES', subtitle: 'Pamje e ngjashme me /fletore. Kjo pjesë mund të forward-ohet te bazistët.', count: baseActiveClients.length, statusSummaryHtml: statusPills(statusCounts(activeBaseOrders)), cardsHtml: cardsGrid(baseActiveClients.map(baseClientCard)) });
    const orphanSection = orphanActiveOrders.length ? buildFletoreSection({ title: '⚠️ BAZË — POROSI PA KLIENT TË LIDHUR', subtitle: 'Këto janë aktive, por nuk u lidhën me client master në fletore. Mos i humb në rast backup-i.', count: orphanActiveOrders.length, statusSummaryHtml: '', cardsHtml: cardsGrid(orphanActiveOrders.map(baseClientCard)) }) : '';
    const transportSections = transportGroups.map((group) => buildFletoreSection({ title: `🚚 FLETORE TRANSPORT — ${String(group?.name || 'PA CAKTUAR').toUpperCase()}`, subtitle: `ID: ${group?.id || '-'} • Pamje si /transport/fletore. Kjo pjesë mund të forward-ohet te ky shofer.`, count: group?.activeClients?.length || 0, statusSummaryHtml: statusPills(statusCounts(group?.activeOrders || [])), cardsHtml: cardsGrid((group?.activeClients || []).map(transportClientCard)) })).join('') || buildFletoreSection({ title: '🚚 FLETORE TRANSPORT', subtitle: 'Nuk ka transport aktiv.', count: 0, statusSummaryHtml: '', cardsHtml: cardsGrid([]) });

    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;max-width:1200px;margin:0 auto;padding:18px;"><div style="border-bottom:3px solid #000;margin-bottom:14px;padding-bottom:10px;"><h1 style="margin:0;font-size:25px;font-weight:900;text-transform:uppercase;">SISTEMI BACKUP — FLETORE DITORE</h1><p style="margin:5px 0 0 0;font-size:14px;color:#555;">Live nga databaza • Data: <b>${escapeHtml(fmtDate(generatedAt))}</b></p></div>${summaryBox({ baseActiveCount: baseActiveClients.length, baseOrphanCount: orphanActiveOrders.length, transportActiveCount: activeTransportOrders.length, generatedAt, transportGroups })}${baseSection}${orphanSection}${transportSections}</div>`;

    const backupPayload = {
      generated_at: generatedAt,
      base: {
        active_count: baseActiveClients.length,
        orphan_active_count: orphanActiveOrders.length,
        status_counts: statusCounts(activeBaseOrders),
        active_clients: baseActiveClients.map((c) => ({ code: c?.code || '', name: nameOfClient(c), phone: phoneOfClient(c), order_id: c?._activeOrder?.id || '', status: c?._activeOrder?.status || '', total_eur: totalEurFromOrder(c?._activeOrder || {}), total_m2: totalM2FromOrder(c?._activeOrder || {}), pieces: piecesSummaryFromOrder(c?._activeOrder || {}), updated_at: c?._activeOrder?.updated_at || c?._activeOrder?.created_at || '' })),
        orphan_active_orders: orphanActiveOrders.map((c) => ({ code: c?.code || '', name: nameOfClient(c), phone: phoneOfClient(c), order_id: c?._activeOrder?.id || '', status: c?._activeOrder?.status || '', total_eur: totalEurFromOrder(c?._activeOrder || {}), total_m2: totalM2FromOrder(c?._activeOrder || {}), pieces: piecesSummaryFromOrder(c?._activeOrder || {}), updated_at: c?._activeOrder?.updated_at || c?._activeOrder?.created_at || '' })),
      },
      transport: transportGroups.map((group) => ({ id: group?.id || '', name: group?.name || '', active_count: group?.activeClients?.length || 0, status_counts: statusCounts(group?.activeOrders || []), active_clients: (group?.activeClients || []).map((c) => ({ code: c?.code || '', name: nameOfClient(c), phone: phoneOfClient(c), order_id: c?._activeOrder?.id || '', status: c?._activeOrder?.status || '', total_eur: totalEurFromOrder(c?._activeOrder || {}), total_m2: totalM2FromOrder(c?._activeOrder || {}), pieces: piecesSummaryFromOrder(c?._activeOrder || {}), address: orderAddress(c?._activeOrder || {}), updated_at: c?._activeOrder?.updated_at || c?._activeOrder?.created_at || '' })) })),
      warnings: { clients_read_failed: !!clientsRes?.error, transport_clients_read_failed: !!transportClientsRes?.error },
    };

    const attachments = buildBackupAttachment(backupPayload);
    const subject = `Fletore ditore — BAZË ${baseActiveClients.length} / TRANSPORT ${activeTransportOrders.length} (${new Date().toISOString().slice(0, 10)})`;
    const resend = await sendViaResend({ to, subject, html, attachments });
    return apiOk(res, { sent_to: to, base_count: baseActiveClients.length, base_orphan_count: orphanActiveOrders.length, transport_count: activeTransportOrders.length, transport_groups: transportGroups.map((g) => ({ id: g.id, name: g.name, count: g.activeClients.length })), attachment_count: attachments.length, resend });
  } catch (error) {
    return apiFail(res, 'CRON_BACKUP_FAILED', 500, { detail: String(error?.message || error) });
  }
}
