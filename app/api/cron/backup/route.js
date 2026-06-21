import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdminClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ==============================================================
// 🛠️ KONFIGURIMI I EMAILIT
// ==============================================================
const CONFIG = {
  RESEND_API_KEY: 'FUT_KODIN_E_RESEND_KËTU',  // Këtu duhet kodi nga Resend.com (që fillon me re_...)
  EMAIL_KU_TE_VIJE: 'arbenoruci@gmail.com',   // Emaili yt u vendos saktë!
  EMAIL_NGA: 'onboarding@resend.dev'          
};
// ==============================================================

const BASE_DONE = new Set(['dorezuar', 'dorëzuar', 'dorzim', 'dorezim', 'paguar', 'anuluar', 'cancelled', 'canceled', 'failed', 'deshtuar', 'dështuar', 'deleted', 'void', 'arkiv', 'arkivuar', 'done', 'completed']);
const TRANSPORT_DONE = new Set(['dorezuar', 'dorëzuar', 'dorzim', 'dorezim', 'paguar', 'anuluar', 'cancelled', 'canceled', 'failed', 'deshtuar', 'dështuar', 'deleted', 'void', 'arkiv', 'arkivuar', 'done', 'completed']);

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function jparse(value, fallback = {}) {
  try {
    if (value && typeof value === 'object') return value;
    if (value == null || value === '') return fallback;
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function fmtDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('sq-AL', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/Belgrade',
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

function totalFromData(data, row) {
  const pay = asObject(data?.pay);
  const direct = Number(pay?.euro ?? pay?.total ?? row?.total ?? 0);
  if (Number.isFinite(direct) && direct > 0) return Number(direct.toFixed(2));
  const rate = Number(pay?.price ?? pay?.rate ?? data?.price ?? 0) || 0;
  const m2 = Number(pay?.m2 ?? 0) || 0;
  return Number((rate * m2).toFixed(2));
}

function filterActive(rows, doneSet, mapper) {
  return (rows || []).map(mapper).filter((row) => !doneSet.has(String(row?.status || '').toLowerCase()));
}

function buildTable(title, rows, columns) {
  const head = columns.map((col) => `<th style="padding:8px;border:1px solid #d4d4d8;background:#111827;color:#fff;text-align:left;font-size:12px;">${escapeHtml(col.label)}</th>`).join('');
  const body = rows.length
    ? rows.map((row) => `<tr>${columns.map((col) => `<td style="padding:8px;border:1px solid #e5e7eb;font-size:12px;vertical-align:top;">${escapeHtml(col.value(row))}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" style="padding:10px;border:1px solid #e5e7eb;font-size:12px;">Nuk ka porosi aktive.</td></tr>`;
  return `
    <div style="margin:0 0 24px 0;">
      <h2 style="margin:0 0 10px 0;font-size:18px;">${escapeHtml(title)} (${rows.length})</h2>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = CONFIG.RESEND_API_KEY;
  const from = CONFIG.EMAIL_NGA;
  
  if (!apiKey || apiKey === 'FUT_KODIN_E_RESEND_KËTU') throw new Error('MUNGON_KODI_I_RESEND_API');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : String(to).split(',').map((x) => x.trim()).filter(Boolean), subject, html }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.message || json?.error || `RESEND_${res.status}`);
  return json;
}

export async function GET(req) {
  try {
    const sb = getSupabaseAdmin();
    if (!sb) throw new Error('SUPABASE_ADMIN_MISSING');

    const [baseRes, transportRes, usersRes] = await Promise.all([
      sb.from('orders').select('id,code,client_name,client_phone,status,created_at,updated_at,data,total').order('created_at', { ascending: false }).limit(5000),
      sb.from('transport_orders').select('id,code_str,client_tcode,client_name,client_phone,status,created_at,updated_at,data,transport_id,visit_nr').order('created_at', { ascending: false }).limit(5000),
      sb.from('users').select('id,name,role').limit(5000),
    ]);

    if (baseRes?.error) throw baseRes.error;
    if (transportRes?.error) throw transportRes.error;

    const usersById = new Map(((usersRes?.error ? [] : usersRes?.data) || []).map((u) => [String(u?.id || '').trim(), u]));

    const baseRows = filterActive(baseRes?.data || [], BASE_DONE, (row) => {
      const data = jparse(row?.data, {});
      const client = asObject(data?.client);
      return {
        id: row?.id,
        code: String(row?.code || data?.code || client?.code || '').trim(),
        client_name: String(row?.client_name || client?.name || '').trim(),
        client_phone: String(row?.client_phone || client?.phone || '').trim(),
        status: String(row?.status || '').trim(),
        updated_at: row?.updated_at || row?.created_at,
        total: totalFromData(data, row),
      };
    });

    const transportRows = filterActive(transportRes?.data || [], TRANSPORT_DONE, (row) => {
      const data = jparse(row?.data, {});
      const client = asObject(data?.client);
      const tid = String(row?.transport_id || '').trim();
      return {
        id: row?.id,
        code: String(row?.code_str || row?.client_tcode || client?.tcode || '').trim(),
        client_name: String(row?.client_name || client?.name || '').trim(),
        client_phone: String(row?.client_phone || client?.phone || '').trim(),
        status: String(row?.status || '').trim(),
        updated_at: row?.updated_at || row?.created_at,
        visit_nr: String(row?.visit_nr || '').trim(),
        transport_name: String(usersById.get(tid)?.name || tid || 'PA CAKTUAR').trim(),
      };
    });

    const groupedTransport = transportRows.reduce((acc, row) => {
      const key = row.transport_name || 'PA CAKTUAR';
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});

    const transportSections = Object.keys(groupedTransport)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map((name) => buildTable(`Transporti — ${name}`, groupedTransport[name], [
        { label: 'Kodi', value: (r) => r.code || '-' },
        { label: 'Klienti', value: (r) => r.client_name || '-' },
        { label: 'Tel', value: (r) => r.client_phone || '-' },
        { label: 'Statusi', value: (r) => r.status || '-' },
        { label: 'Vizita', value: (r) => r.visit_nr || '-' },
        { label: 'Përditësuar', value: (r) => fmtDateTime(r.updated_at) },
      ])).join('');

    const html = `
      <div style="font-family:Arial,sans-serif;color:#111;">
        <h1 style="margin:0 0 12px 0;font-size:22px;">Backup ditor i porosive aktive</h1>
        <p style="margin:0 0 18px 0;font-size:14px;">Gjeneruar më ${escapeHtml(fmtDateTime(new Date().toISOString()))}</p>
        ${buildTable('Baza / Pastrimi', baseRows, [
          { label: 'Kodi', value: (r) => r.code || '-' },
          { label: 'Klienti', value: (r) => r.client_name || '-' },
          { label: 'Tel', value: (r) => r.client_phone || '-' },
          { label: 'Statusi', value: (r) => r.status || '-' },
          { label: 'Totali €', value: (r) => money(r.total) },
          { label: 'Përditësuar', value: (r) => fmtDateTime(r.updated_at) },
        ])}
        ${transportSections || buildTable('Transporti', [], [
          { label: 'Kodi', value: () => '-' },
          { label: 'Klienti', value: () => '-' },
          { label: 'Tel', value: () => '-' },
          { label: 'Statusi', value: () => '-' },
          { label: 'Vizita', value: () => '-' },
          { label: 'Përditësuar', value: () => '-' },
        ])}
      </div>
    `;

    const to = CONFIG.EMAIL_KU_TE_VIJE;
    const subject = `Backup ditor — aktive ${baseRows.length} baza / ${transportRows.length} transport (${new Date().toISOString().slice(0, 10)})`;
    
    const resend = await sendViaResend({ to, subject, html });

    return NextResponse.json({ ok: true, sent_to: to, base_count: baseRows.length, transport_count: transportRows.length, resend });
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'CRON_BACKUP_FAILED', detail: String(error?.message || error) }, { status: 500 });
  }
}
