import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { auditProcessingStarted, summarizeAuditOrder, canAuditInventory, AUDIT_AGE_MS } from '../lib/inventoryAudit.js';
import { inventoryAuditAction } from '../lib/inventoryAuditServer.js';
import { createInventoryAuditHandler } from '../api/inventory-audit.js';

const db = new PGlite();
let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; console.log('PASS', label); };
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
const admin = randomUUID(), dispatch = randomUUID(), worker = randomUUID(), driver = randomUUID(), disabled = randomUUID(), transportId = randomUUID();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create table users(id uuid primary key, name text, role text, is_active boolean);
create table orders(id bigint primary key, code bigint, client_id uuid, status text, data jsonb default '{}', created_at timestamptz, updated_at timestamptz, ready_at timestamptz, total numeric, paid numeric, pieces integer);
create table transport_orders(id uuid primary key, client_tcode text, client_id uuid, status text, data jsonb default '{}', created_at timestamptz, updated_at timestamptz, ready_at timestamptz, total numeric, paid numeric, pieces integer);
grant usage on schema public to service_role,anon,authenticated;
grant select on users to service_role; grant all on orders,transport_orders to service_role,anon,authenticated;`);
// Model the live payment triggers: they run on every data/status edit, even
// when no monetary field changed. Audit must skip this unrelated reconciliation.
await db.exec(`create table bonus_trigger_calls(id bigserial,order_id bigint);
create function fixture_bonus() returns trigger language plpgsql security definer as $$ begin insert into bonus_trigger_calls(order_id) values(new.id); return new; end $$;
create trigger trg_base_ready_bonus_on_full_payment_v2 after update of data,status on orders for each row execute function fixture_bonus();
create trigger trg_base_ready_bonus_order_payment_v3 after update of data,status on orders for each row execute function fixture_bonus();
grant select on bonus_trigger_calls to service_role;`);
await db.exec(fs.readFileSync('supabase/migrations/20261011155334_order_inventory_audit_v1.sql','utf8'));
for (const [id,role,active] of [[admin,'ADMIN',true],[dispatch,'DISPATCH',true],[worker,'PUNTOR',true],[driver,'TRANSPORT',true],[disabled,'ADMIN',false]]) await db.query('insert into users values ($1,$2,$2,$3)',[id,role,active]);
const revision = '2026-01-01T00:00:00.123456+00:00';
const data = { client:{name:'Fixture',phone:'044000000'}, tepiha:[{qty:3,m2:10}],pay:{euro:30,paid:10}, audit:{history:[{status:'needs_review'}]}, data:{keep:'nested'} };
for (const id of [1,2,3,4,5,6]) await db.query("insert into orders values($1,123,$2,'pastrim',$3,now()-interval '6 days',$4,null,30,10,3)",[id,randomUUID(),data,revision]);
await db.query("update orders set data=data || jsonb_build_object('pastrim_started_at',now()-interval '1 day') where id=2");
await db.query("update orders set status='dorzim' where id=3");
await db.query("update orders set created_at=null where id=4");
await db.query("insert into transport_orders values($1,'T123',$2,'pastrim',$3,now()-interval '6 days',$4,null,40,20,4)",[transportId,randomUUID(),data,revision]);
await db.exec('truncate bonus_trigger_calls');
const baseBefore=await one('select to_jsonb(o) as value from orders o where id=1');
const row= (table,id) => one(`select to_jsonb(o) as value from ${table} o where id=$1`,[id]);
const write= async (id,options={}) => one('select inventory_audit_write_v1($1,$2,$3,$4,$5,$6,$7,$8) as value',[
 options.table||'orders',String(id),options.actor||admin,options.action||'MOVE_READY',options.result||'unverified',options.revision===undefined?revision:options.revision,options.op||randomUUID(),options.note||'']);
await db.exec('set role service_role');
for (const actor of [worker,driver,disabled,randomUUID()]) await assert.rejects(write(1,{actor}),/AUDIT_FORBIDDEN/);
check(true,'database rejects workers, Transport, inactive and missing actors');
for (const [id,code] of [[2,'NOT_OVER_FOUR_DAYS'],[3,'STATUS_CHANGED'],[4,'DATE_UNKNOWN']]) await assert.rejects(write(id),new RegExp('AUDIT_'+code));
check(true,'recent processing, delivered orders and unknown dates cannot move');
for (const d of [{pastrim_started_at:'2026-01-05T10:00:00Z'}, {status_history:[{to:'pastrim',at:'2026-02-03T12:00:00Z'}]}, {pastrim_started_at:'invalid',ts:1767225600000}, {data:{base_processing_at:1767225600}}]) {
 const r={data:d,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-10-11T00:00:00Z'};
 assert.equal(Date.parse(await one('select inventory_audit_started_at_v1($1)::text as value',[r])),auditProcessingStarted(r));
}
const now=Date.now();
check(!summarizeAuditOrder({id:1,status:'pastrim',created_at:new Date(now-AUDIT_AGE_MS).toISOString()},'orders',now).overdue,'exactly four days is not overdue');
check(summarizeAuditOrder({id:1,status:'pastrim',created_at:new Date(now-AUDIT_AGE_MS-1).toISOString()},'orders',now).overdue,'more than four days is overdue');
const op=randomUUID();let moved=await write(1,{op});
check(moved.row.status==='gati' && moved.row.data.inventory_audit.result==='unverified','bulk correction moves to Gati awaiting physical verification');
for(const k of ['id','code','client_id','total','paid','pieces']) assert.deepEqual(moved.row[k],baseBefore[k]);
for(const k of ['client','tepiha','pay']) assert.deepEqual(moved.row.data[k],baseBefore.data[k]);
check(moved.row.data.data.keep==='nested' && moved.row.data.audit.history.length===1,'identity, money, measurements and prior history preserved');
check((await write(1,{op})).replayed,'lost response retry replays without duplicate mutation');
await assert.rejects(write(1,{op,note:'different'}),/AUDIT_OPERATION_CONFLICT/);
await assert.rejects(write(1,{action:'VERIFY',result:'not_found'}),/AUDIT_STALE/);
check(true,'reused operation mismatch and second device stale revision rejected');
let verified=await write(1,{action:'VERIFY',result:'not_found',actor:dispatch,revision:moved.row.updated_at,note:'Check rack'});
check(verified.row.status==='gati' && verified.row.data.inventory_audit.by_id===dispatch,'Dispatch can mark missing and missing order remains in Gati');
check((await one("select count(*)::int as value from inventory_audit_events where order_id='1'"))===2,'audit stores exactly one attributed event per committed action');
check(!(JSON.stringify(verified.row.data.inventory_audit).includes('pin')),'audit metadata contains no PIN');
const replay=await write(1,{op});check(replay.row.data.inventory_audit.result==='not_found','old move retry returns latest verification without overwriting it');
let t=await write(transportId,{table:'transport_orders',actor:dispatch});check(t.row.status==='gati' && t.row.paid===20,'Transport order follows same audit without payment changes');
check((await one('select count(*)::int as value from bonus_trigger_calls'))===0,'audit moves and verification do not run historical payment bonus reconciliation');
await db.exec('reset role');
await db.exec("create function fixture_redirect() returns trigger language plpgsql as $$ begin if new.id=5 then new.status='dorzim'; end if; return new; end $$; create trigger fixture_redirect before update of status on orders for each row execute function fixture_redirect(); set role service_role;");
await assert.rejects(write(5),/AUDIT_STATUS_CONFLICT/);check((await row('orders',5)).status==='pastrim','conflicting existing status trigger rolls back the entire item');
await db.exec('reset role');
for (const role of ['anon','authenticated']) {
 await db.exec(`set role ${role}`);
 await assert.rejects(db.query('select * from inventory_audit_events'),/permission denied/);
 await assert.rejects(write(1),/permission denied/);
 await db.query("update orders set data=$1 where id=1",[{other:'offline edit',inventory_audit:{result:'forged'},data:{inventory_audit:{result:'forged'}}}]);
 const preserved=await row('orders',1);
 assert.equal(preserved.data.inventory_audit.result,'not_found');assert.equal(preserved.data.data.inventory_audit.result,'not_found');assert.equal(preserved.data.other,'offline edit');
 await db.query("update orders set data=$1 where id=6",[{inventory_audit:{version:1,result:'seen_in_depot'},data:{inventory_audit:{version:1}}}]);
 assert.equal((await row('orders',6)).data.inventory_audit,undefined);
 await db.exec('reset role');
}
check((await one('select count(*)::int as value from bonus_trigger_calls'))>0,'ordinary client edits retain existing payment bonus triggers');
check(true,'unprivileged clients cannot call RPC, read events, forge or erase confirmed audit; offline fields still save');

// Exercise the actual service boundary with real SQL RPCs, including partial batches.
await db.exec('set role service_role');
const sqlClient={rpc:async(name,p)=>{assert.equal(name,'inventory_audit_write_v1');try{return {data:await write(p.p_order_id,{table:p.p_table,actor:p.p_actor_id,action:p.p_action,result:p.p_result,revision:p.p_expected_updated_at,op:p.p_operation_id,note:p.p_note})}}catch(e){return {error:{message:e.message}}}}};
const authUser={id:admin,role:'ADMIN'};
const result=await inventoryAuditAction({action:'MOVE_READY',actor_id:worker,items:[6,2].map(id=>({table:'orders',id,revision,operationId:randomUUID()}))},{supabase:sqlClient,authUser});
check(result.results[0].ok && !result.results[1].ok,'mixed batch reports each outcome and ignores forged body actor');
await assert.rejects(inventoryAuditAction({action:'LIST'},{supabase:sqlClient,authUser:{id:worker,role:'PUNTOR'}}),/AUDIT_FORBIDDEN/);
check(canAuditInventory(' dispatch ')&&!canAuditInventory('TRANSPORT')&&!canAuditInventory('PUNTOR'),'UI role allowlist matches server roles');
const sample=await row('orders',6);let pages=0;
const listClient={from(table){let cursor=null;const q={select(){return q},in(){return q},order(){return q},limit(){return q},gt(_,v){cursor=v;return q},then(resolve){pages++;return Promise.resolve({data:table==='orders'?(cursor===null?Array.from({length:200},(_,i)=>({...sample,id:i+1})): [{...sample,id:201}]):[{...t.row}]}).then(resolve)}};return q}};
const list=await inventoryAuditAction({action:'LIST'},{supabase:listClient,authUser});
check(list.complete && list.items.length===202 && pages===3,'paged audit includes both sources and orders without a joined client');
const badList={from(){const q={select(){return q},in(){return q},order(){return q},limit(){return q},then(resolve){return Promise.resolve({error:{message:'down'}}).then(resolve)}};return q}};
await assert.rejects(inventoryAuditAction({action:'LIST'},{supabase:badList,authUser}),/AUDIT_LIST_FAILED/);
check(true,'list errors fail closed instead of presenting incomplete inventory');
async function request({method='POST',headers={},body={action:'LIST'},role='ADMIN'}={}) {
 const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v},end(v){this.body=JSON.parse(v)}};
 const handler=createInventoryAuditHandler({createClient:()=>listClient,authenticate:async(_,device)=>{if(device!=='approved')throw Object.assign(new Error('AUTH_REQUIRED'),{code:'AUTH_REQUIRED',httpStatus:401});return {id:admin,role}}});
 await handler({method,headers:{host:'tepiha.test',origin:'https://tepiha.test','content-type':'application/json',cookie:'tepiha_device_id=approved',...headers},body},res);return res;
}
assert.equal((await request()).statusCode,200);
assert.equal((await request({method:'GET'})).statusCode,405);
assert.equal((await request({headers:{origin:'https://evil.test'}})).statusCode,403);
assert.equal((await request({headers:{cookie:''}})).statusCode,401);
assert.equal((await request({role:'PUNTOR',body:{action:'LIST',role:'ADMIN'}})).statusCode,403);
assert.equal((await request({headers:{'content-type':'text/plain'}})).statusCode,415);
assert.match((await request()).headers['cache-control'],/no-store/);
check(true,'HTTP endpoint enforces device, server actor, origin, method, content type and private cache');
await db.close();console.log(`Inventory audit: ${checks} integration groups passed.`);
