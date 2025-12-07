// lib/supabaseClient.js
// Hard-wired Supabase client for Arben's Tepiha Next.js app (OPTION B).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vnidjrxidvusulinozbn.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZuaWRqcnhpZHZ1c3VsaW5vemJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1MTk0NjAsImV4cCI6MjA3MzA5NTQ2MH0.hzGSFKU3sKuUKBUBsTE0rKIerj2uhG9pGS8_K9N7tpA';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
