-- Adds idempotency support to ARKA moves.
-- Run once in Supabase SQL editor.

alter table if exists public.arka_moves
  add column if not exists external_id text;

-- Make it unique so the app can retry inserts safely.
create unique index if not exists arka_moves_external_id_uq
  on public.arka_moves (external_id)
  where external_id is not null;
