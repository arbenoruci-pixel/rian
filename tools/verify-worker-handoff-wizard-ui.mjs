import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

// Real browser client and React component with synthetic server responses.
// No application session, production identity, network, or financial write.
const actor = {id:'20000000-0000-4000-8000-000000000001',pin:'8001',name:'Fixture Worker',role:'PUNTOR'};
const otherActor = {...actor,id:'20000000-0000-4000-8000-000000000002',pin:'8002',name:'Another Fixture'};
const clone = value => JSON.parse(JSON.stringify(value));
const wait = async (check,description='wizard state') => {
  const until=Date.now()+5000;
  while(!check()) {
    if(Date.now()>until) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
};
const identityPlugin={name:'synthetic-actor',setup(builder){
  builder.onResolve({filter:/lib\/actorSession$/},args=>({path:args.path,namespace:'fixture-actor'}));
  builder.onLoad({filter:/.*/,namespace:'fixture-actor'},()=>({contents:'export const getActor=()=>window.actor;'}));
}};
async function bundle(contents) {
  return (await build({stdin:{contents,loader:'jsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},plugins:[identityPlugin]})).outputFiles[0].text;
}
function browser() {
  const errors=[];
  const virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.test/arka',pretendToBeVisual:true,runScripts:'outside-only',virtualConsole});
  const w=dom.window;
  w.actor=clone(actor);
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.fetch=()=>{throw new Error('Unexpected network request from fixture');};
  return {w,close(){w.__unmount?.();w.close();assert.equal(errors.length,0,errors.map(String).join('\n'));}};
}

const clientBundle=await bundle("import * as client from './lib/workerHandoffClient.js';window.client=client;");
const clientBrowser=browser();const cw=clientBrowser.w;cw.eval(clientBundle);
const requests=[];
let response=async()=>({ok:true,status:200,json:async()=>({ok:true})});
cw.fetch=async(url,options)=>{
  assert.equal(url,'/api/worker-handoff');
  assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');
  assert.equal(options.headers['content-type'],'application/json');
  requests.push(JSON.parse(options.body));
  return response();
};
await cw.client.workerHandoffApi.preview({mealChoice:'none',expenses:[]});
assert.equal(requests[0].expectedActorId,actor.id);assert.equal('actorId' in requests[0],false);
const payload={snapshotHash:'a'.repeat(32),options:{mealChoice:'self',expenses:[]},physicalCash:25,differenceReason:'Synthetic cash count mismatch'};
response=async()=>{throw new Error('Synthetic response lost after commit');};
await assert.rejects(cw.client.submitWorkerHandoff(payload),/lost after commit/);
const uncertain=clone(await cw.client.readWorkerHandoffIntent());
assert.equal(uncertain.actorId,actor.id);assert.equal(uncertain.physicalCash,25);assert.equal(uncertain.snapshotHash,payload.snapshotHash);
assert.match(uncertain.requestKey,/^WH1:/);
const requestAfterLoss=clone(requests.at(-1));
const countAfterLoss=requests.length;
await assert.rejects(cw.client.submitWorkerHandoff({...payload,physicalCash:99}),/pret përgjigjen/);
assert.equal(requests.length,countAfterLoss);
response=async()=>({ok:true,status:200,json:async()=>({ok:true,handoffId:42,replayed:true,submission:{physicalCash:25}})});
const recovered=await cw.client.submitWorkerHandoff({...payload,physicalCash:99},{retry:true});
assert.equal(recovered.handoffId,42);assert.equal(recovered.replayed,true);
assert.deepEqual(requests.at(-1),requestAfterLoss);
assert.equal(await cw.client.readWorkerHandoffIntent(),null);
console.log('PASS client binds requests to the current actor and durable retry reuses the exact saved payload and key after a lost reply');

response=async()=>({ok:false,status:409,json:async()=>({ok:false,error:'WHW_SNAPSHOT_STALE'})});
await assert.rejects(cw.client.submitWorkerHandoff(payload),/Rifresko|ndryshuar/);
assert.equal(await cw.client.readWorkerHandoffIntent(),null);
response=async()=>({ok:false,status:503,json:async()=>({ok:false,error:'WORKER_HANDOFF_REQUEST_FAILED'})});
await assert.rejects(cw.client.submitWorkerHandoff(payload));
assert.ok(await cw.client.readWorkerHandoffIntent());
response=async()=>({ok:true,status:200,json:async()=>({ok:true,handoffId:43,submission:{physicalCash:25}})});
await cw.client.submitWorkerHandoff(null,{retry:true});

let finishOldRequest;
response=()=>new Promise(resolve=>{finishOldRequest=resolve;});
const oldRequest=cw.client.submitWorkerHandoff(payload);
await wait(()=>finishOldRequest,'pending client HTTP request');
cw.actor=clone(otherActor);
finishOldRequest({ok:true,status:200,json:async()=>({ok:true,handoffId:44,submission:{physicalCash:25}})});
await assert.rejects(oldRequest,/Llogaria ka ndryshuar/);
assert.equal(await cw.client.readWorkerHandoffIntent(),null);
await assert.rejects(cw.client.submitWorkerHandoff(null,{retry:true}),/Nuk ka dorëzim/);
cw.actor=clone(actor);
assert.ok(await cw.client.readWorkerHandoffIntent());
response=async()=>({ok:true,status:200,json:async()=>({ok:true,handoffId:44,replayed:true,submission:{physicalCash:25}})});
await cw.client.submitWorkerHandoff(null,{retry:true});
assert.equal(await cw.client.readWorkerHandoffIntent(),null);

const storageSet=cw.Storage.prototype.setItem;
cw.Storage.prototype.setItem=()=>{throw new Error('Synthetic full storage');};
const beforeStorage=requests.length;
await assert.rejects(cw.client.submitWorkerHandoff(payload),/nuk mund ta ruajë/);
assert.equal(requests.length,beforeStorage);
cw.Storage.prototype.setItem=storageSet;
clientBrowser.close();
console.log('PASS definite rejection clears intent, uncertain failure preserves it, account switch isolates it, and storage failure blocks unsafe submission');

// Exercise the actual worker client under the same quota failure as a phone.
const sharedIndexedDB = new IDBFactory();
const localRows = new Map([['unsent-payment','KEEP'], ['customer-draft','KEEP']]);
const fullLocal = {
  getItem: key => localRows.get(key) ?? null,
  setItem: () => { throw new DOMException('Synthetic full storage', 'QuotaExceededError'); },
  removeItem: key => localRows.delete(key),
};
const fallbackRequests = [];
const serverKeys = new Set();
let loseReply = true;
function fallbackBrowser() {
  const page = browser(), w = page.w;
  Object.defineProperty(w,'localStorage',{configurable:true,value:fullLocal});
  Object.defineProperty(w,'indexedDB',{configurable:true,value:sharedIndexedDB});
  w.structuredClone = structuredClone;
  w.eval(clientBundle);
  w.fetch = async (url, opts) => {
    assert.equal(url,'/api/worker-handoff');
    const body = JSON.parse(opts.body);
    const saved = await w.client.readWorkerHandoffIntent();
    assert.equal(saved?.requestKey, body.requestKey, 'Persist before POST');
    assert.equal(body.expectedActorId, actor.id);
    fallbackRequests.push(body);
    const replayed = serverKeys.has(body.requestKey);
    serverKeys.add(body.requestKey);
    if (loseReply) { loseReply=false; throw new Error('Synthetic lost response'); }
    return {ok:true,status:200,json:async()=>({ok:true,handoffId:45,replayed,submission:{physicalCash:body.physicalCash}})};
  };
  return page;
}
let fallback = fallbackBrowser();
const smallCash = {...payload, physicalCash:10.92};
await assert.rejects(fallback.w.client.submitWorkerHandoff(smallCash), /lost response/);
assert.equal(serverKeys.size,1);
const durable = clone(await fallback.w.client.readWorkerHandoffIntent());
assert.equal(durable.physicalCash,10.92);
fallback.close();
fallback = fallbackBrowser();
assert.deepEqual(clone(await fallback.w.client.readWorkerHandoffIntent()),durable);
await assert.rejects(fallback.w.client.submitWorkerHandoff({...smallCash,physicalCash:99}),/pret përgjigjen/);
assert.equal(fallbackRequests.length,1);
const replay = await fallback.w.client.submitWorkerHandoff(null,{retry:true});
assert.equal(replay.replayed,true);
assert.deepEqual(fallbackRequests[1],fallbackRequests[0]);
assert.equal(serverKeys.size,1);
assert.equal(await fallback.w.client.readWorkerHandoffIntent(),null);
assert.equal(localRows.get('unsent-payment'),'KEEP');
assert.equal(localRows.get('customer-draft'),'KEEP');
fallback.close();

// A session change during IndexedDB persistence must not POST the old actor's
// request with the new user's authenticated session.
fallback = fallbackBrowser();
const originalPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (...args) {
  const request = originalPut.apply(this,args);
  request.addEventListener('success',()=>{ fallback.w.actor=clone(otherActor); });
  return request;
};
try {
  const before = fallbackRequests.length;
  await assert.rejects(fallback.w.client.submitWorkerHandoff(smallCash),/Llogaria ka ndryshuar/);
  assert.equal(fallbackRequests.length,before);
  assert.equal(await fallback.w.client.readWorkerHandoffIntent(),null);
  fallback.w.actor=clone(actor);
  assert.equal((await fallback.w.client.readWorkerHandoffIntent()).physicalCash,10.92);
} finally { IDBObjectStore.prototype.put=originalPut; fallback.close(); }
console.log('PASS worker submission survives full localStorage and reload, replays exactly once, preserves unrelated offline records, and blocks session-switch POST');

// Actual worker client: blocked IndexedDB must not strand a reviewed server snapshot.
let recoveryPage=browser();
const recoveryKeys=new Map();
const recoveryPayload={...payload,physicalCash:537.66};
let recoveryLose=true;
function configureRecovery(page){
  const w=page.w;
  Object.defineProperty(w,'indexedDB',{configurable:true,value:{open(){throw new Error('Synthetic blocked database');}}});
  w.structuredClone=structuredClone;w.eval(clientBundle);
  w.fetch=async(url,opts)=>{
    const body=JSON.parse(opts.body);
    assert.equal(url,'/api/worker-handoff');
    assert.equal(body.expectedActorId,actor.id);
    assert.match(body.requestKey,/^WH1:STATE:/);
    const previous=recoveryKeys.get(body.requestKey);
    if(previous){assert.deepEqual(body,previous);return {ok:true,status:200,json:async()=>({ok:true,handoffId:45,replayed:true,submission:{physicalCash:body.physicalCash}})};}
    recoveryKeys.set(body.requestKey,body);
    if(recoveryLose){recoveryLose=false;throw new Error('Synthetic lost response after commit');}
    return {ok:true,status:200,json:async()=>({ok:true,handoffId:45,replayed:false,submission:{physicalCash:body.physicalCash}})};
  };
  return w;
}
let rw=configureRecovery(recoveryPage);
const recoveryOptions={serverRecovery:true};
assert.equal(await rw.client.readWorkerHandoffIntent(recoveryOptions),null);
await assert.rejects(rw.client.submitWorkerHandoff(recoveryPayload,recoveryOptions),/lost response/);
assert.equal(recoveryKeys.size,1);
assert.equal((await rw.client.readWorkerHandoffIntent(recoveryOptions)).physicalCash,537.66);
assert.equal((await rw.client.submitWorkerHandoff(null,{...recoveryOptions,retry:true})).replayed,true);
recoveryPage.close();recoveryPage=browser();rw=configureRecovery(recoveryPage);
assert.equal(await rw.client.readWorkerHandoffIntent(recoveryOptions),null);
assert.equal((await rw.client.submitWorkerHandoff(recoveryPayload,recoveryOptions)).replayed,true);
assert.equal(recoveryKeys.size,1);
recoveryPage.close();
console.log('PASS reviewed worker confirmation recovers blocked IndexedDB and exact server replay');

const wizardBundle=await bundle("import React from 'react';import {createRoot} from 'react-dom/client';import Wizard from './components/HandoffWizard.jsx';import {handoffExpenseDescription} from './components/workerHandoffWizardModel.js';window.__expenseDescription=handoffExpenseDescription;const root=createRoot(document.getElementById('root'));window.__render=props=>{window.__props=props;window.actor=props.actor;root.render(<Wizard {...props}/>);};window.__unmount=()=>root.unmount();window.__render(window.__props);");
const rawExpenseDescription = 'Buk\nARKA_EXPENSE_REQUEST_V1 type=BUSINESS_EXPENSE';
function quote(options={},settings={}) {
  const {gross=100,bonus=10,carry=0,commission=0,daily=true,scope=actor,empty=false,covered=false}=settings;
  const meal=carry+(daily&&options.mealChoice==='self'?3:0);
  const held=Math.min(bonus,Math.max(0,gross-commission-meal-0.01));
  const expected=gross-commission-meal-held;
  const expenses=(options.expenses||[]).map(row=>({...row,description:row.existingPaymentId===51?rawExpenseDescription:row.description,deductionAmount:row.fundingSource==='WORKER_COLLECTIONS'?row.amount-(row.includesOwnMeal?3:0):0,mealAlreadyDeducted:row.includesOwnMeal?3:0}));
  const claimed=expenses.reduce((sum,row)=>sum+row.deductionAmount,0);
  return {ok:true,actorId:scope.id,snapshotHash:'b'.repeat(32),businessDate:daily?'2026-11-21':'2026-12-01',
    mealPolicy:{dailyAllowed:daily,choice:daily?options.mealChoice||(covered?'existing':null):'monthly',mealAmount:options.mealChoice==='self'?3:0,existingMealTotal:carry,coveredToday:covered,eligibleSelf:true,requiresDecision:daily&&!covered&&!options.mealChoice},
    mealPayers:[{id:otherActor.id,name:otherActor.name}],
    payments:empty?[]:[{id:11,code:'C1001',clientName:'Fixture Client One',amount:gross*0.6,collectedAt:'2026-11-21T10:00:00Z',sourceModule:'BASE'},{id:12,code:'T1002',clientName:'Fixture Client Two',amount:gross*0.4,collectedAt:'2026-11-21T11:00:00Z',sourceModule:'TRANSPORT'}],
    bonuses:bonus?[{bonusId:21,paymentId:31,kind:'BASE',amount:bonus*0.95,remainingAmount:bonus*0.95},{bonusId:22,paymentId:32,kind:'TRANSPORT',amount:bonus*0.05,remainingAmount:bonus*0.05}]:[],
    existingExpenses:[{paymentId:51,amount:12,description:rawExpenseDescription,spentOn:'2026-11-21',status:'APPROVED',ledgerPosted:true}],expenses,
    totals:{grossCash:empty?0:gross,commission,mealDeduction:meal,bonusDeduction:held,bonusRemaining:bonus-held,expectedCash:empty?0:expected,claimedCollectionExpenses:claimed,projectedCash:empty?0:expected-claimed},
    pendingHandoffs:[{id:101,amount:41,submittedAt:'2026-11-20T10:00:00Z'},{id:102,amount:17,submittedAt:'2026-11-20T15:00:00Z'}],canSubmit:!empty&&expected>0&&(!daily||covered||!!options.mealChoice),warnings:[]};
}
function reply(payload,settings={}) {
  const q=quote(payload.options,settings);
  return {ok:true,handoffId:42,replayed:false,submission:{id:1,handoffId:42,physicalCash:payload.physicalCash,expectedCash:q.totals.expectedCash,projectedCash:q.totals.projectedCash,differenceAmount:payload.physicalCash-q.totals.projectedCash,differenceReason:payload.differenceReason,createdAt:'2026-11-21T12:00:00Z',snapshot:q},claims:q.expenses};
}
async function openWizard({api,actor:active=actor,onSaved=()=>{},onClose=()=>{}}={}) {
  const fixture=browser();const w=fixture.w;
  w.__props={open:true,actor:clone(active),onSaved,onClose,api:api||{preview:async options=>quote(options),pending:()=>null,submit:async payload=>reply(payload)}};
  w.eval(wizardBundle);
  const query=selector=>w.document.querySelector(selector);
  const text=()=>w.document.body.textContent.replace(/\s+/g,' ');
  const button=label=>[...w.document.querySelectorAll('button')].find(element=>element.textContent.trim()===label||element.querySelector('strong')?.textContent.trim()===label);
  const click=async label=>{const element=button(label);assert.ok(element,`Missing ${label}: ${text()}`);assert.equal(element.disabled,false,`${label} is disabled`);element.click();await new Promise(resolve=>setTimeout(resolve,10));};
  const input=async(element,value)=>{assert.ok(element);const prototype=element.tagName==='SELECT'?w.HTMLSelectElement.prototype:element.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new w.Event(element.tagName==='SELECT'?'change':'input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,10));};
  const field=label=>[...w.document.querySelectorAll('label')].find(element=>element.textContent.startsWith(label))?.querySelector('input,select,textarea');
  await wait(()=>query('[data-handoff-step]')||query('[data-handoff-pending-retry]')||query('[role="alert"]'),'initial wizard');
  return {...fixture,query,text,button,click,input,field,step:()=>Number(query('[data-handoff-step]')?.dataset.handoffStep)};
}
async function toCount(ui,{meal='none'}={}) {
  await ui.click('VAZHDO');await ui.click('VAZHDO');
  const mealLabel=meal==='self'?'E kam paguar vetë':meal==='other'?'E ka paguar një punëtor tjetër':'Nuk kam marrë ushqim sot';
  if(ui.button(mealLabel)) await ui.click(mealLabel);
  if(meal==='other') await ui.input(ui.field('Kush e ka paguar ushqimin?'),otherActor.id);
  await ui.click('VAZHDO');await wait(()=>ui.step()===4,'physical count step');
}
async function toConfirmation(ui,value,reason='') {
  await ui.input(ui.query('[data-handoff-physical-input]'),value);
  if(reason) await ui.input(ui.field('Pse ka dallim?'),reason);
  await ui.click('VAZHDO');assert.equal(ui.step(),5);
  ui.query('input[type="checkbox"]').click();await new Promise(resolve=>setTimeout(resolve,10));
}

const previews=[],submits=[],saved=[];let resolveSubmit;
const fullApi={pending:()=>null,preview:async options=>{previews.push(clone(options));return quote(options);},submit:async(payload,options)=>{submits.push({payload:clone(payload),options:clone(options)});return new Promise(resolve=>{resolveSubmit=resolve;});}};
const full=await openWizard({api:fullApi,onSaved:value=>saved.push(clone(value))});
assert.equal(full.w.document.querySelectorAll('[data-handoff-payment]').length,2);
assert.match(full.text(),/Fixture Client One/);assert.match(full.text(),/Fixture Client Two/);assert.match(full.text(),/100,00/);
assert.ok(full.query('[data-handoff-previous]'));assert.equal(full.w.document.body.style.overflow,'hidden');
await full.click('VAZHDO');assert.equal(full.step(),2);assert.equal(full.w.document.querySelectorAll('[data-handoff-bonus]').length,2);assert.match(full.text(),/10,00/);assert.match(full.text(),/Kontroll transporti/);
await full.click('VAZHDO');assert.equal(full.step(),3);
assert.match(full.text(), /Buk/); assert.doesNotMatch(full.text(), /ARKA_EXPENSE_REQUEST_V1/);
assert.equal(full.w.__expenseDescription('Shënim: ARKA_EXPENSE_REQUEST_V1 për kontroll'), 'Shënim: ARKA_EXPENSE_REQUEST_V1 për kontroll');
assert.equal(full.w.__expenseDescription('ARKA_EXPENSE_REQUEST_V10 human text'), 'ARKA_EXPENSE_REQUEST_V10 human text');
await full.click('VAZHDO');assert.equal(full.step(),3);assert.ok(full.query('[role="alert"]'));
await full.click('E kam paguar vetë');await full.click('Zgjedhe këtë shpenzim');
assert.equal(full.field('Shuma (€)').readOnly,true);
assert.equal(full.field('Për çfarë është paguar?').value, 'Buk');
await full.click('Përfshije në kërkesë');assert.match(full.text(),/Trego nga cilat para/);
await full.input(full.field('Lloji i shpenzimit'),'SUPPLIES');await full.input(full.field('Nga cilat para'),'WORKER_COLLECTIONS');
await full.click('Përfshije në kërkesë');
assert.equal(full.w.document.querySelectorAll('[data-handoff-expense]').length,1);assert.equal(full.button('Përfshirë në kërkesë').disabled,true);
await full.click('VAZHDO');await wait(()=>full.step()===4);
assert.equal(previews.length,2);assert.equal(previews.at(-1).expenses[0].amount,12);assert.equal(previews.at(-1).expenses[0].fundingSource,'WORKER_COLLECTIONS');
assert.equal(previews.at(-1).expenses[0].description, 'Buk'); assert.doesNotMatch(full.text(), /ARKA_EXPENSE_REQUEST_V1/);
assert.equal(quote(previews.at(-1)).expenses[0].description, rawExpenseDescription);
assert.match(full.query('[data-handoff-expected]').textContent,/87,00/);assert.match(full.query('[data-handoff-projected]').textContent,/75,00/);
assert.equal(full.query('[data-handoff-physical-input]').value,'');
await full.click('VAZHDO');assert.equal(full.step(),4);assert.match(full.text(),/Numëro paratë dhe shkruaje/);
await full.input(full.query('[data-handoff-physical-input]'),'25');await full.click('VAZHDO');assert.equal(full.step(),4);assert.match(full.text(),/Shpjego pse/);
await full.input(full.field('Pse ka dallim?'),'Only 25 physically counted; investigate expenses');await full.click('VAZHDO');
assert.equal(full.step(),5);assert.equal(full.button('KONFIRMO DORËZIMIN').disabled,true);
assert.match(full.query('[data-handoff-difference]').textContent,/50,00/);
full.query('input[type="checkbox"]').click();await new Promise(resolve=>setTimeout(resolve,10));
const confirm=full.button('KONFIRMO DORËZIMIN');confirm.click();confirm.click();await wait(()=>submits.length===1);
assert.equal(full.query('[data-handoff-receipt]'),null);
assert.equal(submits[0].payload.physicalCash,25);assert.equal(submits[0].options.retry,false);
resolveSubmit(reply(submits[0].payload));await wait(()=>full.query('[data-handoff-receipt]'));
assert.equal(saved.length,1);assert.equal(submits.length,1);
assert.match(full.query('[data-handoff-receipt]').textContent,/25,00/);assert.match(full.query('[data-handoff-receipt]').textContent,/87,00/);assert.match(full.query('[data-handoff-receipt]').textContent,/75,00/);assert.match(full.text(),/Pranimi real regjistrohet nga dispatch/);
full.close();
console.log('PASS actual five-step wizard itemizes customers and Base/Transport bonuses, verifies expense source, requires a physical count and mismatch reason, submits once, and displays the saved server receipt');

for (const includesOwnMeal of [true, false]) {
  const optionsSeen = [];
  const food = await openWizard({ api:{ pending:() => null, preview:async options => { optionsSeen.push(clone(options)); return quote(options); } } });
  await food.click('VAZHDO'); await food.click('VAZHDO'); await food.click('E kam paguar vetë'); await food.click('Zgjedhe këtë shpenzim');
  await food.input(food.field('Lloji i shpenzimit'), 'FOOD');
  assert.equal(food.query('[data-handoff-own-meal-choice]'), null);
  await food.input(food.field('Nga cilat para'), 'OWN_MONEY');
  assert.equal(food.query('[data-handoff-own-meal-choice]'), null);
  await food.input(food.field('Nga cilat para'), 'WORKER_COLLECTIONS');
  assert.ok(food.query('[data-handoff-own-meal-choice]'));
  assert.equal(food.w.document.querySelectorAll('[data-handoff-own-meal-choice] input:checked').length, 0);
  await food.click('Përfshije në kërkesë');
  assert.match(food.text(), /Zgjedh Po ose Jo/);
  assert.equal(food.w.document.querySelectorAll('[data-handoff-expense]').length, 0);
  food.query(`[data-handoff-own-meal-choice] input[value="${includesOwnMeal ? 'yes' : 'no'}"]`).click();
  await new Promise(resolve => setTimeout(resolve, 10));
  await food.click('Përfshije në kërkesë'); await food.click('VAZHDO');
  await wait(() => food.step() === 4);
  const sent = optionsSeen.at(-1).expenses[0];
  assert.equal(sent.includesOwnMeal, includesOwnMeal);
  assert.equal(typeof sent.includesOwnMeal, 'boolean');
  assert.deepEqual(Object.keys(sent).sort(), ['amount','category','clientKey','description','existingPaymentId','fundingSource','includesOwnMeal','recipient','spentOn'].sort());
  assert.match(food.query('[data-handoff-projected]').textContent, includesOwnMeal ? /78,00/ : /75,00/);
  food.close();
}
console.log('PASS food paid from client collections requires an explicit initially-unset yes/no personal-meal answer, submits only its boolean, and displays the server-calculated overlap credit');

for(const carry of [0,3]) {
  const optionsSeen=[];const settings={daily:false,bonus:5,carry};
  const month=await openWizard({api:{pending:()=>null,preview:async options=>{optionsSeen.push(clone(options));return quote(options,settings);},submit:async payload=>reply(payload,settings)}});
  await month.click('VAZHDO');await month.click('VAZHDO');
  assert.equal(month.button('E kam paguar vetë'),undefined);assert.match(month.text(),/pjesë e rrogës mujore/);
  await month.click('+ Shto shpenzim');
  assert.deepEqual([...month.field('Lloji i shpenzimit').options].map(option => option.value), ['FUEL','SUPPLIES','OTHER']);
  assert.match(month.text(), /Ushqimi i ri është pjesë e rrogës mujore/);
  await month.click('Anulo'); await month.click('Zgjedhe këtë shpenzim');
  assert.ok([...month.field('Lloji i shpenzimit').options].some(option => option.value === 'FOOD'));
  assert.equal(month.field('Data e shpenzimit').value, '2026-11-21'); assert.equal(month.field('Data e shpenzimit').readOnly, true);
  assert.equal(month.field('Shuma (€)').readOnly, true); assert.equal(month.field('Për çfarë është paguar?').value, 'Buk');
  await month.click('Anulo');
  await month.click('VAZHDO');assert.equal(month.step(),4);assert.ok(!['self','other'].includes(optionsSeen.at(-1).mealChoice));
  assert.match(month.query('[data-handoff-projected]').textContent,new RegExp(`${95-carry},00`));
  await toConfirmation(month,String(95-carry));await month.click('KONFIRMO DORËZIMIN');await wait(()=>month.query('[data-handoff-receipt]'));
  assert.match(month.query('[data-handoff-receipt]').textContent,new RegExp(`${95-carry},00`));month.close();
}
for(const settings of [{gross:5,bonus:10},{gross:100,bonus:6.5,commission:20,carry:3},{gross:100,bonus:6.5,carry:3,meal:'self'},{gross:100,bonus:6.5,carry:3,meal:'other'},{gross:100,bonus:6.5,carry:6,covered:true}]) {
  const meal=settings.meal||(settings.covered?'existing':'none');
  const server=quote({mealChoice:meal},settings);
  const narrow=await openWizard({api:{pending:()=>null,preview:async options=>quote(options,settings),submit:async payload=>reply(payload,settings)}});
  await toCount(narrow,{meal});
  assert.ok(narrow.query('[data-handoff-projected]').textContent.includes(new Intl.NumberFormat('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2}).format(server.totals.projectedCash)));
  assert.equal(narrow.query('[data-handoff-physical-input]').value,'');narrow.close();
}
console.log('PASS monthly food has no new daily deduction, earlier meals remain visible, and cash-limited bonus plus hybrid commission render the server’s exact totals');

let blockedSubmits=0;
const blocked=await openWizard({api:{pending:()=>null,preview:async options=>quote(options,{gross:3,bonus:0,carry:3,covered:true}),submit:async()=>{blockedSubmits++;}}});
await toCount(blocked);assert.match(blocked.query('[data-handoff-projected]').textContent,/0,00/);
await toConfirmation(blocked,'0');assert.equal(blocked.button('KONFIRMO DORËZIMIN').disabled,true);
blocked.button('KONFIRMO DORËZIMIN').click();assert.equal(blockedSubmits,0);blocked.close();
console.log('PASS a fully consumed cash balance cannot create a new handover even after an explicit zero count');

const retryIntent={actorId:actor.id,requestKey:'WH1:fixture-retry-key',snapshotHash:'c'.repeat(32),options:{mealChoice:'none',expenses:[]},physicalCash:25,differenceReason:'Prior count'};
let retries=0;
const retry=await openWizard({api:{pending:async()=>clone(retryIntent),preview:async()=>{throw new Error('Pending retry must not create a fresh preview');},submit:async(value,{retry:flag})=>{assert.equal(flag,true);assert.deepEqual(clone(value),retryIntent);retries++;return {...reply(value),replayed:true};}}});
assert.ok(retry.query('[data-handoff-pending-retry]'));assert.equal(retry.query('[data-handoff-step]'),null);
await retry.click('RIPROVO DORËZIMIN');await wait(()=>retry.query('[data-handoff-receipt]'));assert.equal(retries,1);retry.close();

let hasNewPayments=false;
const staleUi=await openWizard({api:{pending:()=>null,preview:async options=>quote(options,{gross:hasNewPayments?120:100}),submit:async()=>{hasNewPayments=true;throw new Error('WHW_SNAPSHOT_STALE');}}});
await toCount(staleUi);await toConfirmation(staleUi,'90');await staleUi.click('KONFIRMO DORËZIMIN');await wait(()=>staleUi.query('[role="alert"]'));
assert.equal(staleUi.query('[data-handoff-receipt]'),null);assert.match(staleUi.text(),/kanë ndryshuar/);
await staleUi.click('Rifresko llogaritjen');await wait(()=>staleUi.step()===3);await staleUi.click('VAZHDO');
assert.equal(staleUi.step(),4);assert.equal(staleUi.query('[data-handoff-physical-input]').value,'');assert.match(staleUi.query('[data-handoff-projected]').textContent,/110,00/);staleUi.close();
console.log('PASS pending durable request offers its exact retry, and stale review reloads authoritative amounts and forces a fresh physical count');

let oldResolve;let slowCalls=0;
const slowApi={pending:()=>null,preview:async options=>{slowCalls++;if(slowCalls===1)return new Promise(resolve=>{oldResolve=resolve;});return quote(options,{scope:otherActor,empty:true});},submit:async()=>{throw new Error('No submit expected');}};
const scopeBrowser=browser();const sw=scopeBrowser.w;sw.__props={open:true,actor:clone(actor),api:slowApi,onClose:()=>{}};sw.eval(wizardBundle);
await wait(()=>oldResolve,'old actor preview');sw.__render({...sw.__props,actor:clone(otherActor)});
await wait(()=>sw.document.querySelector('[data-handoff-step]'),'new actor empty preview');oldResolve(quote());
await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(sw.document.querySelector('[data-handoff-payment]'),null);assert.match(sw.document.body.textContent,/Another Fixture/);assert.doesNotMatch(sw.document.body.textContent,/Fixture Client One/);
assert.equal([...sw.document.querySelectorAll('button')].some(element=>element.textContent==='VAZHDO'),false);
scopeBrowser.close();
console.log('PASS switching workers discards late old-account data, and earlier pending handovers alone cannot be submitted as new collections');

let finishAfterSessionChange;let sessionSaved=0,sessionClosed=0;
const session=await openWizard({onSaved:()=>sessionSaved++,onClose:()=>sessionClosed++,api:{pending:()=>null,preview:async options=>quote(options),submit:async payload=>new Promise(resolve=>{finishAfterSessionChange=()=>resolve(reply(payload));})}});
await toCount(session);await toConfirmation(session,'90');await session.click('KONFIRMO DORËZIMIN');
await wait(()=>finishAfterSessionChange,'pending submit before session change');
session.w.dispatchEvent(new session.w.Event('tepiha:session-changed'));
await wait(()=>sessionClosed===1&&!session.query('[data-handoff-step]'),'session invalidation');
assert.equal(session.query('[data-handoff-step]'),null);assert.equal(session.query('[data-handoff-physical-input]'),null);assert.equal(session.query('[data-handoff-receipt]'),null);
assert.doesNotMatch(session.text(),/Fixture Client One/);
finishAfterSessionChange();await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(sessionSaved,0);assert.equal(session.query('[data-handoff-receipt]'),null);session.close();
console.log('PASS session-change event clears financial evidence immediately despite stale parent props, and a late successful submit cannot call the old account’s saved callback');
