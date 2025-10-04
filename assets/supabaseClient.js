// Minimal Supabase client bootstrap (no external fetch; assumes you include the official CDN too)
// Include the CDN in your HTML before this file:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

;(function(){
  if (!window.__SUPABASE_URL__ || !window.__SUPABASE_ANON_KEY__) {
    console.warn("Supabase env not set. Fill window.__SUPABASE_URL__ and window.__SUPABASE_ANON_KEY__ in assets/env.js");
    window.supabase = null;
    return;
  }
  try {
    // global 'supabase' object via CDN: createClient
    window.sb = window.supabase && window.supabase.createClient
      ? window.supabase.createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON_KEY__)
      : null;
    if (!window.sb) console.warn("Supabase CDN not loaded. Add the script tag for @supabase/supabase-js.");
  } catch (e) {
    console.error("Supabase init error:", e);
    window.sb = null;
  }
})();