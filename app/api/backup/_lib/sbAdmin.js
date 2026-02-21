import { createClient } from '@supabase/supabase-js';

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`MISSING_${name}`);
  return v;
}

export function getServiceSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('MISSING_SUPABASE_URL');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('MISSING_SUPABASE_SERVICE_ROLE_KEY');

  // IMPORTANT: do not trim URL, but DO trim the key because Vercel sometimes saves with newline
  const serviceKey = String(key).trim();

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
