// Thin wrapper so ARKA modules can share the same Supabase client
// without duplicating configuration or breaking imports.
import { supabase } from "@/lib/supabaseClient";

export function getSupabaseClient() {
  return supabase;
}
