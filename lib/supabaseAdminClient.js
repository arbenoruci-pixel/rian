import { createClient } from "@supabase/supabase-js";

let _admin = null;

function cleanOneLine(v) {
  // Removes spaces + newlines that often get pasted from phone
  return String(v || "").replace(/\s+/g, "").trim();
}

function cleanUrl(v) {
  let url = String(v || "").trim();
  if (!url) return "";
  // allow project ref pasted instead of full url
  if (!url.startsWith("http")) url = "https://" + url;
  // remove any trailing slashes/spaces
  url = url.replace(/\/+$/, "");
  return url;
}

export function getSupabaseAdmin() {
  if (_admin) return _admin;

  const url = cleanUrl(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ""
  );

  const key = cleanOneLine(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!url) throw new Error("MISSING_SUPABASE_URL");
  if (!key) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");

  _admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _admin;
}
