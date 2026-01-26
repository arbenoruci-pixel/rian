import { NextResponse } from 'next/server';
import { createAdminClientOrNull } from '@/lib/supabaseAdminClient';

function json(data, status = 200) {
  return NextResponse.json(data, { status });
}

function pickExpectedPin() {
  // Support a few env names so Vercel setup is painless.
  return (
    process.env.TEPIHA_RESET_PASSWORD ||
    process.env.TEPIHA_RESET_PIN ||
    process.env.TEPIHA_ADMIN_PASSWORD ||
    process.env.RESET_PIN ||
    ''
  ).toString();
}

function cleanStr(v) {
  return (v ?? '').toString().trim();
}

async function safeDeleteAll(supabase, table, preferId = true) {
  // PostgREST requires a filter on delete(). We try common patterns and ignore “relation does not exist”.
  try {
    if (preferId) {
      const r1 = await supabase.from(table).delete().neq('id', -1);
      if (!r1.error) return { ok: true, table, deleted: true, mode: 'id_neq' };
      const msg = (r1.error?.message || '').toLowerCase();
      if (msg.includes('does not exist') || msg.includes('relation')) return { ok: true, table, skipped: 'missing_table' };
      // fallthrough to other modes
    }

    const r2 = await supabase.from(table).delete().not('id', 'is', null);
    if (!r2.error) return { ok: true, table, deleted: true, mode: 'id_not_null' };
    const msg2 = (r2.error?.message || '').toLowerCase();
    if (msg2.includes('does not exist') || msg2.includes('relation')) return { ok: true, table, skipped: 'missing_table' };

    // last resort: try created_at filter
    const r3 = await supabase.from(table).delete().not('created_at', 'is', null);
    if (!r3.error) return { ok: true, table, deleted: true, mode: 'created_at_not_null' };
    const msg3 = (r3.error?.message || '').toLowerCase();
    if (msg3.includes('does not exist') || msg3.includes('relation')) return { ok: true, table, skipped: 'missing_table' };

    return { ok: false, table, error: r3.error || r2.error };
  } catch (e) {
    const m = (e?.message || String(e)).toLowerCase();
    if (m.includes('does not exist') || m.includes('relation')) return { ok: true, table, skipped: 'missing_table' };
    return { ok: false, table, error: String(e?.message || e) };
  }
}

async function deleteAllStorageObjects(supabase, bucket, prefix = '') {
  // Best-effort recursive delete using list().
  // If bucket doesn't exist or permissions deny, we return a soft error.
  const deleted = [];
  const skipped = [];
  try {
    let offset = 0;
    const limit = 1000;

    while (true) {
      const { data, error } = await supabase.storage.from(bucket).list(prefix, {
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });

      if (error) {
        const msg = (error.message || '').toLowerCase();
        if (msg.includes('not found')) return { ok: true, bucket, skipped: 'missing_bucket' };
        return { ok: false, bucket, error: error.message || String(error) };
      }
      const items = Array.isArray(data) ? data : [];
      if (items.length === 0) break;

      // Collect file paths (Supabase list returns folders as items without metadata in some cases)
      const files = [];
      const folders = [];

      for (const it of items) {
        const name = it?.name;
        if (!name) continue;

        // Heuristic: if it has "id" or "updated_at" and no "metadata", it still can be a file.
        // If it has a "metadata" object, it's almost certainly a file.
        // If it has no metadata and name doesn't contain '.', it might be a folder.
        const hasMetadata = !!it?.metadata;
        const looksLikeFolder = !hasMetadata && !String(name).includes('.') && !String(name).includes('/');
        const path = prefix ? `${prefix}/${name}` : name;

        if (looksLikeFolder) folders.push(path);
        else files.push(path);
      }

      // Delete files
      if (files.length) {
        const del = await supabase.storage.from(bucket).remove(files);
        if (del?.error) {
          return { ok: false, bucket, error: del.error.message || String(del.error) };
        }
        deleted.push(...files);
      }

      // Recurse folders
      for (const f of folders) {
        const sub = await deleteAllStorageObjects(supabase, bucket, f);
        if (!sub.ok) return sub;
        if (sub.deleted?.length) deleted.push(...sub.deleted);
        if (sub.skipped) skipped.push({ folder: f, skipped: sub.skipped });
      }

      // If we got < limit, done; else paginate.
      if (items.length < limit) break;
      offset += limit;
    }

    return { ok: true, bucket, deleted, skipped };
  } catch (e) {
    return { ok: false, bucket, error: String(e?.message || e) };
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));

    const expectedPin = cleanStr(pickExpectedPin());
    // If no env is set, allow the default UI pin 2380 (still requires confirm RESET)
    const fallbackPin = '2380';

    // Accept multiple body keys (compat with older client)
    const gotPin =
      cleanStr(body.reset_pin) ||
      cleanStr(body.pin) ||
      cleanStr(body.password);

    const confirm =
      cleanStr(body.confirm_text) ||
      cleanStr(body.confirm) ||
      cleanStr(body.word);

    const pinOk = expectedPin ? gotPin === expectedPin : gotPin === fallbackPin;
    if (!pinOk || confirm.toUpperCase() !== 'RESET') {
      return json({ ok: false, error: 'WRONG_RESET_PIN' }, 401);
    }

    const supabase = createAdminClientOrNull();
    if (!supabase) {
      return json(
        {
          ok: false,
          error: 'MISSING_ENV_VARS',
          detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel env.',
        },
        500
      );
    }

    // Delete tables (best-effort)
    const results = [];

    // Core business tables
    results.push(await safeDeleteAll(supabase, 'orders'));
    results.push(await safeDeleteAll(supabase, 'clients'));

    // Backup tables
    results.push(await safeDeleteAll(supabase, 'app_backups'));
    results.push(await safeDeleteAll(supabase, 'backups'));

    // ARKA tables
    results.push(await safeDeleteAll(supabase, 'arka_payments'));
    results.push(await safeDeleteAll(supabase, 'arka_pending_payments'));
    results.push(await safeDeleteAll(supabase, 'arka_expense_requests')); // optional
    results.push(await safeDeleteAll(supabase, 'arka_expenses'));
    results.push(await safeDeleteAll(supabase, 'arka_cycle_moves'));
    results.push(await safeDeleteAll(supabase, 'arka_cycles'));
    results.push(await safeDeleteAll(supabase, 'arka_days'));
    results.push(await safeDeleteAll(supabase, 'arka_opening_float'));
    results.push(await safeDeleteAll(supabase, 'arka_company_moves')); // optional

    // Photos bucket wipe (best-effort)
    const bucket = (process.env.TEPIHA_PHOTOS_BUCKET || 'tepiha-photos').toString();
    const storage = await deleteAllStorageObjects(supabase, bucket);

    // If any “hard errors”, return 500; missing tables/bucket are ok.
    const hard = results.filter((r) => r && r.ok === false);
    if (hard.length) {
      return json({ ok: false, error: 'RESET_PARTIAL_FAILED', tables: results, storage }, 500);
    }

    return json({ ok: true, tables: results, storage });
  } catch (e) {
    return json({ ok: false, error: 'UNEXPECTED', detail: e?.message || String(e) }, 500);
  }
}
