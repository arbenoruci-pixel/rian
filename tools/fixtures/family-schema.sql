create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.role() returns text language sql as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
create table users(id uuid primary key,name text,role text,is_active boolean default true);
create table clients(id uuid primary key default gen_random_uuid(),code text unique,first_name text,last_name text,name text,full_name text,phone text,phone_digits text,photo_url text,created_at timestamptz default now(),updated_at timestamptz default now());
create table transport_clients(id uuid primary key default gen_random_uuid(),tcode text unique,name text,phone text,phone_digits text,address text,gps_lat text,gps_lng text,name_lc text,search_code bigint,notes text,created_at timestamptz default now(),updated_at timestamptz default now());
create table orders(id bigint primary key,client_id uuid,client_code integer,local_oid text,code bigint,client_name text,client_phone text,status text,data jsonb default '{}',total numeric,paid numeric,price_total numeric,paid_cash numeric,m2_total numeric,pieces integer,created_at timestamptz default now(),updated_at timestamptz default now(),ready_at timestamptz,picked_up_at timestamptz,delivered_at timestamptz);
create table transport_orders(id uuid primary key,client_id uuid,code_n bigint,code_str text,client_tcode text,client_name text,client_phone text,status text,visit_nr integer default 1,data jsonb default '{}',transport_create_fingerprint_v1 text,created_at timestamptz default now(),updated_at timestamptz default now(),ready_at timestamptz);
create table arka_pending_payments(id uuid primary key,order_id bigint,transport_order_id uuid,amount numeric,type text,status text,note text,order_code text,transport_code_str text,source_module text,created_at timestamptz default now(),updated_at timestamptz default now());
create table client_balances(phone text primary key,debt_eur numeric,updated_at timestamptz default now());
create table transport_client_debts(client_tcode text primary key,debt_eur numeric,updated_at timestamptz default now());
-- Snapshot of the live legacy normalizer; family SQL must work alongside it.
create function normalize_transport_phone_key(p_phone text) returns text language sql immutable as $$
 select case
 when regexp_replace(coalesce(p_phone,''),'\D','','g') like '00383%' then ltrim(substr(regexp_replace(coalesce(p_phone,''),'\D','','g'),6),'0')
 when regexp_replace(coalesce(p_phone,''),'\D','','g') like '383%' then ltrim(substr(regexp_replace(coalesce(p_phone,''),'\D','','g'),4),'0')
 else ltrim(regexp_replace(coalesce(p_phone,''),'\D','','g'),'0') end
$$;
create function normalize_transport_address_key(p text) returns text language sql immutable as $$ select lower(btrim(p)) $$;
create function ensure_transport_history_client_v1(p text) returns void language sql as $$ select $$;
create function release_transport_code_if_unused(p text,q text) returns boolean language sql as $$ select false $$;
create function reserve_transport_codes_batch(p text,q integer) returns jsonb language sql as $$ select '["T99999"]'::jsonb $$;
create table transport_client_locations(client_id uuid,address text,address_key text generated always as(lower(btrim(address))) stored,gps_lat text,gps_lng text,source_order_id uuid,last_used_at timestamptz,is_active boolean,unique(client_id,address_key));
create table transport_code_pool(code text primary key,status text,owner_id text);
create table offline_code_leases(lease_token uuid,scope text,code text,owner_id text,device_id text,status text,expires_at timestamptz,draft_session_id text);
grant usage on schema public,auth to service_role,anon,authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public,auth to service_role;
