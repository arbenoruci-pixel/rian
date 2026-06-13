// Compatibility shim: some routes import '@/lib/supabaseAdmin'
// while others import '@/lib/supabaseAdminClient'.
// Keep both working.

export { getSupabaseAdmin } from './supabaseAdminClient';

// Optional default export-style helper
export function supabaseAdmin() {
  return getSupabaseAdmin();
}
