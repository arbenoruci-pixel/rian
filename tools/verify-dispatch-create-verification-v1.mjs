import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDispatchOutbox, DISPATCH_OUTBOX_KEY, DISPATCH_OUTBOX_ITEM_PREFIX } from '../lib/dispatchOutbox.js';
const source = fs.readFileSync('app/dispatch/page.jsx','utf8');
const helpers = source.slice(source.indexOf('function normalizeDispatchPickupM2('), source.indexOf('function emptyDispatchPasteResult('));
const build = vm.runInNewContext(helpers + '; buildDispatchPickupPlan');
const cases = [ ['1', [1]], ['6', [6]], ['5.8, 5.8', [5.8,5.8]], ['5.8 5.8', [5.8,5.8]],
  ['5.8,5.8',[5.8,5.8]], ['1; 5.8; 6',[1,5.8,6]], ['5,8; 6,2',[5.8,6.2]], ['1, 2, 3',[1,2,3]], ['1,2,3',[1,2,3]] ];
for (const [input, expected] of cases) {
  const plan = JSON.parse(JSON.stringify(build({measurementsText:input, piecesHint:20})));
  assert.deepEqual(plan.measurements_m2, expected, input);
  assert.equal(plan.pieces, expected.length, input);
  assert.equal(plan.m2_total, Math.round(expected.reduce((a,b)=>a+b,0)*100)/100);
}
for (const input of ['0','-1','81','1; 0','abc','5.8 wrong']) assert.throws(()=>build({measurementsText:input}), /MASAT NUK U LEXUAN/, input);
assert.equal(build({measurementsText:'3 tepiha'}).pieces,3);
assert.equal(build({noteText:'Telefon 044123456; ora 09:00; 3 tepiha'}).m2_total,0);
function memory() { const data=new Map(); return {get length(){return data.size;},key:i=>[...data.keys()][i]??null,
 getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}; }
const actor='22222222-2222-4222-8222-222222222222';
const uuid=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const payload=n=>({id:uuid(n),client_phone:`1202555${String(n).padStart(4,'0')}`,client_name:'TEST',data:{note:'original',pickup_plan:{pieces:1,measurements_m2:[1]}}});
const common=storage=>({storage,getActorId:()=>actor,now:()=>1000,online:()=>false,submit:()=>assert.fail('offline')});
// Deterministically interleave two tabs at the storage write. Different orders survive.
{
 const storage=memory(), set=storage.setItem; let interleave=true;
 const a=createDispatchOutbox(common(storage)),b=createDispatchOutbox(common(storage));
 storage.setItem=(key,value)=>{if(interleave){interleave=false;b.enqueue(payload(2));}set(key,value);};
 a.enqueue(payload(1));
 assert.deepEqual(a.list().map(x=>x.id).sort(),[uuid(1),uuid(2)]);
}
// All 100 independent offline orders survive reopening, commit once, and are not resent.
{
 const storage=memory(); const q=createDispatchOutbox(common(storage));
 for(let i=1;i<=100;i++)q.enqueue(payload(i));
 let calls=0; const restored=createDispatchOutbox({...common(storage),online:()=>true,submit:async p=>{calls++;return {ok:true,data:{id:p.id,client_tcode:'T'+calls}};}});
 await restored.drain();await restored.drain();assert.equal(calls,100);assert.equal(restored.list().filter(x=>x.state==='sent').length,100);
}
// 100 timeouts, with a reload halfway through, retain the identical payload and UUID.
{
 const storage=memory();let time=1000,calls=0;const bodies=[];
 const options={...common(storage),online:()=>true,now:()=>time,submit:async p=>{bodies.push(JSON.stringify(p));calls++;return calls<=100?{ok:false,error:'DISPATCH_ORDER_API_TIMEOUT'}:{ok:true,data:{id:p.id,client_tcode:'T1'}};}};
 let q=createDispatchOutbox(options);q.enqueue(payload(1));
 for(let i=0;i<=100;i++){await q.drain();time+=30001;if(i===50)q=createDispatchOutbox(options);}
 assert.equal(q.list()[0].state,'sent');assert.equal(calls,101);assert.equal(new Set(bodies).size,1);
}
// Migration retains payloads, UUIDs and attempts; partial migration failure preserves v1.
{
 const storage=memory();const q=createDispatchOutbox(common(storage));q.enqueue(payload(1));q.enqueue(payload(2));
 const items=q.list();for(const i of items)storage.removeItem(DISPATCH_OUTBOX_ITEM_PREFIX+i.id);
 const legacy=JSON.stringify({version:1,items});storage.setItem(DISPATCH_OUTBOX_KEY,legacy);
 const set=storage.setItem;storage.setItem=(key,value)=>{if(key===DISPATCH_OUTBOX_ITEM_PREFIX+uuid(2))throw Error('quota');set(key,value);};
 assert.throws(()=>q.list(),/quota/);assert.equal(storage.getItem(DISPATCH_OUTBOX_KEY),legacy);
 storage.setItem=set;assert.deepEqual(q.list(),items);assert.equal(storage.getItem(DISPATCH_OUTBOX_KEY),null);
}
console.log('PASS Dispatch create: measurement regressions, interleaved tabs, 100 offline orders, 100 timeouts/reload with identical intent, migration recovery.');
