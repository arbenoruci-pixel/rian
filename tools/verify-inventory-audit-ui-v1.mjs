// UI interactions use the real component and a deterministic API fixture.
// Database authorization and mutations are covered by verify-inventory-audit-v1.
import assert from 'node:assert/strict';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'esbuild';
const bundle=await build({entryPoints:['tools/fixtures/inventory-audit-browser.jsx'],bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},alias:{'@':process.cwd()},loader:{'.css':'empty'},logLevel:'silent'});
let dom,requests=[],fail=false,partial=false;const problems=[];
const base={revision:'2026-01-01T00:00:00Z',table:'orders',name:'Klienti Test',phone:'044000000',location:'A12',pieces:3,m2:12,total:30,stage:'processing',overdue:true,ageDays:6,result:'unverified',note:''};
let items=[{...base,key:'orders:1',id:'1',code:'123'},{...base,key:'orders:2',id:'2',code:'124'},{...base,key:'orders:3',id:'3',code:'125',overdue:false,ageDays:1}];
async function open(role='ADMIN',stage='processing') {
 dom?.window.close();const vc=new VirtualConsole();vc.on('jsdomError',e=>problems.push(e.message));
 dom=new JSDOM('<div id="root"></div>',{url:'http://test.local/auditimi?stage='+stage,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
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
const count=requests.length;await open('PUNTOR');await wait(()=>text().includes('vetëm për Admin dhe Dispatch'));assert.equal(requests.length,count);assert.equal(doc().querySelectorAll('.ia-order').length,0);
console.log('PASS worker cannot open audit UI or request the list');
fail=true;await open();await wait(()=>text().includes('Lista e plotë nuk u ngarkua'));assert(buttons().find(b=>b.textContent.startsWith('Kalo')).disabled);
console.log('PASS incomplete/unreachable list disables bulk action');
assert.deepEqual(problems,[]);dom.window.close();console.log('Inventory audit UI scenarios passed.');
