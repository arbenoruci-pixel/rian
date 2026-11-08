import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { BUJAR_USER_ID } from '../lib/baseBonusEvidence.js';
import { controlRows, measurementSnapshot, controlTotals } from '../lib/transportControl.js';

// Exercise the actual component, upload client and IndexedDB drafts against HTTP fixtures.
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import Page from './components/TransportControlPage.jsx';createRoot(document.getElementById('root')).render(<MemoryRouter><Page/></MemoryRouter>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':process.cwd()},loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'isolate-http-and-actor',setup(b){b.onResolve({filter:/lib\/(actorSession|supabaseClient)$/},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path.endsWith('actorSession')?'export const getActor=()=>window.actor;':'export const supabase={storage:{from:()=>({uploadToSignedUrl:(...args)=>window.upload(...args)})}};',loader:'js'}));}}]});
const source={tepiha:[{id:'a',m2:'3.7',qty:'1'},{id:'b',m2:'1.2',qty:'1'},{id:'empty',m2:'',qty:''}],staza:[],shkallore:{qty:0,per:0.3},pay:{rate:1.8,m2:4.9,euro:8.82,paid:0}};
const order={id:'11111111-1111-4111-8111-111111111111',code:'T1657',client:'Klienti test',driver:'Transportuesi',visit:1,status:'pastrim',snapshot:measurementSnapshot(source),rows:controlRows(source),totals:controlTotals(controlRows(source))};
let dom,request=null,uploads=new Map(),calls=[],failUpload=false,failSubmit=false;
const jpg=()=>new Blob([new Uint8Array([255,216,255,...Array(120).fill(15),255,217])],{type:'image/jpeg'});
const copy=v=>JSON.parse(JSON.stringify(v));
const text=()=>dom.window.document.body.textContent;
const button=label=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
async function wait(fn){const end=Date.now()+5000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout: '+text());}
async function click(label){await wait(()=>button(label)&&!button(label).disabled);button(label).click();await new Promise(r=>setTimeout(r,20));}
function input(label,value){const el=dom.window.document.querySelector(`[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
async function open(manager=false){
 dom?.window.close();const vc=new VirtualConsole();vc.on('jsdomError',e=>{throw e});
 dom=new JSDOM('<div id="root"></div>',{url:'https://test.local',pretendToBeVisual:true,runScripts:'outside-only',virtualConsole:vc});const w=dom.window;
 w.actor={id:manager?'22222222-2222-4222-8222-222222222222':BUJAR_USER_ID,role:manager?'DISPATCH':'PUNTOR',is_active:true};
 w.Blob=Blob;w.indexedDB=indexedDB;w.structuredClone=structuredClone;Object.defineProperty(w,'crypto',{value:webcrypto});w.URL.createObjectURL=()=> 'blob:fixture';w.URL.revokeObjectURL=()=>{};
 w.Image=class{naturalWidth=4000;naturalHeight=3000;set src(v){queueMicrotask(()=>this.onload())}};w.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},drawImage(){}});w.HTMLCanvasElement.prototype.toBlob=function(cb,type){assert(this.width<=2200);assert.equal(type,'image/jpeg');cb(jpg())};
 w.upload=async(path,token,file,opts)=>{assert.equal(opts.upsert,false);if(failUpload){failUpload=false;return {error:{message:'lost network'}}}uploads.set(path,file);return {data:{path}}};
 w.fetch=async(url,opts={})=>{
  if(url.startsWith('https://proof/'))return {ok:true,blob:async()=>uploads.get(url.split('/').at(-1))};
  const b=JSON.parse(opts.body);calls.push(b);assert.equal(b.expectedActorId,w.actor.id);let result;
  if(b.action==='LIST')result={manager,orders:[order],controls:request?[request]:[],bonuses:request?.status==='APPROVED'?[{amount:0.5,remaining_amount:0.5,reserved_amount:0,ready_at:new Date().toISOString()}]:[],serverNow:new Date().toISOString()};
  if(b.action==='PREPARE'){
   request||={id:'33333333-3333-4333-8333-333333333333',order_id:order.id,worker_id:BUJAR_USER_ID,status:'DRAFT'};
   Object.assign(request,{attempt_id:b.attemptId,original_snapshot:b.snapshot,proposed_rows:b.rows,physical_count:b.count,note:b.note,photos:b.hashes.map((hash,i)=>({path:String(i),hash}))});
   result={request,uploads:request.photos.map(p=>({...p,token:'signed',exists:uploads.has(p.path)}))};
  }
  if(b.action==='SUBMIT'){if(failSubmit){failSubmit=false;throw Error('Network interrupted')};assert.equal(uploads.size,request.photos.length);request.status='PENDING';request.submitted_at=new Date().toISOString();result={request};}
  if(b.action==='VIEW')result={request,images:request.photos.filter(p=>uploads.has(p.path)).map(p=>({hash:p.hash,url:'https://proof/'+p.path}))};
  if(b.action==='REVIEW'){if(b.decision==='APPROVED')assert(b.checkedEvidence);request.status=b.decision;result={request};}
  return {ok:true,status:200,json:async()=>copy({ok:true,...result})};
 };
 w.eval(bundle.outputFiles[0].text);await wait(()=>request?.status==='APPROVED'&&!manager?button('Të aprovuara 1'):dom.window.document.querySelector('.tc-order'));
}
async function openOrder(){dom.window.document.querySelector('.tc-order').click();await wait(()=>dom.window.document.querySelector('[role=dialog]'));await wait(()=>!text().includes('Duke hapur kontrollin'));}
await open();assert(text().includes('Hajde, Bujar.'));assert(text().includes('0.00 €'));await openOrder();assert(button('Vazhdo →').disabled);input('Numri fizik i copave','3');dom.window.document.querySelector('input[type=checkbox]').click();await wait(()=>text().includes('lista ka 2'));assert(button('Vazhdo →').disabled);input('Numri fizik i copave','2');await click('Vazhdo →');assert(button('Vazhdo →').disabled);
const file=dom.window.document.querySelector('input[type=file]');assert.equal(file.getAttribute('capture'),'environment');Object.defineProperty(file,'files',{value:[{type:'image/png',size:1000}],configurable:true});file.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await wait(()=>dom.window.document.querySelector('.tc-photo'));await click('Vazhdo →');await wait(()=>text().includes('Drafti u ruajt'));console.log('PASS wizard requires actual piece count, confirmation and camera proof before submission');
// Reopening a real IndexedDB draft restores the complete step and photo blob.
await click('×');await openOrder();await wait(()=>text().includes('Gati për Dispatch-in.'));assert(text().includes('1 foto provë'));failUpload=true;await click('Submit · Dërgo');await wait(()=>text().includes('Ngarkimi nuk u konfirmua'));assert.equal(request.status,'DRAFT');assert(!calls.some(c=>c.action==='SUBMIT'));console.log('PASS durable local draft restores photos; failed upload never submits incomplete proof');
failSubmit=true;await click('Submit · Dërgo');await wait(()=>text().includes('Network interrupted'));assert.equal(uploads.size,1);const before=calls.filter(c=>c.action==='SUBMIT').length;button('Submit · Dërgo').click();button('Submit · Dërgo')?.click();await wait(()=>text().includes('Kontrolli u dërgua!'));assert.equal(calls.filter(c=>c.action==='SUBMIT').length,before+1);assert.equal(request.status,'PENDING');assert(text().includes('0.00 €'));console.log('PASS retry reuses uploaded evidence, double-click submits once, pending approval earns nothing');
await open(true);await openOrder();await wait(()=>dom.window.document.querySelector('figure img'));assert(button('Aprovo · +0.50 €').disabled);assert(button('Kthe për plotësim').disabled);dom.window.document.querySelector('figure img').dispatchEvent(new dom.window.Event('load'));await wait(()=>!dom.window.document.querySelector('input[type=checkbox]').disabled);assert(button('Aprovo · +0.50 €').disabled);dom.window.document.querySelector('input[type=checkbox]').click();await click('Aprovo · +0.50 €');await wait(()=>text().includes('iu shtuan 0.50 €'));assert.equal(request.status,'APPROVED');console.log('PASS Dispatch must load and acknowledge proof; successful approval refreshes the available daily bonus');
await open();await click('Të aprovuara 1');assert(text().includes('0.50 €'));await openOrder();assert(!button('Submit · Dërgo'));assert(!button('Aprovo · +0.50 €'));console.log('PASS worker can view approved evidence without reopening or paying the same control twice');
dom.window.close();console.log('Transport control UI checks passed.');
