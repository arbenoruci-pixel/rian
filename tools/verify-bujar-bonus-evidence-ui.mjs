import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'esbuild';
import { webcrypto, createHash } from 'node:crypto';
import { BUJAR_USER_ID } from '../lib/baseBonusEvidence.js';

// Actual React wizard and upload client; isolated HTTP/Storage contract fixtures.
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './components/BaseBonusEvidencePanel.jsx';const root=createRoot(document.getElementById('root'));window.render=()=>root.render(<Panel actor={window.actor}/>);window.render();`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', alias: { '@': process.cwd() }, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'isolated-evidence-dependencies', setup(b) { b.onResolve({filter:/lib\/(actorSession|supabaseClient)$/}, a=>({path:a.path,namespace:'test'})); b.onLoad({filter:/.*/,namespace:'test'}, a=>({contents:a.path.endsWith('actorSession')?'export const getActor=()=>window.actor;':'export const supabase={storage:{from:()=>({uploadToSignedUrl:(...args)=>window.upload(...args)})}};',loader:'js'})); } }] });
const order={id:101,code:123,client_name:'Klienti test',created_at:new Date(Date.now()-70*3600000).toISOString(),deadline:new Date(Date.now()+2*3600000).toISOString()};
let dom, request=null, uploads=new Map(), calls=[], failMessage=false, failSubmit=false, checked=0;
const sha = async blob=>createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const jpg = kind=>new Blob([new Uint8Array([255,216,255,...Array(120).fill(kind),255,217])],{type:'image/jpeg'});
async function open(manager=false) {
  dom?.window.close();const vc=new VirtualConsole();vc.on('jsdomError',e=>{throw e});
  dom=new JSDOM('<div id="root"></div>',{url:'https://test.local',pretendToBeVisual:true,runScripts:'outside-only',virtualConsole:vc});
  const w=dom.window;w.actor={id:manager?'11111111-1111-4111-8111-111111111111':BUJAR_USER_ID,role:manager?'DISPATCH':'PUNTOR',is_active:true};
  w.Blob=Blob;Object.defineProperty(w,'crypto',{value:webcrypto});w.URL.createObjectURL=()=> 'blob:fixture';w.URL.revokeObjectURL=()=>{};
  let imageCount=0;w.Image=class {naturalWidth=4000;naturalHeight=3000;set src(v){queueMicrotask(()=>this.onload())}};
  w.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},drawImage(){}});
  w.HTMLCanvasElement.prototype.toBlob=function(cb,type){assert(this.width<=2200);assert.equal(type,'image/jpeg');cb(jpg(++imageCount));};
  w.upload=async(path,token,file,opts)=>{assert.equal(opts.upsert,false);if(path==='message'&&failMessage){failMessage=false;return {error:{message:'lost network'}}}uploads.set(path,file);return {data:{path}}};
  w.fetch=async(url,opts={})=>{
    if(url.startsWith('https://proof/')) return {ok:true,blob:async()=>uploads.get(url.split('/').at(-1))};
    const b=JSON.parse(opts.body);calls.push(b);assert.equal(b.expectedActorId,w.actor.id);
    let result;
    if(b.action==='LIST')result={manager,requests:request?[{...request,order}]:[],candidates:[order]};
    if(b.action==='PREPARE'){
      request ||= {id:'22222222-2222-4222-8222-222222222222',order_id:101,status:'DRAFT',shelf:b.shelf,original_deadline:order.deadline,extended_deadline:new Date(Date.parse(order.deadline)+86400000).toISOString()};
      request.shelf=b.shelf;const items=[];for(const kind of ['carpet','message'])items.push({kind,path:kind,token:'signed-upload-only',exists:uploads.has(kind),hash:uploads.has(kind)?await sha(uploads.get(kind)):undefined});
      result={request:{...request},uploads:items};
    }
    if(b.action==='SUBMIT'){if(failSubmit){failSubmit=false;throw Error('Network interrupted')};assert.equal(uploads.size,2);request.status='PENDING';request.submitted_at=new Date().toISOString();result={request};}
    if(b.action==='VIEW')result={images:[...uploads.keys()].map(kind=>({kind,url:'https://proof/'+kind}))};
    if(b.action==='REVIEW'){if(b.decision==='APPROVED'){assert(b.checkedCarpet&&b.checkedMessage)}request.status=b.decision;result={request};}
    return {ok:true,status:200,json:async()=>({ok:true,...result})};
  };
  w.eval(bundle.outputFiles[0].text);await wait(()=>text().includes('72 orë + 24 orë'));
}
const text=()=>dom.window.document.body.textContent;
const buttons=()=>[...dom.window.document.querySelectorAll('button')];
const button=label=>buttons().find(b=>b.textContent.trim()===label);
async function wait(fn){const end=Date.now()+5000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout: '+text());}
async function click(label){await wait(()=>button(label)&&!button(label).disabled);button(label).click();await new Promise(r=>setTimeout(r,20));}
async function file(label){const input=dom.window.document.querySelector(`[aria-label="${label}"]`);Object.defineProperty(input,'files',{configurable:true,value:[{size:1000,type:'image/png'}]});input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await wait(()=>!button('Vazhdo').disabled);}
const pass=s=>{checked++;console.log('PASS',s)};
await open();await click('Fito +24 orë');assert(button('Vazhdo').disabled);await click('A12');await click('Vazhdo');assert(button('Vazhdo').disabled);assert.equal(dom.window.document.querySelector('input[type=file]').getAttribute('capture'),'environment');await file('Bëj foto të tepihave');await click('Vazhdo');assert(button('Vazhdo').disabled);await file('Ngarko screenshot-in e mesazhit');await click('Vazhdo');assert(text().includes('96 orë prej pranimit'));
pass('four-step wizard requires shelf, readable physical-photo step and customer-message screenshot');
failMessage=true;await click('Submit · Dërgo për aprovim');await wait(()=>text().includes('Ngarkimi nuk u konfirmua'));assert.equal(request.status,'DRAFT');assert.equal(uploads.size,1);assert(!calls.some(c=>c.action==='SUBMIT'));
pass('failed second upload keeps draft and never submits incomplete proof');
await open();await click('Fito +24 orë');await wait(()=>!button('Vazhdo').disabled);await click('Vazhdo');assert(dom.window.document.querySelector('input[type=file]').disabled);await click('Vazhdo');await file('Ngarko screenshot-in e mesazhit');await click('Vazhdo');failSubmit=true;await click('Submit · Dërgo për aprovim');await wait(()=>text().includes('Network interrupted'));await click('Submit · Dërgo për aprovim');await wait(()=>text().includes('Kërkesa pret aprovimin'));assert.equal(request.status,'PENDING');assert(!text().includes('+24 orë të aprovuara'));
pass('page reload restores uploaded photo; retry reuses exact files and stays pending until Dispatch');
await open(true);await click('Kontrollo provat');await wait(()=>dom.window.document.querySelectorAll('figure img').length===2);assert(button('Aprovo +24 orë').disabled);assert(button('Refuzo').disabled);
for(const img of dom.window.document.querySelectorAll('figure img')) img.dispatchEvent(new dom.window.Event('load'));
await new Promise(r=>setTimeout(r,20));const boxes=[...dom.window.document.querySelectorAll('input[type=checkbox]')];boxes[0].click();await new Promise(r=>setTimeout(r,20));assert(button('Aprovo +24 orë').disabled);boxes[1].click();await click('Aprovo +24 orë');await wait(()=>text().includes('Vendimi u ruajt'));assert.equal(request.status,'APPROVED');
pass('Dispatch must load and check both proofs before approving the fixed 24h');
await open();await wait(()=>text().includes('+24 orë të aprovuara'));assert(!button('Fito +24 orë'));pass('approved order cannot request a second extension');
request=null;uploads.clear();await open();Object.defineProperty(dom.window.navigator,'onLine',{configurable:true,value:false});await click('Rifresko');await wait(()=>text().includes('duhet internet'));pass('offline actions explain internet requirement and do not queue an unsafe approval');
dom.window.close();console.log(`Verified ${checked} Bujar evidence UI groups.`);
