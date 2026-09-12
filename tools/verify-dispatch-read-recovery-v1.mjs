import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createDispatchListLoader } from '../lib/dispatchList.js';
import { watchDispatchPhoneCheck } from '../lib/dispatchPhoneCheck.js';
import { createDispatchOutbox } from '../lib/dispatchOutbox.js';
import { createDispatchOutboxStorage } from '../lib/dispatchOutboxStorage.js';
import { IDBFactory } from 'fake-indexeddb';
import { fetchJsonWithDeadline } from '../lib/boundedRequest.js';
import { listDispatchTransportOrdersServer } from '../lib/transport/dispatchOrderServer.js';

const actor='22222222-2222-4222-8222-222222222222', other='33333333-3333-4333-8333-333333333333';
const id=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const row=(n,status='assigned',second=1)=>({id:id(n),status,client_tcode:'T'+n,client_name:'SYNTHETIC TEST',client_phone:'12025550001',updated_at:`2026-09-12T14:00:${String(second).padStart(2,'0')}Z`,data:{status}});
const failure=code=>Object.assign(new Error(code),{code});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
let passed=0;
async function test(name,work){await work();passed++;console.log('PASS '+name);}
function fixture(fetchRows,options={}) {
  let rows=[],busy=false,actorId=actor,online=true,next=0;
  const timers=new Map(),errors=[];
  const loader=createDispatchListLoader({fetchRows,onRows:update=>{rows=update(rows);},onBusy:value=>{busy=value;},onError:error=>errors.push(error),getActorId:()=>actorId,available:()=>online,
    setTimer:(run,delay)=>{timers.set(++next,{run,delay});return next;},clearTimer:id=>timers.delete(id),...options});
  return {loader,timers,errors,get rows(){return rows;},get busy(){return busy;},actor(value){actorId=value;},online(value){online=value;},
    async tick(){const [id,timer]=timers.entries().next().value;timers.delete(id);await timer.run();await loader.refresh();}};
}
await test('a confirmed create stays in the list when the refresh fails',async()=>{
  const f=fixture(async()=>{throw failure('DISPATCH_LIST_TIMEOUT');});
  f.loader.record(row(1));await f.loader.refresh();
  assert.equal(f.rows[0].client_tcode,'T1');assert.equal(f.rows[0].status,'assigned');assert.equal(f.busy,false);assert.equal(f.timers.size,1);f.loader.stop();
});
await test('an older in-flight list cannot erase a newly confirmed order',async()=>{
  const read=deferred(),started=deferred();
  const f=fixture(()=>{started.resolve();return read.promise;});
  const pending=f.loader.refresh();await started.promise;f.loader.record(row(1));read.resolve([]);await pending;
  assert.equal(f.rows[0].id,id(1));f.loader.stop();
});
await test('a late restored receipt cannot replace a newer confirmed edit',async()=>{
  const read=deferred(),started=deferred();const f=fixture(()=>{started.resolve();return read.promise;});
  const pending=f.loader.refresh();await started.promise;
  f.loader.record(row(1,'pickup',2));f.loader.record(row(1,'assigned',1));read.resolve([row(1)]);await pending;
  assert.equal(f.rows[0].status,'pickup');f.loader.stop();
});
await test('a refresh requested during another read runs once afterward',async()=>{
  const read=deferred(),started=deferred();let calls=0;
  const f=fixture(()=>{calls++;if(calls===1){started.resolve();return read.promise;}return Promise.resolve([row(1)]);});
  const first=f.loader.refresh();await started.promise;
  const second=f.loader.refresh();f.loader.refresh();f.loader.record(row(1));read.resolve([]);await Promise.all([first,second]);
  assert.equal(calls,2);assert.equal(f.rows.length,1);f.loader.stop();
});
await test('a newer server status wins over a saved confirmation and absent rows can be removed',async()=>{
  let snapshot=[row(1,'pickup',2)];const f=fixture(async()=>snapshot);
  f.loader.record(row(1));await f.loader.refresh();assert.equal(f.rows[0].status,'pickup');
  f.loader.record(row(1));assert.equal(f.rows[0].status,'pickup');
  snapshot=[];await f.loader.refresh();assert.equal(f.rows.length,0);f.loader.stop();
});
await test('temporary list failure recovers automatically without clearing confirmed rows',async()=>{
  let calls=0;const f=fixture(async()=>{if(++calls===1)throw failure('DISPATCH_LIST_FAILED');return[row(1),row(2)];});
  f.loader.record(row(1));await f.loader.refresh();assert.equal(f.rows.length,1);
  await f.tick();assert.equal(f.rows.length,2);assert.equal(f.errors.at(-1),null);f.loader.stop();
});
await test('a hung list releases its busy state on the deadline',async()=>{
  const f=fixture(()=>new Promise(()=>{}),{timeoutMs:15});await f.loader.refresh();
  assert.equal(f.busy,false);assert.equal(f.errors.at(-1).code,'DISPATCH_LIST_TIMEOUT');f.loader.stop();
});
await test('actor changes discard late list data and previous actor receipts',async()=>{
  const read=deferred(),started=deferred();let calls=0;
  const f=fixture(()=>{if(++calls===1){started.resolve();return read.promise;}return[];});
  const pending=f.loader.refresh();await started.promise;f.actor(other);read.resolve([row(1)]);await pending;
  f.loader.record(row(2),actor);assert.deepEqual(f.rows,[]);f.loader.stop();
});
await test('hard auth failure remains explicit without automatic retry',async()=>{
  const f=fixture(async()=>{throw failure('DEVICE_NOT_APPROVED');});await f.loader.refresh();
  assert.equal(f.timers.size,0);assert.equal(f.errors[0].code,'DEVICE_NOT_APPROVED');f.loader.stop();
});
await test('unmount cancels list work and late replies cannot update the page',async()=>{
  const read=deferred(),started=deferred();let signal;
  const f=fixture((_actor,input)=>{signal=input;started.resolve();return read.promise;});
  const pending=f.loader.refresh();await started.promise;f.loader.stop();assert.equal(signal.aborted,true);
  read.resolve([row(1)]);await pending;assert.deepEqual(f.rows,[]);assert.equal(f.errors.length,0);
});
await test('a confirmed order survives reopening IndexedDB and seeds the list offline',async()=>{
  const indexedDB=new IDBFactory(),localStorage={getItem:()=>null,length:0};
  const storage=()=>createDispatchOutboxStorage({indexedDB,localStorage});
  let queue=createDispatchOutbox({storage:storage(),getActorId:()=>actor,submit:async()=>({ok:true,data:row(1)})});
  await queue.enqueue({id:id(1),client_name:'SYNTHETIC TEST',client_phone:'12025550001'});await queue.send(id(1));
  queue=createDispatchOutbox({storage:storage(),getActorId:()=>actor,online:()=>false,submit:()=>assert.fail('offline')});
  const restored=await queue.list(),f=fixture(()=>assert.fail('offline read'));f.online(false);
  for(const item of restored)f.loader.record(item.confirmedOrder,item.actorId);
  await f.loader.refresh();assert.equal(f.rows[0].client_tcode,'T1');f.loader.stop();
});
function phoneFixture(inspect){
  const events=new EventTarget(),visibility=new EventTarget();visibility.hidden=false;let next=0;
  const timers=new Map(),results=[];
  const stop=watchDispatchPhoneCheck({inspect,onResult:r=>results.push(r),onError:()=>{},onBusy:()=>{},events,visibility,online:()=>true,
    setTimer:(run,delay)=>{timers.set(++next,{run,delay});return next;},clearTimer:id=>timers.delete(id)});
  return{timers,results,stop,async tick(){const[id,timer]=timers.entries().next().value;timers.delete(id);await timer.run();}};
}
await test('phone lookup recovers without an online/focus event after the quick retries fail',async()=>{
  let calls=0;const f=phoneFixture(async()=>{if(++calls<=3)throw failure('DISPATCH_PHONE_CHECK_NETWORK_FAILED');return{client:{tcode:'T1'}};});
  await f.tick();await f.tick();await f.tick();assert.equal([...f.timers.values()][0].delay,15000);
  await f.tick();assert.equal(f.results[0].client.tcode,'T1');assert.equal(f.timers.size,0);f.stop();
});
await test('changing the phone aborts the old lookup even if its response never arrives',async()=>{
  const started=deferred();let signal;
  const f=phoneFixture(input=>{signal=input;started.resolve();return new Promise(()=>{});});
  const pending=f.tick();await started.promise;f.stop();await pending;
  assert.equal(signal.aborted,true);assert.equal(f.results.length,0);
});
await test('caller cancellation reaches fetch and releases a hung response body',async()=>{
  const original=globalThis.fetch,started=deferred();let signal;
  globalThis.fetch=async(_url,init)=>{signal=init.signal;started.resolve();return{json:()=>new Promise(()=>{})};};
  try{const caller=new AbortController(),pending=fetchJsonWithDeadline('/fixture',{signal:caller.signal},1000);await started.promise;caller.abort();
    await assert.rejects(pending,/REQUEST_CANCELLED/);assert.equal(signal.aborted,true);
  }finally{globalThis.fetch=original;}
});
await test('the list server fixes its scope and rejects unauthorized actors before querying',async()=>{
  const authUser={id:actor,pin:'1234',role:'DISPATCH'},calls=[];
  const q={select(value){calls.push(['select',value]);return q;},order(...args){calls.push(['order',...args]);return q;},limit(value){calls.push(['limit',value]);return Promise.resolve({data:[row(1)]});}};
  const supabase={from(table){calls.push(['table',table]);return q;}};
  const result=await listDispatchTransportOrdersServer({expected_actor_id:actor,table:'users',limit:99999},{supabase,authUser});
  assert.equal(result.actorId,actor);assert.deepEqual(calls[0],['table','transport_orders']);assert.deepEqual(calls.at(-1),['limit',160]);
  for(const opts of [{supabase},{supabase,authUser:{...authUser,role:'TRANSPORT'}},{supabase,authUser:{...authUser,id:other}}]){
    const before=calls.length;await assert.rejects(listDispatchTransportOrdersServer({expected_actor_id:actor},opts));assert.equal(calls.length,before);
  }
});
await test('the actual API dispatches LIST through device authentication and never CREATE',async()=>{
  const source=transformSync(fs.readFileSync('api/transport/order.js','utf8'),{format:'cjs'}).code;
  let authenticated=0,listed=0,output;const module={exports:{}};
  class ServerError extends Error{}
  const helpers={readBody:async()=>({action:'LIST',expected_actor_id:actor}),createAdminClientOrThrow:()=>({}),apiOk:(_res,value)=>{output=value;},apiFail:(_res,value)=>{output=value;}};
  const server={DispatchOrderServerError:ServerError,authenticateDispatchOrderActor:async(_db,device)=>{assert.equal(device,'fixture-device');authenticated++;return{id:actor};},
    listDispatchTransportOrdersServer:async(_body,{authUser})=>{assert.equal(authUser.id,actor);listed++;return{items:[row(1)]};},createDispatchTransportOrderServer:()=>assert.fail('LIST became CREATE')};
  vm.runInNewContext(source,{module,exports:module.exports,Buffer,URL,console:{info:()=>{},error:()=>{}},require:name=>name.includes('_helpers')?helpers:name.includes('dispatchOrderServer')?server:{}});
  const handler=module.exports.default,res={setHeader:()=>{}};
  await handler({method:'POST',headers:{host:'fixture.test',origin:'https://fixture.test','content-type':'application/json',cookie:'tepiha_device_id=fixture-device'}},res);
  assert.equal(authenticated,1);assert.equal(listed,1);assert.equal(output.items[0].id,id(1));
  await handler({method:'POST',headers:{host:'fixture.test',origin:'https://other.test','content-type':'application/json'}},res);
  assert.equal(output,'ORIGIN_NOT_ALLOWED');assert.equal(listed,1);
});
await test('the list client forwards cancellation and rejects another actor response',async()=>{
  const source=transformSync(fs.readFileSync('lib/dispatchListApi.js','utf8'),{format:'cjs'}).code,module={exports:{}};
  const controller=new AbortController();let response={actorId:actor,items:[row(1)]};
  vm.runInNewContext(source,{module,exports:module.exports,require:()=>({approvedApiRequest:async(url,body,options)=>{
    assert.equal(url,'/api/transport/order');assert.equal(body.action,'LIST');assert.equal(body.expected_actor_id,actor);assert.equal(options.signal,controller.signal);return response;
  }})});
  const read=module.exports.readDispatchOrders;assert.equal((await read(actor,controller.signal))[0]._table,'transport_orders');
  response={actorId:other,items:[row(1)]};await assert.rejects(read(actor,controller.signal),/INVALID_RESPONSE/);
  response={actorId:actor,items:null};await assert.rejects(read(actor,controller.signal),/INVALID_RESPONSE/);
});
await test('the shipping page displays a committed event through a failed list refresh',async()=>{
  const source=fs.readFileSync('app/dispatch/page.jsx','utf8');
  const start=source.indexOf('  useEffect(() => {\n    let alive = true;\n    const committed');
  assert(start>0);
  const callback=source.slice(start+'  useEffect('.length,source.indexOf(', [loadRows, getRowsLoader]);',start));
  const f=fixture(async()=>{throw failure('DISPATCH_LIST_TIMEOUT');}),events=new EventTarget();let pending,message='NË PRITJE';
  const effect=vm.runInNewContext('('+callback+')',{window:events,getRowsLoader:()=>f.loader,loadRows:()=>{pending=f.loader.refresh();return pending;},
    createIntentJournalRef:{current:{clear:()=>{}}},getActor:()=>({id:actor}),setMsg:value=>{message=value;},getDispatchOutbox:()=>({list:async()=>[]}),reportDispatchDiagnostic:()=>{}});
  const cleanup=effect();events.dispatchEvent(new CustomEvent('tepiha:dispatch-order-committed',{detail:{id:id(1),actorId:actor,order:row(1)}}));
  await pending;assert.equal(f.rows[0].id,id(1));assert.equal(f.rows[0].status,'assigned');assert.match(message,/T1 U KONFIRMUA/);cleanup();f.loader.stop();
});
console.log(`${passed} passed: Dispatch read recovery v1`);
