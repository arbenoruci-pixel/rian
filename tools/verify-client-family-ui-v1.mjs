// DOM interaction tests use real React components, API handler and SQL migration.
// These do not claim browser rendering, mobile Safari or native SMS verification.
import assert from 'node:assert/strict';
import {JSDOM,VirtualConsole} from 'jsdom';
import {build} from 'esbuild';
import path from 'node:path';
import {createFamilyTestDb,seedFamilyDb,ids} from './verify-client-family-db-v1.mjs';
import {familyDbAdapter} from './fixtures/family-db-adapter.mjs';
import {createFamilyHandler} from '../api/client-family.js';
import {buildClientProfile} from '../lib/clientProfileServer.js';
const db=await createFamilyTestDb();await seedFamilyDb(db);const supabase=familyDbAdapter(db),authUser={id:ids.staff};
await db.query("insert into transport_orders(id,client_id,client_tcode,code_str,client_name,client_phone,status,data) values('66666666-6666-4666-8666-666666666666',$1,'T123','T123','Agron transport','045111222','pastrim','{}')",[ids.t]);
const handler=createFamilyHandler({createClient:()=>supabase,authenticate:async()=>authUser,getSecret:()=> 'isolated-ui-test-family-secret-value'});
const bundle=await build({entryPoints:['tools/fixtures/family-browser.jsx'],bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},alias:{'@/lib/ordersService':path.resolve('tools/fixtures/family-browser-orders.js'),'@':process.cwd()},loader:{'.css':'empty'},logLevel:'silent'});
let dom, token, scenarios=0;const errors=[];
async function open(url='/') {
 dom?.window.close();const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 dom=new JSDOM('<div id="root"></div>',{url:'http://test.local'+url,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 dom.window.scrollTo=()=>{};dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 dom.window.fetch=async(input,opts={})=>{
  const url=new URL(input,'http://test.local');const body=JSON.parse(opts.body||'{}');let status=200,value;
  if(url.pathname==='/api/client-family') {
   await handler({method:'POST',headers:{host:'test.local',origin:'http://test.local'},body},{setHeader(){},set statusCode(v){status=v},end(v){value=JSON.parse(v)}});
   if(body.action==='SIGN_LINK')token=value.token;
  }else if(url.pathname==='/test-order') value=(await supabase.from(url.searchParams.get('source')==='base'?'orders':'transport_orders').select('*').eq('id',url.searchParams.get('id')).maybeSingle()).data;
  else if(url.pathname==='/api/client-profile')value={ok:true,...await buildClientProfile(body,{supabase,authUser})};
  else value={ok:true,items:[],feedback:[]};
  return {ok:status>=200&&status<300,status,json:async()=>value,text:async()=>JSON.stringify(value)};
 };
 dom.window.eval(bundle.outputFiles[0].text);
 await wait(()=>dom.window.document.body.textContent.trim().length>0);
}
const text=()=>dom.window.document.body.textContent;
async function wait(fn,label='condition'){const end=Date.now()+6000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,15));}throw Error('Timed out: '+label+'; '+text().slice(-1000));}
const buttons=()=>[...dom.window.document.querySelectorAll('button')];
async function click(label){await wait(()=>buttons().some(b=>b.textContent.trim()===label&&!b.disabled),label);buttons().find(b=>b.textContent.trim()===label&&!b.disabled).click();await new Promise(r=>setTimeout(r,20));}
async function type(label,value){const input=dom.window.document.querySelector(`[aria-label="${label}"]`);assert.ok(input,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,20));}
function pass(label){scenarios++;console.log('PASS',label)}
await open();await wait(()=>text().includes('BAZË 123'),'initial family');
await click('Lidh / Merge kodin');await type('Kërko kodin, emrin ose telefonin','1021');await click('Kërko kartelën');await wait(()=>buttons().some(b=>b.textContent.includes('BAZË 1021')),'merge result');buttons().find(b=>b.textContent.includes('BAZË 1021')).click();await click('Konfirmo');await wait(()=>text().includes('Shkëput 1021'));pass('staff merges both Base codes from the actual form');
await click('＋ Shto familjar / telefon');await type('Emri i familjarit 1','Blerta');await type('Telefoni 1','044999888');await click('Ruaj familjarët');await wait(()=>text().includes('kartelë tjetër'));assert.equal(dom.window.document.querySelector('[aria-label="Emri i familjarit 1"]').value,'Blerta');pass('phone conflict keeps the form input for correction');
await type('Telefoni 1','044555666');await click('Ruaj familjarët');await wait(()=>text().includes('Blerta · 044555666'));pass('corrected family contact persists through API and SQL');
await open();await wait(()=>text().includes('Blerta · 044555666'));pass('contact and both codes survive a fresh page load');
await click('Smart Mesazh test');await wait(()=>token&&text().includes('Në këtë link mund'));assert.ok(text().includes('/k/10?src=base&family='));pass('Smart Message receives signed token on the existing exact-order link');
const baseToken=token;await open('/k/10?src=base&family='+baseToken);await wait(()=>text().includes('Kodet tuaja:'));assert.ok(text().includes('Bazë 123 · Bazë 1021'));assert.ok(!text().includes('044555666'));pass('real tracking page renders existing order and family codes without phone disclosure');
await click('＋ Shto familjarët');await type('Emri i familjarit 1','Arta');await type('Telefoni 1','049888555');await click('Ruaj familjarët');await wait(()=>text().includes('Familjarët u ruajtën'));pass('customer saves a family member from the tracking page');
await open('/k/10?src=base&family='+baseToken.slice(0,-2)+'xx');await wait(()=>text().includes('Ky link nuk vlen'));assert.ok(text().includes('Agron'));pass('invalid family token leaves order tracking usable');
await open('/k/10?src=base');await wait(()=>text().includes('Agron'));assert.ok(!text().includes('Shto familjarët'));pass('old tracking links remain compatible');
await open('/test-transport');await wait(()=>text().includes('TRANSPORT T123'));await click('Lidh / Merge kodin');await type('Kërko kodin, emrin ose telefonin','T1021');await click('Kërko kartelën');await wait(()=>buttons().some(b=>b.textContent.includes('TRANSPORT T1021')));buttons().find(b=>b.textContent.includes('TRANSPORT T1021')).click();await click('Konfirmo');await wait(()=>text().includes('Shkëput T1021'));pass('Transport uses the same merge controls');
token=null;await click('Smart Mesazh test');await wait(()=>token&&text().includes('Në këtë link mund'));await open('/k/66666666-6666-4666-8666-666666666666?src=transport&family='+token);await wait(()=>text().includes('Transport T123 · Transport T1021'));pass('Transport Smart Message opens the exact visit family form');
await open();await wait(()=>text().includes('Shkëput 1021'));await click('Shkëput 1021');await click('Konfirmo');await wait(()=>!text().includes('Shkëput 1021'));pass('staff can undo a mistaken Base merge from the form');
assert.deepEqual(errors,[],'no uncaught React or DOM errors');
console.log(`PASS ${scenarios} React/API/SQL interaction scenarios (DOM, not visual browser QA)`);dom.window.close();await db.close();
