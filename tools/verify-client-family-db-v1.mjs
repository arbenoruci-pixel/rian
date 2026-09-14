import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { normalizeTransportPhoneKey } from '../lib/transport/phone.js';
import { PGlite } from '@electric-sql/pglite';
export async function createFamilyTestDb() {
 const db = new PGlite();
 await db.exec(fs.readFileSync('tools/fixtures/family-schema.sql','utf8'));
 await db.exec(fs.readFileSync('tools/fixtures/family-transport-create-before.sql','utf8'));
 await db.exec(fs.readFileSync('tools/fixtures/family-base-identity-before.sql','utf8'));
 await db.exec(fs.readFileSync('tools/fixtures/family-base-upsert-before.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/20260913233058_client_family_links_v1.sql','utf8'));
 await db.exec('create trigger trg_upsert_client_from_order before insert or update on orders for each row execute function upsert_client_from_order(); create trigger trg_v_prevent_code_reuse_different_client before insert or update on orders for each row execute function prevent_code_reuse_different_client();');
 return db;
}
export const ids = { a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222',t:'33333333-3333-4333-8333-333333333333',u:'44444444-4444-4444-8444-444444444444',x:'55555555-5555-4555-8555-555555555555',staff:'99999999-9999-4999-8999-999999999999' };
export async function seedFamilyDb(db) {
 await db.query("insert into users(id,name,role) values($1,'Test staff','admin')",[ids.staff]);
 for(const [id,code,name,phone] of [[ids.a,'123','Agron','+38344111222'],[ids.b,'1021','Besnik','+38344222333'],[ids.x,'777','Other','+38344999888']]) await db.query('insert into clients(id,code,full_name,name,phone) values($1,$2,$3,$3,$4)',[id,code,name,phone]);
 for(const [id,code,name,phone] of [[ids.t,'T123','Agron transport','+38345111222'],[ids.u,'T1021','Besnik transport','+38345222333']]) await db.query('insert into transport_clients(id,tcode,name,phone) values($1,$2,$3,$4)',[id,code,name,phone]);
 await db.query("insert into orders(id,client_id,code,client_name,client_phone,status,total,price_total,paid,paid_cash,pieces) values(10,$1,123,'Agron','+38344111222','pastrim',50,50,20,20,3),(11,$2,1021,'Besnik','+38344222333','gati',80,80,0,0,4)",[ids.a,ids.b]);
 await db.query("insert into arka_pending_payments(id,order_id,amount,type,status) values($1,10,20,'CASH','PENDING')",[randomUUID()]);
}
if (process.argv[1]?.endsWith('verify-client-family-db-v1.mjs')) {
const db=await createFamilyTestDb(); await seedFamilyDb(db);
const key=(source,id)=>`${source}:${id}`; const a=key('BASE',ids.a),b=key('BASE',ids.b),t=key('TRANSPORT',ids.t),u=key('TRANSPORT',ids.u);
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
const snap=k=>one('select client_family_snapshot_v1($1) as value',[k]);
const raw=p=>one('select client_family_mutate_v1($1::jsonb,$2,null) as value',[JSON.stringify(p),ids.staff]);
async function change(k,action,fields={}) { const s=await snap(k); return raw({key:k,action,requestId:randomUUID(),expectedRoot:s.rootKey,expectedRevision:s.revision,...fields}); }
async function merge(k,o) { const s=await snap(o); return change(k,'MERGE',{otherKey:o,otherRoot:s.rootKey,otherRevision:s.revision}); }
let count=0; const check=(v,label)=>{assert.ok(v,label);console.log('PASS',label);count++};
for (const country of ['383','389','355','49','43','41']) {
 for (const phone of [`+${country} 044 123 456`, `00${country}044123456`, `${country}44123456`]) assert.equal(await one('select client_family_phone_key_v1($1) as value',[phone]),normalizeTransportPhoneKey(phone));
}
check(true,'18 international phone formats match browser normalization');
const baseline=JSON.stringify((await db.query('select id,code,client_id,total,paid,status from orders order by id')).rows);
let f=await merge(a,b);check(f.members.length===2,'merge Base codes with different names and phones');
for(const q of ['123','1021','044111222','+38344222333','Besnik']) {
 const result=await one("select client_family_search_v1($1,'BASE') as value",[q]);check(result.length===1&&result[0].family.members.length===2,`search ${q} finds one family`);
}
await merge(t,u); f=await merge(a,t);check(f.members.length===4,'link two Transport codes and join Base/Transport families');
f=await change(b,'ADD_CONTACTS',{contacts:[{name:'Blerta',phone:'044555666'},{name:'Driton',phone:'+49 151 23456789'}]});check(f.contacts.length===2,'add two family contacts anchored to the original member');
f=await change(a,'ADD_CONTACTS',{contacts:[{name:'Same phone',phone:'00383 044 555 666'}]});check(f.contacts.length===2,'normalized duplicate phone is idempotent across family members');
for(const source of ['BASE','TRANSPORT']) check(await one('select client_family_phone_owner_v1($1,$2) as value',[source,'+38344555666'])===(source==='BASE'?ids.a:ids.t),`added phone resolves existing ${source} master`);
await assert.rejects(change(a,'ADD_CONTACTS',{contacts:[{name:'Other',phone:'044999888'}]}),/FAMILY_PHONE_CONFLICT/);check((await snap(a)).contacts.length===2,'unrelated master phone conflict rolls back');
await assert.rejects(change(a,'ADD_CONTACTS',{contacts:[{name:'Valid',phone:'044666777'},{name:'',phone:'123'}]}),/FAMILY_CONTACT_INVALID/);check((await snap(a)).contacts.length===2,'invalid member rolls back entire contact batch');
const st=await snap(a);const payload={key:a,action:'ADD_CONTACTS',requestId:randomUUID(),expectedRoot:st.rootKey,expectedRevision:st.revision,contacts:[{name:'Retry',phone:'045888777'}]};
const first=await raw(payload);const again=await raw(payload);check(JSON.stringify(first)===JSON.stringify(again),'lost response retry returns one committed operation');
await assert.rejects(raw({...payload,contacts:[{name:'Changed',phone:'045888776'}]}),/FAMILY_REQUEST_CONFLICT/);count++;
await assert.rejects(raw({...payload,requestId:randomUUID()}),/FAMILY_STALE/);count++;
await assert.rejects(merge(b,a),/FAMILY_ALREADY_LINKED/);count++;
const paymentBefore=JSON.stringify((await db.query('select * from arka_pending_payments')).rows);
f=await change(a,'UNLINK',{otherKey:b});check(f.members.length===3&&f.contacts.length===1,'unlink restores original member and its own contacts');
check((await snap(b)).contacts.length===2,'unlinked family retains contacts entered through its member');
check(JSON.stringify((await db.query('select id,code,client_id,total,paid,status from orders order by id')).rows)===baseline,'merge and unlink leave all orders, statuses and amounts byte-identical');
check(JSON.stringify((await db.query('select * from arka_pending_payments')).rows)===paymentBefore,'payments are unchanged');
const publicRequest={key:b,action:'ADD_CONTACTS',requestId:randomUUID(),contacts:[{name:'Customer addition',phone:'044111555'}]};
await one('select client_family_mutate_v1($1::jsonb,null,$2) as value',[JSON.stringify(publicRequest),b]);check((await snap(b)).contacts.length===3,'verified customer path can append contacts');
await assert.rejects(one('select client_family_mutate_v1($1::jsonb,null,$2) as value',[JSON.stringify({...publicRequest,action:'MERGE',requestId:randomUUID()}),b]),/FAMILY_FORBIDDEN/);count++;
await db.exec('set role anon');
for(const sql of ["select * from client_family_contacts","select client_family_snapshot_v1('"+a+"')","select client_family_mutate_v1('{}',null,null)"]) {await assert.rejects(db.query(sql),/permission denied/);count++;}
await db.exec('reset role');
const beforeClients=await one('select count(*)::int as value from transport_clients');
await db.exec("set role service_role; select set_config('request.jwt.claim.role','service_role',false)");
const orderId=randomUUID(), fingerprint='a'.repeat(64);
const args=[orderId,null,null,'Today contact','045888777','',null,null,JSON.stringify({transport_tcode_allocation_mode:'ATOMIC_DB',transport_create_fingerprint_v1:fingerprint}),'pickup'];
const create=()=>one('select create_transport_order($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) as value',args);
const created=await create();check(created.client_id===ids.t&&created.client_tcode==='T123'&&!created.allocated_in_transaction,'real atomic create reuses family Transport code');
check((await create()).idempotent===true,'family Transport create retains UUID retry semantics');
check(await one('select count(*)::int as value from transport_clients')===beforeClients,'family contact does not create a duplicate Transport client');
check(await one('select client_phone as value from transport_orders where id=$1',[orderId])==='045888777','order retains today’s contact phone');
check(await one('select name as value from transport_clients where id=$1',[ids.t])==='Agron transport','family order preserves master name');
await db.exec('reset role');
// Base-only family gains its first Transport master, with no unrelated automatic merge.
const crossId=randomUUID();
await db.query("insert into transport_clients(id,tcode,name,phone) values($1,'T555','Blerta first transport','044555666')",[crossId]);
check((await snap(b)).members.some(m=>m.clientId===crossId),'first master in other module joins explicitly registered family');
await assert.rejects(db.query("insert into clients(code,name,phone) values('8888','Duplicate contact','044555666')"),/FAMILY_PHONE_ALREADY_LINKED/);count++;
check(!(await db.query("select id from clients where code='8888'")).rows.length,'old/offline admission cannot create a duplicate family master');
const sameNameId=randomUUID();await db.query("insert into clients(id,code,name,phone) values($1,'9999','Besnik','049999333')",[sameNameId]);
check((await snap(key('BASE',sameNameId))).members.length===1,'same name with unrelated phone remains separate');
const beforeParallel=await snap(b);const parallelPayload={key:b,action:'ADD_CONTACTS',expectedRoot:beforeParallel.rootKey,expectedRevision:beforeParallel.revision};
const parallel=await Promise.allSettled([raw({...parallelPayload,requestId:randomUUID(),contacts:[{name:'One',phone:'044700001'}]}),raw({...parallelPayload,requestId:randomUUID(),contacts:[{name:'Two',phone:'044700002'}]})]);
check(parallel.filter(p=>p.status==='fulfilled').length===1&&parallel.some(p=>p.reason?.message==='FAMILY_STALE'),'simultaneous staff edits reject stale snapshot');
await assert.rejects(change(b,'ADD_CONTACTS',{contacts:[{name:123,phone:'044999222'}]}),/FAMILY_CONTACT_INVALID/);count++;
const nonstaff=randomUUID();await db.query("insert into users(id,role) values($1,'UNKNOWN')",[nonstaff]);
await assert.rejects(one('select client_family_mutate_v1($1::jsonb,$2,null) as value',[JSON.stringify({...parallelPayload,requestId:randomUUID()}),nonstaff]),/FAMILY_FORBIDDEN/);count++;
await db.exec('grant insert on clients to anon; set role anon');
await db.query("insert into clients(code,name,phone) values('10000','Unrelated browser client','049333222')");
await assert.rejects(db.query("insert into clients(code,name,phone) values('10001','Duplicate browser client','044555666')"),/FAMILY_PHONE_ALREADY_LINKED/);
await db.exec('reset role');
check(true,'browser-role master insert keeps legacy admission and enforces family integrity');
await db.query("insert into orders(id,client_id,client_code,code,client_name,client_phone,status,data) values(100,$1,1021,1021,'Blerta today','044555666','pranim','{\"order\":{},\"pieces\":2}')",[ids.b]);
let baseVisit=(await db.query('select * from orders where id=100')).rows[0];
check(baseVisit.client_id===ids.b&&baseVisit.code===1021&&baseVisit.client_phone==='044555666'&&baseVisit.client_name==='Blerta today','real Base trigger accepts family contact and preserves selected code and visit person');
check(baseVisit.data.order.client.phone==='044555666'&&baseVisit.data.client.phone==='044555666','Base trigger keeps exact contact in nested order and client payloads');
await db.query("update orders set status='pastrim' where id=100");
baseVisit=(await db.query('select * from orders where id=100')).rows[0];
check(baseVisit.client_phone==='044555666'&&baseVisit.client_name==='Blerta today','later Base status update retains family visit contact');
check(await one('select phone as value from clients where id=$1',[ids.b])==='+38344222333','Base family admission leaves permanent master phone unchanged');
await assert.rejects(db.query("insert into orders(id,client_id,code,client_name,client_phone,status) values(101,$1,777,'Wrong family','044555666','pranim')",[ids.x]),/FAMILY_SELECTED_CLIENT_CONFLICT/);count++;
await db.query("insert into orders(id,code,client_name,client_phone,status) values(102,1021,'Old device family','044555666','pranim')");
check(await one('select client_id as value from orders where id=102')===ids.b,'legacy Base admission resolves registered family without creating another master');
await merge(a,b);
await db.query("insert into orders(id,client_id,code,client_name,client_phone,status) values(103,$1,1021,'Alias visit','044555666','pranim')",[ids.b]);
check(await one('select code as value from orders where id=103')===1021,'selected secondary Base code survives merged-family trigger resolution');
await db.query("insert into orders(id,client_id,code,client_name,client_phone,status) values(105,$1,123,'Family prior visit','044555666','pranim')",[ids.a]);
await change(a,'UNLINK',{otherKey:b});
await db.query("update orders set status='gati' where id=105");
check(await one('select client_id as value from orders where id=105')===ids.a,'unlink does not block status updates on visits already saved under another family code');
const ownedContact=(await snap(b)).contacts.find(c=>c.phone==='044555666');
await change(b,'REMOVE_CONTACT',{contactId:ownedContact.id});
await db.query("update orders set paid=15 where id=100");
check(await one('select paid as value from orders where id=100')==='15'||Number(await one('select paid as value from orders where id=100'))===15,'contact removal does not block later payments on saved visits');
await db.query("insert into orders(id,client_id,code,client_name,client_phone,status) values(104,$1,777,'Other','044999888','pranim')",[ids.x]);
check(await one('select client_id as value from orders where id=104')===ids.x,'unrelated Base order continues through original identity trigger');
console.log(`PASS ${count} family database scenarios`);await db.close();
}
