import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { createDispatchOutbox, DISPATCH_OUTBOX_ITEM_PREFIX } from '../lib/dispatchOutbox.js';
import { createDispatchOutboxStorage } from '../lib/dispatchOutboxStorage.js';
const actor = '22222222-2222-4222-8222-222222222222';
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const payload = n => ({ id: id(n), client_name: 'SYNTHETIC TEST', client_phone: `1202555${String(n).padStart(4, '0')}`, data: { note: 'original' } });
function memory() { const map = new Map(); return { map, get length() { return map.size; }, key: n => [...map.keys()][n], getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) }; }
let passed = 0; const failed = [];
async function test(name, run) { try { await run(); passed++; console.log('PASS ' + name); } catch(e) { failed.push(name + ': ' + e.message); } }
await test('one corrupt old entry cannot prevent a new order from being saved', async () => {
  const storage = memory(); storage.setItem(DISPATCH_OUTBOX_ITEM_PREFIX + id(9), '{broken');
  const q = createDispatchOutbox({ storage, getActorId: () => actor, submit: async body => ({ ok:true, data:{id:body.id,code_str:'T1'} }) });
  assert.equal((await q.enqueue(payload(1))).id, id(1));
  await q.drain(); assert.equal((await q.list())[0].state, 'sent');
  assert.equal(storage.getItem(DISPATCH_OUTBOX_ITEM_PREFIX + id(9)), '{broken');
});
await test('a new order is sent while an earlier order is still waiting for its response', async () => {
  const storage = memory(); let started, release;
  const entered = new Promise(r => { started = r; }); const bodies = [];
  const q = createDispatchOutbox({ storage, getActorId: () => actor, submit: async body => {
    bodies.push(body.id); if (body.id === id(1)) { started(); await new Promise(r => { release = r; }); }
    return {ok:true,data:{id:body.id,code_str:'T1'}};
  } });
  await q.enqueue(payload(1)); const draining = q.drain(); await entered;
  await q.enqueue(payload(2));
  try { const sent = await q.send(id(2)); assert.equal(sent.state, 'sent'); assert.deepEqual(bodies, [id(1), id(2)]); }
  finally { release(); await draining; }
});
await test('server-confirmed creation stays confirmed if saving the receipt fails', async () => {
  const storage = memory(), set = storage.setItem; let confirmations = 0;
  storage.setItem = (key,value) => { if (JSON.parse(value)?.state === 'sent') throw Error('receipt storage failed'); set(key,value); };
  const q = createDispatchOutbox({ storage, getActorId:()=>actor,
    submit:async body=>({ok:true,data:{id:body.id,code_str:'T1'}}), onCommitted:()=>{confirmations++;} });
  await q.enqueue(payload(1)); await q.drain();
  assert.equal(confirmations,1); assert.equal((await q.list())[0].state,'sent');
  await q.drain(); assert.equal(confirmations,1);
});
await test('reading 100 saved orders takes a bounded number of IndexedDB transactions', async () => {
  const factory=new IDBFactory(); let transactions=0;
  const indexedDB={open(...args){const req=factory.open(...args);req.addEventListener('success',()=>{
    const db=req.result, tx=db.transaction.bind(db);db.transaction=(...params)=>{transactions++;return tx(...params);};
  });return req;}};
  const storage=createDispatchOutboxStorage({indexedDB,localStorage:memory()});
  const q=createDispatchOutbox({storage,getActorId:()=>actor,online:()=>false,submit:()=>assert.fail('offline')});
  for(let n=1;n<=100;n++)await q.enqueue(payload(n)); transactions=0;
  assert.equal((await q.list()).length,100); assert(transactions<=3, `${transactions} transactions for one list`);
  for(let n=1;n<=100;n++) {
    const key=DISPATCH_OUTBOX_ITEM_PREFIX+id(n), item=JSON.parse(await storage.getItem(key));
    await storage.setItem(key,JSON.stringify({...item,state:'sent',payload:null,updatedAt:1}));
  }
  transactions=0;
  assert.equal((await q.list()).length,0); assert(transactions<=3, `${transactions} transactions for expired receipt cleanup`);
});
await test('direct submit and background replay share one in-flight request', async () => {
  let release, started, calls=0;
  const entered=new Promise(r=>{started=r;});
  const q=createDispatchOutbox({storage:memory(),getActorId:()=>actor,submit:async body=>{
    calls++;started();await new Promise(r=>{release=r;});return {ok:true,data:{id:body.id,code_str:'T1'}};
  }});
  await q.enqueue(payload(1));const direct=q.send(id(1));await entered;const background=q.drain();
  release();await Promise.all([direct,background]);assert.equal(calls,1);
});
await test('a hung submit is released with its original durable request still pending', async () => {
  const q=createDispatchOutbox({storage:memory(),getActorId:()=>actor,submitTimeoutMs:20,submit:()=>new Promise(()=>{})});
  await q.enqueue(payload(1));const result=await q.send(id(1));
  assert.equal(result.state,'pending');assert.equal(result.error,'DISPATCH_ORDER_API_TIMEOUT');
  assert.equal((await q.list())[0].payload.id,id(1));
});
await test('IndexedDB timeout releases the form even if the abort event never arrives', async () => {
  let closed=0;
  const db={close(){closed++;},transaction(){return {objectStore:()=>({get:()=>({})}),abort(){}};}};
  const indexedDB={open(){const req={result:db};queueMicrotask(()=>req.onsuccess());return req;}};
  const storage=createDispatchOutboxStorage({indexedDB,localStorage:memory(),timeoutMs:20});
  await assert.rejects(storage.getItem('test'),/DISPATCH_ORDER_STORAGE_TIMEOUT/);assert.equal(closed,1);
});

