/* ===== Supabase thin client (browser) ===== */
window.SUPABASE_URL = "https://vnidjrxidvusulinozbn.supabase.co";
window.SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZuaWRqcnhpZHZ1c3VsaW5vemJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1MTk0NjAsImV4cCI6MjA3MzA5NTQ2MH0.hzGSFKU3sKuUKBUBsTE0rKIerj2uhG9pGS8_K9N7tpA";

function supa() {
  if (!window._supa) {
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON) {
      return null; // offline-only
    }
    window._supa = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON, {
      auth: { persistSession: false },
      global: { headers: { 'x-application-name': 'tepiha' } }
    });
  }
  return window._supa;
}

window.TepihaNet = { supa };