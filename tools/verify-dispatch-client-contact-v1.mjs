import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createFamilyTestDb, seedFamilyDb, ids } from './verify-client-family-db-v1.mjs';
import { familyDbAdapter } from './fixtures/family-db-adapter.mjs';
import { familyAction } from '../lib/clientFamilyServer.js';
import { createFamilyHandler } from '../api/client-family.js';
import { cleanClientLocation, clientLocationMapUrl, orderClientLocation } from '../lib/clientLocation.js';
const db = await createFamilyTestDb(); await seedFamilyDb(db);
const orderId = '66666666-6666-4666-8666-666666666666', otherId = '77777777-7777-4777-8777-777777777777';
await db.query("insert into transport_orders(id,client_id,client_name,client_phone,status,client_tcode,code_str) values($1,$2,'Test client','045111222','gati','T123','T123'),($3,$4,'Other client','045222333','gati','T1021','T1021')", [orderId,ids.t,otherId,ids.u]);
const supabase = familyDbAdapter(db), secret='dispatch-location-isolated-test-secret', env={supabase,secret,authUser:{id:ids.staff}}, publicEnv={supabase,secret};
const baseline = JSON.stringify((await db.query("select 'transport' as kind,to_jsonb(t) as row from transport_orders t union all select 'cash',to_jsonb(p) from arka_pending_payments p union all select 'client',to_jsonb(c) from transport_clients c")).rows.sort((a,b)=>(a.kind+a.row.id).localeCompare(b.kind+b.row.id)));
let count=0; const test=async(name,fn)=>{await fn();count++;console.log('PASS',name)};
const signed=await familyAction({action:'SIGN_LINK',source:'TRANSPORT',orderId},env), token=signed.shortUrl.split('/').at(-1);
const locationBody={action:'PUBLIC_LOCATION',source:'TRANSPORT',orderId,token,requestId:randomUUID(),location:{latitude:42.66,longitude:21.16,address:'Rruga test 16'}};
await test('GPS plus address is saved once after a retry, and only the exact visit is returned',async()=>{
 await familyAction(locationBody,publicEnv);await familyAction(locationBody,publicEnv);
 assert.equal((await db.query('select count(*)::int as n from client_family_locations')).rows[0].n,1);
 assert.equal((await familyAction({action:'GET_LOCATION',source:'TRANSPORT',orderId},env)).location.address,'Rruga test 16');
 assert.equal((await familyAction({action:'GET_LOCATION',source:'TRANSPORT',orderId:otherId},env)).location,null);
});
await test('legacy order GPS appears in Dispatch without a new-table entry or a fabricated date',async()=>{
 await db.exec('begin');
 try {
  await db.query("update transport_orders set data=$1 where id=$2",[JSON.stringify({gps_lat:'42.65',gps_lng:'21.15',pay:{paid:5}}),otherId]);
  const legacy=(await familyAction({action:'GET_LOCATION',source:'TRANSPORT',orderId:otherId},env)).location;
  assert.equal(legacy.latitude,42.65);assert.equal(legacy.longitude,21.15);assert.equal(legacy.created_at,null);
  assert.equal(legacy.order_id,otherId);
  // A newer explicit customer submission takes priority over an old order GPS.
  await db.query("update transport_orders set data=$1 where id=$2",[JSON.stringify({gps_lat:40,gps_lng:20}),orderId]);
  assert.equal((await familyAction({action:'GET_LOCATION',source:'TRANSPORT',orderId},env)).location.latitude,42.66);
  for(const value of [null,'',false,{},'oops',91])assert.equal(orderClientLocation({id:otherId,data:{gps_lat:value,gps_lng:21}}),null);
  assert.equal(orderClientLocation({id:otherId,data:{gps_lat:0,gps_lng:'0'}}).latitude,0);
 } finally {await db.exec('rollback');}
});
await test('reusing a request for different data fails without replacing the original',async()=>{
 await assert.rejects(familyAction({...locationBody,location:{address:'Changed'}},publicEnv),/CONFLICT/);
 assert.equal((await db.query('select address from client_family_locations')).rows[0].address,'Rruga test 16');
});
await test('empty, malformed and out-of-range coordinates are rejected; zero is valid',async()=>{
 for(const location of [{},{latitude:91,longitude:20},{latitude:10},{latitude:'42',longitude:20},{latitude:NaN,longitude:20},{latitude:0,longitude:181},{address:'a'.repeat(301)}]) {
  await assert.rejects(familyAction({...locationBody,requestId:randomUUID(),location},publicEnv),/INVALID/);
 }
 assert.equal(cleanClientLocation({latitude:0,longitude:0}).latitude,0);
 assert.match(clientLocationMapUrl({address:'Test & Road #3'}),/query=Test%20%26%20Road%20%233/);
 assert.equal(clientLocationMapUrl(null),'');
});
await test('forged, expired, wrong-visit and wrong-module links cannot submit',async()=>{
 for(const body of [{...locationBody,token:'s_'+'A'.repeat(22)},{...locationBody,orderId:otherId},{...locationBody,source:'BASE'}]) await assert.rejects(familyAction(body,publicEnv),/INVALID/);
 await assert.rejects(familyAction(locationBody,{...publicEnv,now:Date.now()+32*86400000}),/EXPIRED/);
 await db.query('update transport_orders set client_id=$1 where id=$2',[ids.u,orderId]);
 await assert.rejects(familyAction(locationBody,publicEnv),/INVALID/);
 await db.query('update transport_orders set client_id=$1 where id=$2',[ids.t,orderId]);
});
await test('public information exposes no saved address/coordinates; direct table access is denied',async()=>{
 const info=await familyAction({...locationBody,action:'PUBLIC_INFO'},publicEnv);
 assert(!JSON.stringify(info).includes('Rruga'));assert(!('location' in info));
 for(const role of ['anon','authenticated']) {
  await db.exec('set role '+role);
  await assert.rejects(db.query('select * from client_family_locations'),/permission denied/);
  await db.exec('reset role');
 }
 await db.exec('set role service_role');
 assert.equal((await familyAction({...locationBody,action:'GET_LOCATION'},env)).location.latitude,42.66);
 await assert.rejects(db.query('delete from client_family_locations'),/permission denied/);
 await db.exec('reset role');
});
const handler=createFamilyHandler({createClient:()=>supabase,getSecret:()=>secret,authenticate:async(_db,device)=>{
 if(device!=='test-device')throw Object.assign(new Error('AUTH_REQUIRED'),{code:'AUTH_REQUIRED',httpStatus:401});return env.authUser;
}});
async function http(body,{staff=false,origin='http://test.local'}={}){let status,value;await handler({method:'POST',headers:{host:'test.local',origin,cookie:staff?'tepiha_device_id=test-device':''},body},{setHeader(){},set statusCode(s){status=s},end(s){value=JSON.parse(s)}});return {status,value};}
await test('HTTP location writes need a signed link; reads/signing need an approved device',async()=>{
 assert.equal((await http(locationBody)).status,200);
 assert.equal((await http({...locationBody,action:'GET_LOCATION'})).status,401);
 assert.equal((await http({...locationBody,action:'SIGN_LINK'})).status,401);
 assert.equal((await http(locationBody,{origin:'https://foreign.invalid'})).status,403);
 assert.equal((await http({...locationBody,token:''})).status,403);
});
const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Contact from './components/DispatchClientContact.jsx';import Public from './components/PublicFamilyPanel.jsx';const root=createRoot(document.getElementById('root'));window.show=(id='${orderId}')=>root.render(location.pathname==='/public'?<Public key={id} source="TRANSPORT" orderId={id} token="${token}"/>:<Contact key={id} orderId={id} name="Test client" phone="045111222" code="T123" messageText="Test message"/>);window.show();`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent'});
let dom, requests=[], failSign=false, loseLocationResponse=false, delaySign=null, geoAllowed=true, geoCalls=0;
const errors=[];
async function open(route='/staff'){
 dom?.window.close();const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 dom=new JSDOM('<div id="root"></div>',{url:'http://test.local'+route,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 dom.window.scrollTo=()=>{};dom.window.matchMedia=()=>({matches:false});
 Object.defineProperty(dom.window.navigator,'geolocation',{value:{getCurrentPosition(ok,fail){geoCalls++;geoAllowed?ok({coords:{latitude:42.7,longitude:21.2}}):fail({code:1})}}});
 dom.window.fetch=async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);
  if(body.action==='SIGN_LINK'&&delaySign)await delaySign;
  if(body.action==='SIGN_LINK'&&failSign)throw Error('offline');
  const result=await http(body,{staff:route!=='/public'});
  if(body.action==='PUBLIC_LOCATION'&&loseLocationResponse){loseLocationResponse=false;throw Error('lost response after commit');}
  return {ok:result.status===200,status:result.status,json:async()=>result.value};
 };
 dom.window.eval(bundle.outputFiles[0].text);await wait(()=>dom.window.document.body.textContent.length>10);
}
const text=()=>dom.window.document.body.textContent;
async function wait(fn){const end=Date.now()+5000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out: '+text());}
const btn=label=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===label);
async function click(label){await wait(()=>btn(label)&&!btn(label).disabled);btn(label).click();await new Promise(r=>setTimeout(r,20));}
function type(value){const input=dom.window.document.querySelector('[aria-label="Adresa e tepihave"]');Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
await test('Dispatch button opens Smart Message with one short link and the intended recipient',async()=>{
 await open();await click('Dërgo linkun: familjarë dhe lokacion');await wait(()=>text().includes(signed.shortUrl));
 assert(text().includes('familjarëve'));assert(text().includes('lokacionin'));assert(text().includes('SMS KONFIRMIMI'));
 assert.equal(requests.filter(r=>r.action==='SIGN_LINK').length,1);
});
await test('failed link preparation gives retry and does not open an unsigned message',async()=>{
 failSign=true;await open();await click('Dërgo linkun: familjarë dhe lokacion');await wait(()=>text().includes('Linku nuk u përgatit'));
 assert(!text().includes('SMS KONFIRMIMI'));failSign=false;await click('Dërgo linkun: familjarë dhe lokacion');await wait(()=>text().includes(signed.shortUrl));
});
await test('changing the selected client discards a late link from the previous client',async()=>{
 let release;delaySign=new Promise(r=>{release=r});await open();await click('Dërgo linkun: familjarë dhe lokacion');
 dom.window.show(otherId);await new Promise(r=>setTimeout(r,30));release();delaySign=null;await new Promise(r=>setTimeout(r,80));assert(!text().includes('SMS KONFIRMIMI'));assert(!text().includes(signed.shortUrl));
});
await test('customer selects GPS explicitly, previews it and saves to the exact visit',async()=>{
 const before=geoCalls;await open('/public');await wait(()=>text().includes('Përdor lokacionin tim'));assert.equal(geoCalls,before);
 await click('Përdor lokacionin tim');await wait(()=>text().includes('Kontrolloje në hartë'));type('Test hyrja 2');await new Promise(r=>setTimeout(r,20));
 await click('Dërgo lokacionin / adresën');await wait(()=>text().includes('iu dërgua kompanisë'));
 const saved=(await familyAction({...locationBody,action:'GET_LOCATION'},env)).location;assert.equal(saved.latitude,42.7);assert.equal(saved.address,'Test hyrja 2');
});
await test('GPS denial permits a typed address and a lost response retries the identical request',async()=>{
 geoAllowed=false;await open('/public');await wait(()=>text().includes('Përdor lokacionin tim'));await click('Përdor lokacionin tim');await wait(()=>text().includes('Lejo qasjen'));
 type('Test rruga pa GPS');await new Promise(r=>setTimeout(r,20));loseLocationResponse=true;
 await click('Dërgo lokacionin / adresën');await wait(()=>text().includes('Dërgimi nuk u konfirmua'));assert(dom.window.document.querySelector('input[aria-label="Adresa e tepihave"]').disabled);
 await click('Riprovo dërgimin');await wait(()=>text().includes('iu dërgua kompanisë'));
 const writes=requests.filter(r=>r.action==='PUBLIC_LOCATION');assert.equal(writes.at(-1).requestId,writes.at(-2).requestId);
 assert.equal((await db.query("select count(*)::int as n from client_family_locations where address='Test rruga pa GPS'")).rows[0].n,1);
});
await test('Dispatch refresh reads persisted address and opens a safe map link',async()=>{
 await open();await wait(()=>text().includes('Test rruga pa GPS'));
 const link=[...dom.window.document.querySelectorAll('a')].find(a=>a.textContent==='Hap lokacionin në hartë');assert.equal(new URL(link.href).hostname,'www.google.com');assert.equal(new URL(link.href).searchParams.get('query'),'Test rruga pa GPS');
 await click('Rifresko');await wait(()=>text().includes('Test rruga pa GPS'));
});
await test('returning to Dispatch refreshes the location without closing the selected client',async()=>{
 await open();await wait(()=>text().includes('Test rruga pa GPS'));
 await familyAction({...locationBody,requestId:randomUUID(),location:{address:'New address while tab was away'}},publicEnv);
 dom.window.dispatchEvent(new dom.window.Event('focus'));
 await wait(()=>text().includes('New address while tab was away'));
 // Visibility resume also reads fresh state; selecting another visit clears it.
 const reads=requests.filter(r=>r.action==='GET_LOCATION').length;
 dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
 await wait(()=>requests.filter(r=>r.action==='GET_LOCATION').length>reads);
 dom.window.show(otherId);await wait(()=>text().includes('Ende pa lokacion.'));
 assert(!text().includes('New address while tab was away'));
});
await test('client names, existing addresses, order statuses and financial records stay unchanged',async()=>{
 const after=JSON.stringify((await db.query("select 'transport' as kind,to_jsonb(t) as row from transport_orders t union all select 'cash',to_jsonb(p) from arka_pending_payments p union all select 'client',to_jsonb(c) from transport_clients c")).rows.sort((a,b)=>(a.kind+a.row.id).localeCompare(b.kind+b.row.id)));
 assert.equal(after,baseline);assert.deepEqual(errors,[]);
});
console.log(`PASS ${count} Dispatch link/location scenarios (React DOM, API and SQL)`);dom?.window.close();await db.close();
