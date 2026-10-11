// UI interactions use the real component and a deterministic API fixture.
// Database authorization and mutations are covered by verify-inventory-audit-v1.
import assert from 'node:assert/strict';
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
items=[readyRow(71,'71',{name:'Avni Polici',phone:'044740001',location:'A74'}),readyRow(10,'74',{name:'Hasan Berisha'}),readyRow(11,'74',{name:'Hasan Berisha',createdAt:'2026-10-05T09:00:00Z',result:'seen_in_depot'}),readyRow(174,'174'),readyRow(740,'740'),readyRow(25,'T74',{table:'transport_orders',key:'transport_orders:25',name:'Transport Test'})];
for(const query of ['74',' 74 ','#74','0074']) assert.deepEqual(items.filter(r=>matchesInventoryAuditSearch(r,query)).map(r=>r.id),['10','11']);
for(const query of ['T74','t 74','#T0074','T#74']) assert.deepEqual(items.filter(r=>matchesInventoryAuditSearch(r,query)).map(r=>r.id),['25']);
for(const query of ['7474','74x','+74','044740001']) assert.equal(items.filter(r=>matchesInventoryAuditSearch(r,query)).length,0);
assert.equal(normalizeInventoryAuditCode('9007199254740993'),'9007199254740993');
assert(matchesInventoryAuditSearch(readyRow(1,'1',{name:'Shkëndije Gashi'}),'gashi shkendije','details'));
assert(matchesInventoryAuditSearch(readyRow(1,'1',{phone:'+383 (44) 740-001'}),'38344740001','details'));
console.log('PASS exact code boundaries, Base/Transport separation, pasted labels, large codes and explicit detail search');
async function search(value){const input=doc().querySelector('.ia-search input');Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,15));}
const codes=()=>[...doc().querySelectorAll('.ia-code')].map(e=>e.textContent);
partial=false;await open('ADMIN','ready');await wait(()=>doc().querySelectorAll('.ia-order').length===5);
await search('74');await wait(()=>codes().length===2);assert.deepEqual(codes(),['74','74']);
assert(text().includes('Ky kod ka disa porosi'));assert.equal(doc().querySelectorAll('.ia-order-visit').length,2);
assert(doc().querySelector('.ia-filters button[aria-pressed=true]').textContent.startsWith('Të gjitha'));
const target=doc().querySelectorAll('.ia-order')[0];target.querySelector('.ia-found').click();await wait(()=>requests.at(-1)?.action==='VERIFY'&&items.find(r=>r.id==='10').result==='seen_in_depot');
assert.equal(requests.at(-1).items.length,1);assert.equal(requests.at(-1).items[0].id,'10');assert.equal(items[0].result,'unverified');assert.deepEqual(codes(),['74','74']);
console.log('PASS typing 74 displays only exact Base visits, includes previously found visits, and U gjet saves only the chosen order');
await search('T74');assert.deepEqual(codes(),['T74']);await search('7474');assert.deepEqual(codes(),[]);assert(text().includes('Kodi 7474 nuk gjendet në Gati'));
await search('74');await click('Pa kontrolluar 4');assert.equal(codes().length,0);await click('Shfaq në të gjitha');assert.deepEqual(codes(),['74','74']);
await click('Emër / telefon / raft');await search('044740001');assert.deepEqual(codes(),['71']);await search('hasan berisha');assert.deepEqual(codes(),['74','74']);
await click('Kodi i saktë');await search('044740001');assert.deepEqual(codes(),[]);
await open('DISPATCH','ready','74');await wait(()=>codes().length===2);assert.deepEqual(codes(),['74','74']);
console.log('PASS T74, honest zero results, hidden-filter recovery, explicit phone/name mode and exact-code deep links');
// A new search cannot leave hidden overdue rows selected for a bulk move.
items=[{...base,key:'orders:1',id:'1',code:'74'},{...base,key:'orders:2',id:'2',code:'71',phone:'044740001'}];
await open();await wait(()=>doc().querySelectorAll('.ia-order').length===2);doc().querySelector('.ia-select-all input').click();await click('Kalo 2 në Gati');await click('Anulo');await search('74');assert.deepEqual(codes(),['74']);assert.equal(doc().querySelector('.ia-bulk b').textContent,'0');
console.log('PASS narrowing processing search clears hidden bulk selections');
const count=requests.length;await open('PUNTOR');await wait(()=>text().includes('vetëm për Admin dhe Dispatch'));assert.equal(requests.length,count);assert.equal(doc().querySelectorAll('.ia-order').length,0);
console.log('PASS worker cannot open audit UI or request the list');
fail=true;await open();await wait(()=>text().includes('Lista e plotë nuk u ngarkua'));assert(buttons().find(b=>b.textContent.startsWith('Kalo')).disabled);
console.log('PASS incomplete/unreachable list disables bulk action');
assert.deepEqual(problems,[]);dom.window.close();console.log('Inventory audit UI scenarios passed.');
