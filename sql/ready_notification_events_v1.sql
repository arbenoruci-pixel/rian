begin;
create table if not exists public.ready_notification_events (
  id uuid primary key,
  attempt_id uuid not null,
  order_id bigint not null references public.orders(id),
  actor_id uuid not null references public.users(id),
  author_name text not null,
  channel text not null check (channel in ('sms','whatsapp','viber')),
  kind text not null check (kind in ('opened','confirmed','cancelled')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists ready_notification_events_order_idx on public.ready_notification_events(order_id,created_at desc);
alter table public.ready_notification_events enable row level security;
revoke all on public.ready_notification_events from public, anon, authenticated, service_role;
grant select, insert on public.ready_notification_events to service_role;
comment on table public.ready_notification_events is 'Append-only worker notification claims. opened is app handoff; confirmed is worker attestation, never a provider delivery receipt. Server authenticates device and author.';
commit;
