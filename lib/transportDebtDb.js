// PATCH: Transport Debts (per transport_id) + cross-transport warning
// Safe: TRANSPORT only. Does not touch BASE modules.
//
// DB expectation (run SQL first):
// table public.transport_client_debts (
//   client_tcode text not null,
//   transport_id text not null,
//   debt_eur numeric not null default 0,
//   updated_at timestamptz not null default now(),
//   primary key (client_tcode, transport_id)
// );
//
// Optional: index for fast lookup by transport_id.
// create index on public.transport_client_debts(transport_id) where debt_eur > 0;

import { supabase } from "@/lib/supabaseClient";

export async function listDebtorsForTransport(transport_id, { limit = 200 } = {}) {
  const tid = String(transport_id || "").trim();
  if (!tid) throw new Error("MISSING_TRANSPORT_ID");

  const { data, error } = await supabase
    .from("transport_client_debts")
    .select("client_tcode, transport_id, debt_eur, updated_at")
    .eq("transport_id", tid)
    .gt("debt_eur", 0)
    .order("debt_eur", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function getDebtForClientOnTransport(client_tcode, transport_id) {
  const tcode = String(client_tcode || "").trim().toUpperCase();
  const tid = String(transport_id || "").trim();
  if (!tcode || !tid) return null;

  const { data, error } = await supabase
    .from("transport_client_debts")
    .select("client_tcode, transport_id, debt_eur, updated_at")
    .eq("client_tcode", tcode)
    .eq("transport_id", tid)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

// Returns debts on OTHER transports (for warning banner)
export async function getOtherTransportDebts(client_tcode, current_transport_id) {
  const tcode = String(client_tcode || "").trim().toUpperCase();
  const tid = String(current_transport_id || "").trim();
  if (!tcode) throw new Error("MISSING_CLIENT_TCODE");

  const q = supabase
    .from("transport_client_debts")
    .select("client_tcode, transport_id, debt_eur, updated_at")
    .eq("client_tcode", tcode)
    .gt("debt_eur", 0);

  // exclude current transport if provided
  const { data, error } = tid ? await q.neq("transport_id", tid) : await q;

  if (error) throw error;
  return data || [];
}

// Adjust debt for a client+transport by delta (positive adds debt, negative reduces)
export async function adjustDebt(client_tcode, transport_id, delta_eur) {
  const tcode = String(client_tcode || "").trim().toUpperCase();
  const tid = String(transport_id || "").trim();
  const delta = Number(delta_eur || 0);
  if (!tcode || !tid) throw new Error("MISSING_KEYS");

  // read current
  const cur = await getDebtForClientOnTransport(tcode, tid);
  const next = Math.max(0, Number(cur?.debt_eur || 0) + delta);

  const row = {
    client_tcode: tcode,
    transport_id: tid,
    debt_eur: next,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("transport_client_debts")
    .upsert(row, { onConflict: "client_tcode,transport_id" })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}
