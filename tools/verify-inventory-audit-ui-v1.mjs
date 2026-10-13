// UI interactions use the real component and a deterministic API fixture.
// Database authorization and mutations are covered by verify-inventory-audit-v1.
import assert from 'node:assert/strict';
import './verify-inventory-audit-search-v2.mjs';
import { matchesInventoryAuditSearch, normalizeInventoryAuditCode } from '../lib/inventoryAuditSearch.js';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'esbuild';
const bundle=await build({entryPoints:['tools/fixtures/inventory-audit-browser.jsx'],bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},alias:{'@':process.cwd()},loader:{'.css':'empty'},logLevel:'silent'});
let dom,requests=[],fail=false,partial=false;const problems=[];
const base={revision:'2026-01-01T00:00:00Z',table:'orders',name:'Klienti Test',phone:'044000000',location:'A12',pieces:3,m2:12,total:30,stage:'processing',overdue:true,ageDays:6,result:'unverified',note:''};
let items=[{...base,key:'orders:1',id:'1',code:'123'},{...base,key:'orders:2',id:'2',code:'124'},{...base,key:'orders:3',id:'3',code:'125',overdue:false,ageDays:1}];
async function open(role='ADMIN',stage='processing',code='') {
 dom?.window.close();const vc=new VirtualConsole();vc.on('jsdomError',e=>problems.push(e.message));
 dom=new JSDOM('<div id="root"></div>',{url:'http://test.local/auditimi?stage='+stage+(code?'&code='+encodeURIComponent(code):''),runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 dom.window.localStorage.setItem('CURRENT_USER_DATA',JSON.stringify({id:'test-actor',name:'Test Admin',role,pin:'887766'}));
 dom.window.fetch=async(url,opts)=>{
  assert.equal(url,'/api/inventory-audit');const body=JSON.parse(opts.body);requests.push(body);
  if(fail)throw Error('offline');
  const result=body.action==='LIST'?{items,complete:true}:{results:body.items.map((req,i)=>{
   if(partial&&i===1)return {key:`${req.table}:${req.id}`,ok:false,error:'AUDIT_STALE'};
   const ix=items.findIndex(r=>r.id===req.id&&r.table===req.table);
   assert(ix>=0);
   if(body.action==='VERIFY') assert.equal(items[ix].stage,'ready','VERIFY must use the result row stage, never the active tab');
   if(body.action==='MOVE_READY') { assert.equal(items[ix].stage,'processing'); assert.equal(items[ix].overdue,true); }
   items[ix]={...items[ix],stage:'ready',status:'gati',overdue:false,revision:new Date().toISOString(),result:body.result,checkedBy:'Test Admin',checkedAt:new Date().toISOString(),note:body.note||''};
   return {key:items[ix].key,ok:true,item:items[ix]};
  })};
  return {ok:true,status:200,json:async()=>({ok:true,...result})};
 };
 dom.window.eval(bundle.outputFiles[0].text);await wait(()=>dom.window.document.body.textContent.length>10);
}
const doc=()=>dom.window.document;
const text=()=>doc().body.textContent;
const buttons=()=>[...doc().querySelectorAll('button')];
async function wait(fn){const end=Date.now()+5000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out: '+text().slice(-1200));}
async function click(label){await wait(()=>buttons().some(b=>b.textContent.trim()===label&&!b.disabled));buttons().find(b=>b.textContent.trim()===label&&!b.disabled).click();await new Promise(r=>setTimeout(r,10));}
await open();await wait(()=>doc().querySelectorAll('.ia-order').length===2);
assert(![...doc().querySelectorAll('.ia-code')].some(e=>e.textContent==='125'));
doc().querySelector('.ia-select-all input').click();await click('Kalo 2 në Gati');assert(doc().querySelector('[role=dialog]'));await click('Anulo');assert.equal(requests.filter(r=>r.action==='MOVE_READY').length,0);
partial=true;await click('Kalo 2 në Gati');await click('Po, kaloji në Gati');await wait(()=>text().includes('1 kërkojnë rishikim'));
assert.equal(doc().querySelectorAll('.ia-order').length,1);assert(text().includes('Porosia ndryshoi'));
assert.equal(requests.find(r=>r.action==='MOVE_READY').items.length,2);
assert(requests.find(r=>r.action==='MOVE_READY').items.every(r=>r.operationId&&r.revision));
console.log('PASS overdue-only bulk selection, explicit confirmation, cancellation and partial failure remain visible');
await click('Vazhdo te kontrolli fizik →');await wait(()=>doc().querySelectorAll('.ia-order').length===1);
await click('✕ Nuk u gjet');await wait(()=>!doc().querySelector('.ia-order'));
await click('Nuk u gjet 1');await wait(()=>doc().querySelector('.ia-order'));assert(text().includes('Test Admin'));
assert.equal(items[0].status,'gati');
await open('DISPATCH','ready');await click('Nuk u gjet 1');await wait(()=>doc().querySelector('.ia-order'));
await click('Rikontrollo');await click('Pa kontrolluar 1');await click('✓ U gjet');await click('U gjet 1');assert(text().includes('123'));
console.log('PASS missing persists across reload; Dispatch can recheck and mark physically found');
Object.defineProperty(dom.window.navigator,'onLine',{configurable:true,value:false});dom.window.dispatchEvent(new dom.window.Event('offline'));await wait(()=>text().includes('Pa internet'));
assert(buttons().filter(b=>/U gjet|Nuk u gjet|Rikontrollo/.test(b.textContent)&&b.closest('.ia-actions')).every(b=>b.disabled));
console.log('PASS offline physical actions are disabled without claiming a save');
// Reproduce the physical-inventory incident: 74 must never find code 71 by
// phone/rack, 174/740 by substring, or T74 from the other source.
const readyRow=(id,code,extra={})=>({...base,key:'orders:'+id,id:String(id),code,status:'gati',stage:'ready',overdue:false,createdAt:'2026-10-01T09:00:00Z',...extra});
items=[readyRow(71,'71',{name:'Avni Test',phone:'044740001',location:'A74'}),readyRow(10,'74',{name:'Hasan Test'}),readyRow(11,'74',{name:'Hasan Test',createdAt:'2026-10-05T09:00:00Z',result:'seen_in_depot'}),readyRow(174,'174'),readyRow(740,'740'),readyRow(25,'T74',{table:'transport_orders',key:'transport_orders:25',name:'Transport Test'})];
for(const query of ['74',' 74 ','#74','0074']) assert.deepEqual(items.filter(r=>matchesInventoryAuditSearch(r,query)).map(r=>r.id),['10','11']);
for(const query of ['T74','t 74','#T0074','T#74']) assert.deepEqual(items.filter(r=>matchesInventoryAuditSearch(r,query)).map(r=>r.id),['25']);
for(const query of ['7474','74x','+74','044740001']) assert.equal(items.filter(r=>matchesInventoryAuditSearch(r,query)).length,0);
assert.equal(normalizeInventoryAuditCode('9007199254740993'),'9007199254740993');
assert(matchesInventoryAuditSearch(readyRow(1,'1',{name:'Shkëndije Test'}),'test shkendije','details'));
assert(matchesInventoryAuditSearch(readyRow(1,'1',{phone:'+383 (44) 740-001'}),'38344740001','details'));
console.log('PASS exact code boundaries, Base/Transport separation, pasted labels, large codes and explicit detail search');
async function search(value){const input=doc().querySelector('.ia-search input');Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,15));}
const codes=()=>[...doc().querySelectorAll('.ia-code')].map(e=>e.textContent);
partial=false;await open('ADMIN','ready');await wait(()=>doc().querySelectorAll('.ia-order').length===5);
await search('74');await wait(()=>codes().length===2);assert.deepEqual(codes(),['74','74']);
assert(text().includes('Ky kod ka disa porosi'));assert.equal(doc().querySelectorAll('.ia-order-visit').length,2);
assert.equal(doc().querySelector('.ia-filters'),null);assert(text().includes('0 në Pastrim · 2 në Gati'));
const target=doc().querySelectorAll('.ia-order')[0];target.querySelector('.ia-found').click();await wait(()=>requests.at(-1)?.action==='VERIFY'&&items.find(r=>r.id==='10').result==='seen_in_depot');
assert.equal(requests.at(-1).items.length,1);assert.equal(requests.at(-1).items[0].id,'10');assert.equal(items[0].result,'unverified');assert.deepEqual(codes(),['74','74']);
console.log('PASS typing 74 displays only exact Base visits, includes previously found visits, and U gjet saves only the chosen order');
await search('T74');assert.deepEqual(codes(),['T74']);await search('7474');assert.deepEqual(codes(),[]);assert(text().includes('Kodi 7474 nuk gjendet në Pastrim ose Gati'));
await click('Pastro kërkimin');assert.equal(codes().length,4);await click('U gjet 2');assert.deepEqual(codes(),['74','74']);
await search('T74');assert.deepEqual(codes(),['T74']);await click('Pastro kërkimin');assert.deepEqual(codes(),['74','74']);
await click('Emër / telefon / raft');await search('044740001');assert.deepEqual(codes(),['71']);await search('hasan test');assert.deepEqual(codes(),['74','74']);
await click('Kodi i saktë');await search('044740001');assert.deepEqual(codes(),[]);
await open('DISPATCH','ready','74');await wait(()=>codes().length===2);assert.deepEqual(codes(),['74','74']);
console.log('PASS T74, honest zero results, search ignores prior filters, clear restores browse filter, explicit detail mode and deep links');
// The reported 1339 is fresh in Pastrim and must be visible from either tab.
const processingRow=(id,code,extra={})=>({...base,key:'orders:'+id,id:String(id),code,status:'pastrim',createdAt:'2026-10-12T09:00:00Z',overdue:false,ageDays:1,...extra});
items=[processingRow(1339,'1339',{pieces:4,name:'Klienti 1339'}),readyRow(2000,'2000',{result:'seen_in_depot'}),processingRow(71,'71',{phone:'044133900'})];
const unchanged=JSON.stringify(items), writesBefore=requests.filter(r=>r.action!=='LIST').length;
for(const stage of ['ready','processing']) {
 await open('ADMIN',stage);await wait(()=>text().includes(stage==='ready'?'Nuk ka porosi në këtë filtër':'Nuk ka porosi mbi 4 ditë'));
 await search('1339');assert.deepEqual(codes(),['1339']);assert(text().includes('1 në Pastrim · 0 në Gati'));
 const card=doc().querySelector('.ia-order');assert.equal(card.dataset.stage,'processing');assert(card.querySelector('.ia-state').textContent.includes('Pastrim · 1 ditë'));assert(card.textContent.includes('4 copë'));
 assert.equal(card.querySelector('.ia-found'),null);assert.equal(card.querySelector('input[type=checkbox]'),null);assert.equal(doc().querySelector('.ia-select-all'),null);
 await search('2000');assert.deepEqual(codes(),['2000']);assert.equal(doc().querySelector('.ia-order').dataset.stage,'ready');assert(doc().querySelector('.ia-found'));assert(text().includes('Gati · U gjet'));
 await click('Pastro kërkimin');assert.equal(codes().length,0);
}
await open('DISPATCH','ready','1339');await wait(()=>codes().length===1);assert.deepEqual(codes(),['1339']);
assert.equal(JSON.stringify(items),unchanged);assert.equal(requests.filter(r=>r.action!=='LIST').length,writesBefore);
console.log('PASS 1339 fresh Pastrim lookup from either tab/deep link, real status/pieces, no automatic writes, ready actions follow the row');
// One exact code can have fresh, overdue, unknown-date and already found visits.
items=[processingRow(101,'1339',{overdue:true,ageDays:6}),processingRow(102,'1339'),processingRow(103,'1339',{ageDays:null}),readyRow(104,'1339',{result:'seen_in_depot'}),processingRow(105,'T1339',{table:'transport_orders',key:'transport_orders:105'})];
await open('ADMIN','ready','1339');await wait(()=>codes().length===4);assert.deepEqual(codes(),['1339','1339','1339','1339']);
assert(text().includes('3 në Pastrim · 1 në Gati'));assert.equal(doc().querySelectorAll('.ia-order-visit').length,4);
assert.equal(doc().querySelectorAll('.ia-order input[type=checkbox]').length,1);assert.equal(doc().querySelectorAll('.ia-found').length,1);assert(text().includes('Data mungon'));
doc().querySelector('.ia-select-all input').click();await click('Kalo 1 në Gati');await click('Anulo');await search('T1339');assert.deepEqual(codes(),['T1339']);
await search('1339');assert.equal(doc().querySelector('.ia-bulk b').textContent,'0');doc().querySelector('.ia-select-all input').click();await click('Kalo 1 në Gati');await click('Po, kaloji në Gati');
await wait(()=>items[0].stage==='ready');assert.equal(requests.at(-1).action,'MOVE_READY');assert.deepEqual(requests.at(-1).items.map(r=>r.id),['101']);assert.equal(items[0].result,'unverified');
assert.equal(items[1].stage,'processing');assert.equal(items[2].stage,'processing');assert.equal(items[3].result,'seen_in_depot');assert.deepEqual(codes(),['1339','1339','1339','1339']);assert.equal(doc().querySelector('.ia-select-all'),null);
const movedCard=[...doc().querySelectorAll('.ia-order')].find(r=>r.textContent.includes('Porosia #101'));assert.equal(movedCard.dataset.stage,'ready');movedCard.querySelector('.ia-found').click();
await wait(()=>items[0].result==='seen_in_depot');assert.equal(requests.at(-1).action,'VERIFY');assert.deepEqual(requests.at(-1).items.map(r=>r.id),['101']);
console.log('PASS mixed-stage duplicate visits, eligible-only bulk move from Gati search, preserved result after move, precise physical verification');
// A new search cannot leave hidden overdue rows selected for a bulk move.
items=[{...base,key:'orders:1',id:'1',code:'74'},{...base,key:'orders:2',id:'2',code:'71',phone:'044740001'}];
await open();await wait(()=>doc().querySelectorAll('.ia-order').length===2);doc().querySelector('.ia-select-all input').click();await click('Kalo 2 në Gati');await click('Anulo');await search('74');assert.deepEqual(codes(),['74']);assert.equal(doc().querySelector('.ia-bulk b').textContent,'0');
console.log('PASS narrowing processing search clears hidden bulk selections');
const count=requests.length;await open('PUNTOR');await wait(()=>text().includes('vetëm për Admin dhe Dispatch'));assert.equal(requests.length,count);assert.equal(doc().querySelectorAll('.ia-order').length,0);
console.log('PASS worker cannot open audit UI or request the list');
fail=true;await open();await wait(()=>text().includes('Lista e plotë nuk u ngarkua'));assert(buttons().find(b=>b.textContent.startsWith('Kalo')).disabled);
console.log('PASS incomplete/unreachable list disables bulk action');
assert.deepEqual(problems,[]);dom.window.close();console.log('Inventory audit UI scenarios passed.');
