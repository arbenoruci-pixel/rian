-- Legacy measurement forms retain empty input rows. Normalize them exactly as
-- the inspection UI does, without changing the saved order or evidence snapshot.
create or replace function public.transport_control_rows_v1(d jsonb)
returns jsonb language sql immutable set search_path='' as $$
 with raw as (
  select 'tepiha'::text kind,ord pos,r from jsonb_array_elements(coalesce(d->'tepiha',d->'tepihaRows','[]')) with ordinality t(r,ord)
  union all
  select 'staza',ord,r from jsonb_array_elements(coalesce(d->'staza',d->'stazaRows','[]')) with ordinality t(r,ord)
 ), normalized as (
  select kind,pos,
   case when r->>'qty' is not null then coalesce(nullif(btrim(r->>'qty'),'')::numeric,0)
        when r->>'pieces' is not null then coalesce(nullif(btrim(r->>'pieces'),'')::numeric,0)
        else 1 end qty,
   case when r->>'m2' is not null then coalesce(nullif(btrim(r->>'m2'),'')::numeric,0)
        else coalesce(nullif(btrim(coalesce(nullif(r->>'length',''),r->>'len')),'')::numeric,0)
             *coalesce(nullif(btrim(r->>'width'),'')::numeric,0) end area
  from raw
 ), rows as (
  select * from normalized where qty<>0 or area<>0
  union all
  select 'shkallore',1,coalesce(nullif(btrim(d->'shkallore'->>'qty'),'')::numeric,0),
   coalesce(nullif(nullif(btrim(d->'shkallore'->>'per'),'')::numeric,0),0.3)
  where coalesce(nullif(btrim(d->'shkallore'->>'qty'),'')::numeric,0)>0
 )
 select coalesce(jsonb_agg(jsonb_build_array(kind,qty,area) order by kind,pos),'[]') from rows;
$$;