// Execute the shipping click handler with real outbox persistence. These tests
// verify its acknowledgement/reset behavior, independently of browser rendering.
const page = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
const clickSource = page.slice(page.indexOf('  async function send() {'), page.indexOf('\n  useEffect(() => {\n    const committed'));
function formHarness({ submit, online = true, storage = memory() }) {
  const state = { busy: false, createOpen: true }, trace = [];
  const queue = createDispatchOutbox({ storage, getActorId: () => actor, online: () => online, submit });
  const context = {
    sendInFlightRef: { current: false }, canSend: true, smartCreateLiveFillStatus: {},
    confirmSmartCreateIncomplete: () => true,
    traceDispatchSubmission: () => ({ stage: value => trace.push(value), finish: value => trace.push(value) }),
    drivers: [], driverId: '', name: 'SYNTHETIC TEST', phone: '+1 202 555 0001', address: 'Test address', note: 'original',
    pickupMeasurements: '', smartPasteResult: {}, phoneHit: null, phoneCheckError: '',
    plannedDate: '2026-09-12', slot: 'morning', planMode: 'today',
    s: value => String(value || '').trim(), onlyDigits: value => String(value).replace(/\D/g, ''),
    getDispatchPhoneDigits: value => String(value).replace(/\D/g, ''),
    buildDispatchPickupPlan: () => ({ items: [], pieces: 1, m2_total: 0 }),
    getActor: () => ({ id: actor }), normTCode: value => value, tCodeNumber: () => null, slotWindow: () => '',
    createIntentJournalRef: { current: { acquire: async () => id(1), clear: () => {} } },
    getDispatchOutbox: () => queue, navigator: { onLine: online }, wakeDispatchOutbox: () => {},
    resetSmartCreateFillStatus: () => {},
  };
  for (const setter of clickSource.matchAll(/\b(set[A-Z]\w*)\(/g)) {
    const key = setter[1].slice(3); const field = key[0].toLowerCase() + key.slice(1);
    context[setter[1]] = value => { state[field] = value; };
  }
  return { state, trace, queue, send: vm.runInNewContext('(' + clickSource + ')', context) };
}
await test('the actual form waits for confirmation, blocks a double tap, and displays the server code', async () => {
  let release, started, calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const form = formHarness({ submit: async body => {
    calls++; started(); await new Promise(resolve => { release = resolve; });
    return { ok: true, data: { id: body.id, client_tcode: 'T123' } };
  } });
  const first = form.send(); await entered;
  assert.equal(form.state.busy, true); assert.equal(form.state.createOpen, true);
  assert.match(form.state.sendStage, /KONFIRMIMIN/);
  await form.send(); assert.equal(calls, 1);
  release(); await first;
  assert.equal(form.state.createOpen, false); assert.equal(form.state.busy, false);
  assert.match(form.state.msg, /T123 U KONFIRMUA NË SERVER/); assert.equal(form.trace.at(-1), 'sent');
});
await test('the actual form acknowledges offline persistence without claiming server confirmation', async () => {
  const form = formHarness({ online: false, submit: () => assert.fail('offline submit') });
  await form.send();
  assert.equal(form.state.createOpen, false); assert.match(form.state.msg, /NË PRITJE/);
  assert.equal((await form.queue.list())[0].payload.id, id(1)); assert.equal(form.trace.at(-1), 'pending');
});
await test('the actual form keeps a server-blocked order open for review', async () => {
  const form = formHarness({ submit: async () => ({ ok: false, error: 'DISPATCH_ORDER_ACTOR_SESSION_MISMATCH' }) });
  await form.send();
  assert.equal(form.state.createOpen, true); assert.equal(form.state.busy, false);
  assert.match(form.state.err, /KËRKON KONTROLL/); assert.equal(form.trace.at(-1), 'blocked');
});
await test('the actual form preserves input when the durable write fails and never submits it', async () => {
  const storage = memory(); storage.setItem = () => { throw Error('DISPATCH_ORDER_STORAGE_TIMEOUT'); };
  const form = formHarness({ storage, submit: () => assert.fail('unpersisted submit') });
  await form.send();
  assert.equal(form.state.createOpen, true); assert.equal(form.state.busy, false);
  assert.equal(form.state.name, undefined); assert.match(form.state.err, /NUK U RUAJT/);
  assert.equal(form.trace.at(-1), 'failed');
});
await test('the actual review-and-retry button sends its order during another slow request', async () => {
  const storage=memory(); let release, started;
  const entered=new Promise(resolve=>{started=resolve;});
  const q=createDispatchOutbox({storage,getActorId:()=>actor,submit:async body=>{
    if(body.id===id(1)){started();await new Promise(resolve=>{release=resolve;});}
    return {ok:true,data:{id:body.id,client_tcode:'T123'}};
  }});
  await q.enqueue(payload(1));await q.enqueue(payload(2));
  const key=DISPATCH_OUTBOX_ITEM_PREFIX+id(2);
  storage.setItem(key,JSON.stringify({...JSON.parse(storage.getItem(key)),state:'blocked',error:'DISPATCH_OUTBOX_REVIEW_REQUIRED'}));
  const draining=q.drain();await entered;
  const source=fs.readFileSync('components/DispatchSendQueue.jsx','utf8');
  const callback=source.slice(source.indexOf('onClick={async () => {')+'onClick={'.length,source.indexOf('}>KONTROLLOVA'));
  const retry=vm.runInNewContext('('+callback+')',{getDispatchOutbox:()=>q,item:{id:id(2)},wakeDispatchOutbox:()=>{},setError:assert.fail});
  try {await retry();assert.equal((await q.list()).find(item=>item.id===id(2)).state,'sent');}
  finally {release();await draining;}
});
if(failed.length){console.error(failed.join('\n'));process.exitCode=1;}
console.log(`${passed} passed; ${failed.length} failed: Dispatch submit confirmed v2`);
