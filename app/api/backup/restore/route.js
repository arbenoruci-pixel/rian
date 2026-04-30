import { NextResponse } from "next/server";
import { getServiceSupabase } from "../_lib/sbAdmin";
import { backupUnauthorized, requireBackupPin } from "../_lib/auth";
export const dynamic = 'force-dynamic';

export const runtime = "nodejs";

async function getTableColumns(sb, tableName) {
  const { data, error } = await sb
    .from("information_schema.columns")
    .select("column_name")
    .eq("table_schema", "public")
    .eq("table_name", tableName);
  if (error) throw new Error(`COLUMNS_QUERY_FAILED_${tableName}: ${error.message}`);
  const cols = new Set((data || []).map((r) => r.column_name));
  return cols;
}

function pickKnown(obj, cols) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (cols.has(k)) out[k] = obj[k];
  }
  return out;
}

async function upsertInChunks(sb, table, rows, onConflict) {
  const chunkSize = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const { error } = await sb.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`UPSERT_FAILED_${table}: ${error.message}`);
    total += chunk.length;
  }
  return total;
}

export async function POST(req) {
  try {
    const auth = requireBackupPin(req);
    if (!auth.ok) return backupUnauthorized(auth);

    const url = new URL(req.url);
    const date = String(url.searchParams.get("date") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ ok: false, error: "DATE_REQUIRED", hint: "Use YYYY-MM-DD" }, { status: 400 });
    }

    const dry = String(url.searchParams.get("dry") || "").trim() === "1";

    const sb = getServiceSupabase();

    const { data: snap, error: snapErr } = await sb
      .from("backups_daily")
      .select("backup_date, clients_all, orders_all, clients_cnt, orders_cnt")
      .eq("backup_date", date)
      .maybeSingle();

    if (snapErr) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_BACKUP_SNAPSHOT_FAILED", detail: snapErr.message },
        { status: 500 }
      );
    }
    if (!snap) {
      return NextResponse.json({ ok: false, error: "BACKUP_NOT_FOUND", date }, { status: 404 });
    }

    const clientsAll = Array.isArray(snap.clients_all) ? snap.clients_all : [];
    const ordersAll = Array.isArray(snap.orders_all) ? snap.orders_all : [];

    const clientCols = await getTableColumns(sb, "clients");
    const orderCols = await getTableColumns(sb, "orders");

    const clientsRows = clientsAll.map((c) => pickKnown(c, clientCols)).filter((r) => Object.keys(r).length);
    const ordersRows = ordersAll.map((o) => pickKnown(o, orderCols)).filter((r) => Object.keys(r).length);

    const clientConflict = clientCols.has("id") ? "id" : clientCols.has("code") ? "code" : null;
    const orderConflict = orderCols.has("id") ? "id" : null;

    if (!clientConflict || !orderConflict) {
      return NextResponse.json(
        {
          ok: false,
          error: "MISSING_CONFLICT_KEYS",
          detail: { clientConflict, orderConflict },
        },
        { status: 500 }
      );
    }

    if (dry) {
      return NextResponse.json({
        ok: true,
        dry: true,
        date,
        snapshot: { clients_cnt: snap.clients_cnt, orders_cnt: snap.orders_cnt },
        will_upsert: { clients: clientsRows.length, orders: ordersRows.length },
      });
    }

    const restoredClients = await upsertInChunks(sb, "clients", clientsRows, clientConflict);
    const restoredOrders = await upsertInChunks(sb, "orders", ordersRows, orderConflict);

    return NextResponse.json({
      ok: true,
      date,
      restored: { clients: restoredClients, orders: restoredOrders },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "RESTORE_FAILED", detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
