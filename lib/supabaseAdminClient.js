import { createClient } from '@supabase/supabase-js';

function pickEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

export function getSupabaseAdmin() {
  const url = pickEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = pickEnv('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = pickEnv('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');

  if (!url) return null; // Mos hidh error gjatë build-it

  const key = serviceKey || anonKey;
  if (!key) return null;

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createAdminClientOrNull() {
  try {
    return getSupabaseAdmin();
  } catch (_err) {
    return null;
  }
}

export function createAdminClientOrThrow() {
  const client = getSupabaseAdmin();
  if (!client) throw new Error("Missing Supabase Config");
  return client;
}
