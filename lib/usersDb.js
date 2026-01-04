
// lib/usersDb.js
import { supabase } from "@/lib/supabaseClient";

/*
  USERS DB — build-safe + tries multiple table names.
  Expected minimal fields: id, name, role, pin, is_active
*/

const TABLE_CANDIDATES = ["workers", "users", "app_users"];

async function firstTableThatWorks() {
  for (const t of TABLE_CANDIDATES) {
    try {
      const q = await supabase.from(t).select("id").limit(1);
      if (!q.error) return t;
    } catch {}
  }
  return null;
}

export async function findUserByPin(pin) {
  const p = String(pin || "").trim();
  if (!p) return null;

  const table = await firstTableThatWorks();
  if (!table) return null;

  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("pin", p)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function listUsers(limit = 200) {
  const table = await firstTableThatWorks();
  if (!table) return [];
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .order("id", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function upsertUser(user = {}) {
  const table = await firstTableThatWorks();
  if (!table) throw new Error("NO_USERS_TABLE");

  const row = {
    id: user.id || undefined,
    name: user.name || user.full_name || user.username || "USER",
    role: user.role || "WORKER",
    pin: String(user.pin || "").trim() || null,
    is_active: (user.is_active === undefined) ? true : !!user.is_active,
    updated_at: new Date().toISOString(),
  };

  // remove undefined
  Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);

  const { data, error } = await supabase
    .from(table)
    .upsert(row)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function ensureDefaultAdminIfEmpty() {
  const table = await firstTableThatWorks();
  if (!table) return false;

  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });

  if (error) throw error;
  if (Number(count || 0) > 0) return true;

  // create a default admin with PIN 0000 (change later in UI)
  const { error: insErr } = await supabase.from(table).insert({
    name: "ADMIN",
    role: "ADMIN",
    pin: "0000",
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (insErr) throw insErr;
  return true;
}
