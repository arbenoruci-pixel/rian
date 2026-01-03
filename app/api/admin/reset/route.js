import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// SERVER-ONLY admin client (Service Role). Never import this file into client code.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Extra guard: admin types this password in the Reset tab.
// Set in hosting env (Vercel/Render): TEPIHA_RESET_PASSWORD
const RESET_PASSWORD = process.env.TEPIHA_RESET_PASSWORD;

const BUCKET = 'tepiha-photos';

function jsonError(message, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function requireEnv() {
  if (!SUPABASE_URL) return 'Missing env NEXT_PUBLIC_SUPABASE_URL';
  if (!SERVICE_ROLE) return 'Missing env SUPABASE_SERVICE_ROLE_KEY';
  if (!RESET_PASSWORD) return 'Missing env TEPIHA_RESET_PASSWORD';
  return null;
}

const stageToStatuses = {
  // PRANIMI is drafts/reservations (orders created go straight to PASRTIMI in this project)
  PRANIMI: null,
  PASTRIMI: ['pastrim'],
  GATI: ['gati'],
  'MARRJE-SOT': ['dorzim'],
  TRANSPORT: ['transport', 'transporti', 'transport_incomplete', 'transport_ready', 'transport_ready_for_base', 'gati_transport', 'dorezim_transport'],
};

function createAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function listAllFiles(supabaseAdmin, folder) {
  const all = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).list(folder, {
      limit,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });

    if (error) throw error;
    if (!data || data.length === 0) break;

    // Keep only actual files (folders come back with id === null)
    for (const f of data) {
      if (f && f.id) all.push(`${folder}/${f.name}`);
    }

    if (data.length < limit) break;
    offset += limit;
  }

  return all;
}

async function removeMany(supabaseAdmin, paths) {
  if (!paths.length) return;
  // Remove in chunks to avoid request limits
  const chunkSize = 100;
  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove(chunk);
    if (error) throw error;
  }
}

async function downloadJson(supabaseAdmin, path) {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
  if (error) throw error;
  const text = await data.text();
  return JSON.parse(text);
}

async function wipeOrdersByStatuses(supabaseAdmin, statuses) {
  const allOrders = await listAllFiles(supabaseAdmin, 'orders');
  if (!allOrders.length) return { deleted: 0 };

  const toDelete = [];
  for (const path of allOrders) {
    try {
      const j = await downloadJson(supabaseAdmin, path);
      const st = String(j?.status || '').toLowerCase();
      if (statuses.includes(st)) toDelete.push(path);
    } catch {
      // If a file is corrupted/unreadable, skip it (don’t brick reset)
    }
  }

  await removeMany(supabaseAdmin, toDelete);
  return { deleted: toDelete.length };
}

async function wipeWholeFolder(supabaseAdmin, folder) {
  const files = await listAllFiles(supabaseAdmin, folder);
  await removeMany(supabaseAdmin, files);
  return { deleted: files.length };
}

export async function POST(req) {
  const envErr = requireEnv();
  if (envErr) return jsonError(envErr, 500);

  const supabaseAdmin = createAdminClient();

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { scope, stage, password } = body || {};

  if (!password || String(password) !== String(RESET_PASSWORD)) {
    return jsonError('Unauthorized (wrong reset password)', 403);
  }

  try {
    // SCOPES
    // FACTORY  : wipe orders + drafts + codes (keeps photos)
    // ARKA     : (this project keeps Arka mostly local) – no-op on storage
    // COUNTER  : wipe codes (restarts numeric code series)
    // STAGE    : wipe only orders matching the stage statuses (plus drafts for PRANIMI)

    if (scope === 'FACTORY') {
      const a = await wipeWholeFolder(supabaseAdmin, 'orders');
      const b = await wipeWholeFolder(supabaseAdmin, 'drafts');
      const c = await wipeWholeFolder(supabaseAdmin, 'codes');
      return NextResponse.json({ ok: true, scope, result: { orders: a, drafts: b, codes: c } });
    }

    if (scope === 'COUNTER') {
      const c = await wipeWholeFolder(supabaseAdmin, 'codes');
      return NextResponse.json({ ok: true, scope, result: { codes: c } });
    }

    if (scope === 'STAGE') {
      if (!stage) return jsonError('Missing stage', 400);
      const key = String(stage).toUpperCase();

      if (key === 'PRANIMI') {
        // Only drafts (orders created are already moved to PASRTIMI in this system)
        const d = await wipeWholeFolder(supabaseAdmin, 'drafts');
        return NextResponse.json({ ok: true, scope, stage: key, result: { drafts: d } });
      }

      const statuses = stageToStatuses[key];
      if (!statuses || !Array.isArray(statuses)) {
        return jsonError(`Unknown stage: ${key}`, 400);
      }

      const r = await wipeOrdersByStatuses(supabaseAdmin, statuses.map(s => String(s).toLowerCase()));
      return NextResponse.json({ ok: true, scope, stage: key, result: { orders: r } });
    }

    if (scope === 'ARKA') {
      // Project Arka = local moves/approvals. If you later store it in Supabase,
      // add DB deletes here.
      return NextResponse.json({ ok: true, scope, result: { note: 'No cloud Arka tables wired in this build' } });
    }

    return jsonError('Unknown scope', 400);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err?.message || 'Reset failed' }, { status: 500 });
  }
}
