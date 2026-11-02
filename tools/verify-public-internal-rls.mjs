import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { authenticateBaseCodeStatusActor, readBaseCodeStatuses } from '../lib/baseCodeStatusServer.js';
import { createBaseCodeStatusHandler } from '../api/base-code-status.js';

const tables = ['transport_keep_one','app_meta','transport_client_debts','app_runtime_switches','system_counters','tepiha_counters','base_code_pool'];
const db = new PGlite();
let checks = 0;
const check = label => { checks++; console.log('PASS', label); };
await db.exec('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;');
for (const table of tables) {
  await db.exec(table === 'app_meta'
    ? "create table app_meta(key text primary key,value text,db_epoch bigint); insert into app_meta values ('global','private-value',42),('internal','secret',99);"
    : `create table ${table}(id integer primary key,private_value text); insert into ${table} values(1,'fixture-only');`);
}
await db.exec('grant all on all tables in schema public to anon,authenticated,service_role; grant select(private_value) on transport_keep_one to anon;');
const snapshot = async () => JSON.stringify(await Promise.all(tables.map(t => db.query(`select * from ${t}`))));
const before = await snapshot();
await db.exec(fs.readFileSync('supabase/migrations/20261102050536_restrict_public_internal_tables.sql', 'utf8'));
assert.equal((await db.query("select relrowsecurity from pg_class where oid='base_code_pool'::regclass")).rows[0].relrowsecurity, false);
await db.exec(fs.readFileSync('supabase/migrations/20261102051029_restrict_base_code_pool_after_reader.sql', 'utf8'));
assert.equal(await snapshot(), before);
check('migration leaves every fixture row unchanged');
assert.equal((await db.query("select count(*)::int as n from pg_class where relname=any($1) and relrowsecurity",[tables])).rows[0].n, 7);
check('RLS is enabled on all seven tables');
for (const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  for (const table of tables.filter(t=>t!=='app_meta')) {
    for (const sql of [`select * from ${table}`,`insert into ${table} values(2,'forged')`,`update ${table} set private_value='forged'`,`delete from ${table}`,`truncate ${table}`]) {
      await assert.rejects(db.query(sql), /permission denied/);
    }
  }
  assert.deepEqual((await db.query('select key,db_epoch from app_meta')).rows, [{ key:'global', db_epoch:42 }]);
  for (const sql of ["select * from app_meta", "select value from app_meta", "update app_meta set db_epoch=999", "insert into app_meta values('fake','fake',1)", 'delete from app_meta','truncate app_meta']) await assert.rejects(db.query(sql), /permission denied/);
  await db.exec('reset role');
  check(`${role}: direct reads/writes/truncate denied; only global epoch columns readable`);
}
await db.exec('set role service_role');
for (const table of tables) {
  assert((await db.query(`select * from ${table}`)).rows.length);
  for (const operation of ['SELECT','INSERT','UPDATE','DELETE']) assert((await db.query('select has_table_privilege(current_user,$1,$2) as ok',[table,operation])).rows[0].ok);
}
await db.exec('reset role');
assert.equal(await snapshot(),before);
check('existing service_role access survives; authorization probes did not mutate data');
await db.exec(fs.readFileSync('supabase/sql/verify_public_internal_rls_readonly.sql','utf8'));
check('production read-only authorization verifier passes against local fixtures');
await db.close();

function client({ role='PUNTOR', active=true, approved=true, missing=false, error=false }={}) {
  const calls=[];
  return { calls, from(table) {
    calls.push(table);
    const q={ select(fields){this.fields=fields; return this},eq(){return this},in(_,codes){this.codes=codes;return this},limit(){return this},
      async maybeSingle(){return error?{error:{message:'do not leak'}}:{data:table==='tepiha_user_devices'?(missing?null:{user_id:'actor-1',is_approved:approved}):{id:'actor-1',role,is_active:active}}},
      then(resolve,reject){assert.equal(table,'base_code_pool');assert.equal(this.fields,'code,status,lease_expires_at');return Promise.resolve({data:[{code:this.codes[0],status:'reserved',lease_expires_at:null,reserved_by:'secret-pin',client_phone:'secret-phone'}]}).then(resolve,reject)} };
    return q;
  }};
}
for (const role of ['PUNTOR','DISPATCH','ADMIN']) {
  const sb=client({role}), actor=await authenticateBaseCodeStatusActor(sb,'fixture-device');
  const result=await readBaseCodeStatuses({codes:[123],expectedActorId:'actor-1'},{supabase:sb,actor});
  assert.deepEqual(result,{rows:[{code:'123',status:'reserved',lease_expires_at:null}]});
  await assert.rejects(readBaseCodeStatuses({codes:[123],expectedActorId:'other'},{supabase:sb,actor}),/SESSION_CHANGED/);
  for(const codes of [["123) or true"],[-1],new Array(161).fill(123)]) await assert.rejects(readBaseCodeStatuses({codes,expectedActorId:'actor-1'},{supabase:sb,actor}),/CODES_INVALID/);
  check(`${role}: approved active device can read code status; identity mismatch and malformed input denied`);
}
for(const options of [{role:'TRANSPORT'},{role:'UNKNOWN'},{active:false},{active:null},{approved:false},{missing:true},{error:true}]) {
  const sb=client(options);
  await assert.rejects(authenticateBaseCodeStatusActor(sb,'fixture-device'));
  assert(!sb.calls.includes('base_code_pool'));
}
check('Transport has no base-code access; disabled, unapproved and unknown actors fail closed');
const res=()=>({headers:{},setHeader(k,v){this.headers[k]=v},end(v){this.body=JSON.parse(v)}});
const request={method:'POST',headers:{host:'tepiha.test',origin:'https://tepiha.test','content-type':'application/json',cookie:'tepiha_device_id=fixture-device'},body:{codes:[123],expectedActorId:'actor-1'}};
let created=0;
const handler=createBaseCodeStatusHandler({createClient:()=>{created++;return client()}});
for(const bad of [{...request,method:'GET'},{...request,headers:{...request.headers,origin:'https://evil.test'}},{...request,headers:{...request.headers,cookie:''}},{...request,headers:{...request.headers,'content-type':'text/plain'}}]) {
  const response=res();await handler(bad,response);assert(response.statusCode>=400);
}
assert.equal(created,0);
const response=res();await handler(request,response);assert.equal(response.statusCode,200);assert.equal(response.body.rows.length,1);assert.equal(response.headers['cache-control'],'private, no-store, max-age=0');
check('API enforces same-origin JSON/session boundary and prevents shared caching');
console.log(`${checks} security groups passed; only synthetic local fixtures used.`);
