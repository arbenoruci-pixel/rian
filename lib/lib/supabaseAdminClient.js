import { createClient } from '@supabase/supabase-js';

// Server-side Supabase client helper.
// Prefer SERVICE_ROLE, but fall back to ANON so backups can work even without service role.

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
  const anonKey = pickEnv(
    'SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_KEY',
    'SUPABASE_KEY'
  );

  if (!url) {
    throw new Error('MISSING_SUPABASE_URL');
  }

  const key = serviceKey || anonKey;
  if (!key) {
    throw new Error('MISSING_SUPABASE_KEY');
  }

  // When using anon key we must not rely on elevated privileges.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Backwards-compatible helper used by some API routes.
// Returns null (instead of throwing) when required env vars are missing.
export function createAdminClientOrNull() {
  try {
    return getSupabaseAdmin();
  } catch (_err) {
    return null;
  }
}

// Alias for older route implementations.
export function createAdminClientOrThrow() {
  return getSupabaseAdmin();
}
