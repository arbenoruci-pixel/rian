import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { BUJAR_USER_ID, BONUS_EVIDENCE_BUCKET } from '../lib/baseBonusEvidence.js';
import { bonusEvidenceAction, authenticateBonusEvidenceActor, cleanupBonusEvidence } from '../lib/baseBonusEvidenceServer.js';
import { createBonusEvidenceHandler } from '../api/base-bonus-evidence.js';

const db = new PGlite(); let checks=0;
const check=(v,label)=>{assert.ok(v,label);checks++;console.log('PASS',label)};
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name)); alter table storage.objects enable row level security;
create policy legacy_open on storage.objects for all to anon,authenticated using(true) with check(true);
grant usage on schema public,storage to service_role,anon,authenticated; grant all on all tables in schema storage to service_role,anon,authenticated;`);
await db.exec(fs.readFileSync('tools/fixtures/base-bonus-evidence-schema.sql','utf8'));
await db.exec(`create function public.get_base_ready_bonus_summary_v1(text,text,date) returns jsonb language sql as $$ select '{}'::jsonb $$;
grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;`);
await db.exec(fs.readFileSync('supabase/migrations/20261028035849_bujar_bonus_evidence_24h.sql','utf8'));
await db.exec(`create trigger enforce_bujar before insert or update on base_ready_bonuses for each row execute function enforce_bujar_only_base_bonus_v1();
create trigger enforce_bujar_cash before insert or update on arka_pending_payments for each row execute function block_non_bujar_bonus_payment_v1();
create function fixture_bonus_trigger() returns trigger language plpgsql security definer as $$ begin perform apply_base_ready_bonus_after_payment_v3(new.id,null,now()); return new; end $$;
create trigger trg_bonus_after after update of status,paid,paid_cash,data on orders for each row execute function fixture_bonus_trigger();`);
const dispatch=randomUUID(),other=randomUUID(),disabled=randomUUID();
for(const [id,name,role,active,pin] of [[BUJAR_USER_ID,'Bujar','PUNTOR',true,'5555'],[dispatch,'Dispatch','DISPATCH',true,'2020'],[other,'Other','PUNTOR',true,'1111'],[disabled,'Disabled','DISPATCH',false,'2222']]) await db.query('insert into users(id,name,role,is_active,pin) values($1,$2,$3,$4,$5)',[id,name,role,active,pin]);
await db.exec(`insert into base_ready_bonus_config(id,enabled,window_hours,rate_m2,effective_from) values(1,true,72,0.10,now()-interval '1 year'); set role service_role;`);
let nextOrder=100;
async function order({age=70,status='gati'}={}) { const id=nextOrder++;await db.query("insert into orders(id,code,status,created_at,ready_at,updated_at,data,m2_total,price_total,total,paid,paid_cash) values($1,$1,$2,clock_timestamp()-($3*interval '1 hour'),clock_timestamp()-interval '1 hour',clock_timestamp(),$4,20,20,20,0,0)",[id,status,age,{ready_by_pin:'5555',pay:{euro:20,paid:0,debt:20}}]);return id; }
const prepare=(id,actor=BUJAR_USER_ID,shelf='A12')=>one('select bujar_bonus_evidence_prepare_v1($1,$2,$3) as value',[id,actor,shelf]);
const submit=(r,actor=BUJAR_USER_ID)=>one('select bujar_bonus_evidence_submit_v1($1,$2,$3,$4) as value',[r.id,actor,'a'.repeat(64),'b'.repeat(64)]);
const review=(r,decision='APPROVED',actor=dispatch,note='')=>one('select bujar_bonus_evidence_review_v1($1,$2,$3,$4) as value',[r.id,actor,decision,note]);
const row=id=>one('select to_jsonb(r) as value from base_bonus_extensions r where order_id=$1',[id]);
const bonus=id=>one('select to_jsonb(b) as value from base_ready_bonuses b where order_id=$1',[id]);
async function images(r){for(const path of [r.carpet_path,r.message_path])await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3) on conflict do nothing',[BONUS_EVIDENCE_BUCKET,path,{mimetype:'image/jpeg',size:1000}]);}
async function readyRequest(id){const r=await prepare(id);await images(r);return submit(r);}
async function advance(id,hours){await db.query("update orders set created_at=created_at-($2*interval '1 hour'),ready_at=ready_at-($2*interval '1 hour') where id=$1",[id,hours]);await db.query("update base_bonus_extensions set created_at=created_at-($2*interval '1 hour'),original_deadline=original_deadline-($2*interval '1 hour'),extended_deadline=extended_deadline-($2*interval '1 hour'),submitted_at=submitted_at-($2*interval '1 hour') where order_id=$1",[id,hours]);}
async function collect(id,{paid=20}={}){await db.query("insert into arka_pending_payments(order_id,amount,type,status,source_module,created_by_pin,created_at) values($1,$2,'IN','PENDING','BASE','5555',clock_timestamp())",[id,paid]);await db.query("update orders set status='dorzim',paid=$2,paid_cash=$2,data=jsonb_build_object('pay',jsonb_build_object('euro',20,'paid',$2::numeric,'debt',20-$2::numeric)) where id=$1",[id,paid]);}

await assert.rejects(prepare(await order(),other),/BUJAR_ONLY/);
await assert.rejects(prepare(await order({status:'pastrim'})),/READY_REQUIRED/);
await assert.rejects(prepare(await order({age:72.001})),/DEADLINE_PASSED/);
await assert.rejects(prepare(await order(),BUJAR_USER_ID,'A99'),/SHELF_REQUIRED/);
check(true,'only Bujar, READY base orders, valid rack and unexpired 72h can prepare');
const id=await order(),draft=await prepare(id);
assert.equal((await prepare(id)).id,draft.id);
assert.equal(Date.parse(draft.extended_deadline)-Date.parse(draft.original_deadline),24*3600000);
await assert.rejects(submit(draft),/TWO_PHOTOS_REQUIRED/);await images(draft);
let pending=await submit(draft);assert.equal(pending.status,'PENDING');assert.equal((await submit(draft)).submitted_at,pending.submitted_at);
for(const actor of [BUJAR_USER_ID,other,disabled])await assert.rejects(review(pending,'APPROVED',actor),/REVIEW_FORBIDDEN/);
check(true,'both media required; duplicate submit idempotent; approval restricted to active dispatch/admin');
await advance(id,3); // 73h: original deadline passed, submitted evidence remains valid.
await collect(id);
assert.equal(await bonus(id),undefined);assert.equal((await row(id)).status,'PENDING');
assert.deepEqual(await one('select bujar_bonus_evidence_cleanup_list_v1($1,null) as value',[pending.id]),[]);
check(true,'payment at 73h waits for dispatch, never auto-awards and keeps evidence for review');
let approved=await review(pending);assert.equal(approved.status,'APPROVED');assert.equal((await bonus(id)).amount,2);
const earned=(await bonus(id)).id;
await review(pending);await db.query('select apply_base_ready_bonus_after_payment_v3($1,null,now())',[id]);
assert.equal((await bonus(id)).id,earned);
assert.equal(await one("select count(*)::int as value from arka_pending_payments where order_id=$1 and type='READY_48H_BONUS'",[id]),1);
check(true,'late approval reconciles pickup within 96h exactly once and awards 0.10/m²');
await assert.rejects(review(pending,'REJECTED',dispatch,'invalid'),/REVIEW_CONFLICT/);
const cleanup=await one('select bujar_bonus_evidence_cleanup_list_v1($1,null) as value',[pending.id]);assert.equal(cleanup.length,1);
check(true,'opposite concurrent decision cannot overwrite approval; pickup queues physical media removal');

const rejectedId=await order(),rejected=await readyRequest(rejectedId);await assert.rejects(review(rejected,'REJECTED'),/REJECT_REASON_REQUIRED/);await review(rejected,'REJECTED',dispatch,'Kodi nuk shihet');await advance(rejectedId,3);await collect(rejectedId);assert.equal(await bonus(rejectedId),undefined);
check(true,'rejection requires a reason and grants no 24h extension');
const lateId=await order(),late=await readyRequest(lateId);await review(late);await advance(lateId,27);await collect(lateId);assert.equal(await bonus(lateId),undefined);
check(true,'approved proof cannot award after the fixed 96h deadline');
const partialId=await order(),partial=await readyRequest(partialId);await review(partial);await advance(partialId,3);await collect(partialId,{paid:10});assert.equal(await bonus(partialId),undefined);
check(true,'partial payment cannot earn the extension bonus');
const earlyId=await order(),early=await readyRequest(earlyId);await collect(earlyId);assert.equal((await bonus(earlyId)).amount,2);
check(true,'normal completion before 72h still earns without waiting for extension approval');
const notTakenId=await order(),notTaken=await readyRequest(notTakenId);await review(notTaken);await advance(notTakenId,3);await db.query("insert into arka_pending_payments(order_id,amount,type,status,source_module,created_by_pin,created_at) values($1,20,'IN','PENDING','BASE','5555',clock_timestamp())",[notTakenId]);await db.query("update orders set paid=20,paid_cash=20,data=jsonb_build_object('pay',jsonb_build_object('euro',20,'paid',20,'debt',0)) where id=$1",[notTakenId]);assert.equal(await bonus(notTakenId),undefined);
check(true,'extended award requires actual pickup as well as payment');
const expiredId=await order(),expired=await prepare(expiredId);await images(expired);await advance(expiredId,3);await assert.rejects(submit(expired),/DEADLINE_PASSED/);
check(true,'starting upload before 72h never permits submitting after 72h');
const staleId=await order(),stale=await readyRequest(staleId);await advance(staleId,200);await one('select bujar_bonus_evidence_cleanup_list_v1($1,null) as value',[stale.id]);assert.equal((await row(staleId)).status,'EXPIRED');await assert.rejects(review(stale),/REVIEW_CONFLICT/);
check(true,'abandoned pending evidence has bounded retention and cannot later approve');

// Real SQL authorization: direct Data API callers cannot read/write requests or approve.
await db.exec('reset role');
for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(db.query('select * from base_bonus_extensions'),/permission denied/);await assert.rejects(prepare(id),/permission denied/);await assert.rejects(review(pending),/permission denied/);await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('base-bonus-evidence','forged')"),/row-level security/);await db.exec('reset role');}
check(true,'RLS/grants block direct proof mutation and broad legacy storage policies cannot expose new bucket');
await db.exec('set role service_role');
const calls=[];let storageFail=true;
const client={rpc:async(name,p)=>{try{if(name==='bujar_bonus_evidence_cleanup_list_v1')return {data:await one('select bujar_bonus_evidence_cleanup_list_v1($1,$2) as value',[p.p_request_id,p.p_order_id])};return {data:await one('select bujar_bonus_evidence_cleanup_done_v1($1) as value',[p.p_request_id])};}catch(e){return {error:{message:e.message}}}},storage:{from(bucket){assert.equal(bucket,BONUS_EVIDENCE_BUCKET);return {remove:async paths=>{calls.push(paths);return storageFail?{error:{message:'temporary failure'}}:{data:paths};}}}}};
assert.equal((await cleanupBonusEvidence(client,{requestId:pending.id})).failed,1);assert.equal((await row(id)).files_deleted_at,null);
storageFail=false;assert.equal((await cleanupBonusEvidence(client,{requestId:pending.id})).deleted,1);assert((await row(id)).files_deleted_at);assert.equal(calls[0].length,2);assert.equal((await row(id)).status,'APPROVED');
check(true,'Storage API removes both images, failures retry and audit/approval metadata survives');

// API authentication and CSRF boundary; caller-supplied PIN/role never grants access.
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v},end(s){this.body=JSON.parse(s)}});
const req={method:'POST',headers:{host:'test.local',origin:'https://test.local','content-type':'application/json',cookie:'tepiha_device_id=test-device'},body:{action:'LIST',expectedActorId:BUJAR_USER_ID}};
let executed=0;
const handler=createBonusEvidenceHandler({createClient:()=>({}),authenticate:async(_,device)=>{assert.equal(device,'test-device');return {id:BUJAR_USER_ID,role:'PUNTOR',is_active:true}},action:async()=>{executed++;return {items:[]}}});
for(const bad of [{...req,method:'GET'},{...req,headers:{...req.headers,origin:'https://evil.test'}},{...req,headers:{...req.headers,'content-type':'text/plain'}}]){const res=response();await handler(bad,res);assert(res.statusCode>=400)}
assert.equal(executed,0);const res=response();await handler(req,res);assert.equal(res.statusCode,200);assert.equal(res.headers['cache-control'],'private, no-store, max-age=0');
await assert.rejects(bonusEvidenceAction({action:'LIST',expectedActorId:BUJAR_USER_ID},{actor:{id:other,role:'PUNTOR',is_active:true},supabase:{}}),/FORBIDDEN/);
await assert.rejects(bonusEvidenceAction({action:'LIST',expectedActorId:other},{actor:{id:BUJAR_USER_ID,role:'PUNTOR',is_active:true},supabase:{}}),/SESSION_CHANGED/);
check(true,'API rejects cross-site requests, invalid methods/content type, other workers and stale sessions');
const authClient=(device,user)=>({from(table){return {select(){return this},eq(){return this},async maybeSingle(){return {data:table==='users'?user:device}}}}});
await assert.rejects(authenticateBonusEvidenceActor(authClient(null,null),''),/AUTH_REQUIRED/);
await assert.rejects(authenticateBonusEvidenceActor(authClient({user_id:BUJAR_USER_ID,is_approved:false},null),'device'),/DEVICE_NOT_APPROVED/);
await assert.rejects(authenticateBonusEvidenceActor(authClient({user_id:other,is_approved:true},{id:other,role:'PUNTOR',is_active:true}),'device'),/FORBIDDEN/);
await assert.rejects(authenticateBonusEvidenceActor(authClient({user_id:dispatch,is_approved:true},{id:dispatch,role:'DISPATCH',is_active:false}),'device'),/FORBIDDEN/);
assert.equal((await authenticateBonusEvidenceActor(authClient({user_id:BUJAR_USER_ID,is_approved:true},{id:BUJAR_USER_ID,role:'PUNTOR',is_active:true}),'device')).id,BUJAR_USER_ID);
check(true,'approved-device cookie resolves current active user; stale PIN/role cannot authorize another worker');
const normalEarly=await order();await collect(normalEarly);assert.equal((await bonus(normalEarly)).amount,2);
const normalLate=await order({age:73});await collect(normalLate);assert(!((await bonus(normalLate))?.eligible));
check(true,'unchanged 72h bonus path still earns before deadline and does not earn after it without evidence');
const jpg = n => new Blob([new Uint8Array([255,216,255,...Array(120).fill(n),255,217])],{type:'image/jpeg'});
const fakeRequest={id:randomUUID(),worker_id:BUJAR_USER_ID,status:'DRAFT',carpet_path:'carpet',message_path:'message'};
let imageKind='same',submitted=0;
const mediaClient={from(){return {select(){return this},eq(){return this},maybeSingle:async()=>({data:fakeRequest})}},storage:{from(){return {download:async path=>({data:imageKind==='invalid'?new Blob(['not JPEG']):jpg(imageKind==='same'?1:path==='carpet'?1:2)})}}},rpc:async()=>{submitted++;return {data:{...fakeRequest,status:'PENDING'}}}};
const bujarActor={id:BUJAR_USER_ID,role:'PUNTOR',is_active:true};
await assert.rejects(bonusEvidenceAction({action:'SUBMIT',expectedActorId:BUJAR_USER_ID,requestId:fakeRequest.id},{supabase:mediaClient,actor:bujarActor}),/DIFFERENT_PHOTOS_REQUIRED/);
imageKind='invalid';await assert.rejects(bonusEvidenceAction({action:'SUBMIT',expectedActorId:BUJAR_USER_ID,requestId:fakeRequest.id},{supabase:mediaClient,actor:bujarActor}),/IMAGE_SIZE/);
assert.equal(submitted,0);imageKind='valid';assert.equal((await bonusEvidenceAction({action:'SUBMIT',expectedActorId:BUJAR_USER_ID,requestId:fakeRequest.id},{supabase:mediaClient,actor:bujarActor})).request.status,'PENDING');
fakeRequest.status='PENDING';fakeRequest.carpet_hash='0'.repeat(64);fakeRequest.message_hash='0'.repeat(64);
await assert.rejects(bonusEvidenceAction({action:'REVIEW',expectedActorId:dispatch,requestId:fakeRequest.id,decision:'APPROVED',checkedCarpet:true,checkedMessage:true},{supabase:mediaClient,actor:{id:dispatch,role:'DISPATCH',is_active:true}}),/FILES_CHANGED/);
check(true,'server validates two different JPEGs and rechecks their hashes before approval');
await db.close();console.log(`Verified ${checks} Bujar evidence groups.`);
