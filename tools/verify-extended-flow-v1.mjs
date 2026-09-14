import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createReadyNotificationStorage, READY_NOTIFICATION_LEGACY_KEY, READY_NOTIFICATION_ITEM_PREFIX } from '../lib/readyNotificationStorage.js';
import { notificationSummary, mergeNotificationEvents, isReadyNotificationOrderId } from '../lib/readyNotificationModel.js';
import { canTrackReadyNotifications } from '../lib/roles.js';

let checks=0;const failures=[];
async function test(name,fn){try{await fn();checks++;}catch(e){failures.push(`${name}: ${e.message}`);}}
const searchSource=fs.readFileSync('lib/homeSearch.js','utf8').replace(/export /g,'');
const search=vm.createContext({URLSearchParams});vm.runInContext(searchSource,search);
await test('BASE code does not include another client with the same internal order ID',async()=>{
  assert.equal(search.rowMatches({id:123,code:999,status:'gati',client_name:'Synthetic other client'},'123'),false);
  assert.equal(search.rowMatches({id:456,code:123,status:'gati',client_name:'Synthetic requested client'},'123'),true);
});
for(const query of ['000123','123']) await test(`permanent code ${query} includes repeat visits only for that client`,async()=>{
  const fixtures=[{id:500,code:123},{id:600,code:123},{id:123,code:900}].map(row=>({...row,status:'pastrim'}));
  assert.deepEqual(fixtures.filter(row=>search.rowMatches(row,query)).map(row=>row.id),[500,600]);
});

const legacy='tepiha_ready_notifications_v1';
function memory(){const map=new Map();const storage={map,db:new IDBFactory(),hook:null,get length(){return map.size;},key:i=>[...map.keys()][i]??null,getItem(k){const value=map.get(k)||null;if(storage.hook){const hook=storage.hook;storage.hook=null;hook(k);}return value;},setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};return storage;}
const worker={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic worker',role:'DISPATCH'};
function notificationTab(storage,{online=false,request=async()=>({}),user=worker}={}){
  const state={online,user,requests:0,events:0};
  const ctx=vm.createContext({
    setTimeout,clearTimeout,
    createReadyNotificationStorage, READY_NOTIFICATION_LEGACY_KEY, READY_NOTIFICATION_ITEM_PREFIX, indexedDB:storage.db,
    canTrackReadyNotifications,isReadyNotificationOrderId,mergeNotificationEvents,readBestActor:()=>state.user,getDeviceId:()=>{},
    navigator:{get onLine(){return state.online;}},localStorage:storage,crypto:{randomUUID:crypto.randomUUID},
    Event:class{},window:{dispatchEvent(){state.events++;},addEventListener(){},setInterval(){}},document:{addEventListener(){}},
    approvedApiRequest:async(_url,body)=>{state.requests++;return request(body);},
  });
  vm.runInContext(fs.readFileSync('lib/readyNotifications.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,''),ctx);
  return {ctx,state};
}
const opening={orderId:'101',channel:'sms',kind:'opened'};
await test('simultaneous tabs preserve both offline notification attempts',async()=>{
  const storage=memory();const a=notificationTab(storage),b=notificationTab(storage);
  await Promise.all([a.ctx.recordReadyNotification(opening),b.ctx.recordReadyNotification({...opening,orderId:'102'})]);
  const events=await notificationTab(storage).ctx.localNotifications();
  assert.equal(events.length,2);assert.equal(new Set(events.map(e=>e.order_id)).size,2);
});
await test('late local write never restores pending after server acknowledgement',async()=>{
  const storage=memory();const tab=notificationTab(storage);await tab.ctx.recordReadyNotification(opening);
  const stale=(await tab.ctx.localNotifications());await tab.ctx.write(stale.map(e=>({...e,pending:false})));await tab.ctx.write(stale);
  assert.equal((await tab.ctx.localNotifications())[0].pending,false);
});
for(const changed of [{id:crypto.randomUUID()},{order_id:'999'},{channel:'viber'},{kind:'confirmed'},{actor_id:'other'},{attempt_id:crypto.randomUUID()}]) await test('mismatched acknowledgement preserves original pending intent',async()=>{
  const storage=memory();const tab=notificationTab(storage,{request:async body=>({event:{...body,...changed}})});
  const event=await tab.ctx.recordReadyNotification(opening);tab.state.online=true;await tab.ctx.flushReadyNotifications();
  const rows=(await tab.ctx.localNotifications());assert.equal(rows.length,1);assert.equal(rows[0].id,event.id);assert.equal(rows[0].pending,true);assert(rows[0].sync_error);
});
await test('missing acknowledgement never invents a saved event',async()=>{
  const storage=memory();const tab=notificationTab(storage);await tab.ctx.recordReadyNotification(opening);tab.state.online=true;await tab.ctx.flushReadyNotifications();
  const rows=(await tab.ctx.localNotifications());assert.equal(rows.length,1);assert.equal(rows[0].pending,true);assert(rows[0].sync_error);
});
await test('legacy events migrate with identifiers and unsent payload intact',async()=>{
  const storage=memory();const event={id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),order_id:'101',actor_id:worker.id,viewer_id:worker.id,channel:'sms',kind:'opened',pending:true};
  storage.setItem(legacy,JSON.stringify([event]));const tab=notificationTab(storage);assert.equal((await tab.ctx.localNotifications())[0].id,event.id);await tab.ctx.recordReadyNotification({...opening,orderId:'102'});
  const restarted=notificationTab(storage);assert.equal((await restarted.ctx.localNotifications()).length,2);assert.equal((await restarted.ctx.localNotifications()).find(e=>e.id===event.id).pending,true);
});
await test('full localStorage migrates legacy backup without rewriting Web Storage',async()=>{
  const storage=memory();const event={id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),order_id:'101',actor_id:worker.id,viewer_id:worker.id,channel:'sms',kind:'opened',pending:true};
  storage.setItem(legacy,JSON.stringify([event]));storage.setItem=()=>{throw new DOMException('The quota has been exceeded.','QuotaExceededError');};
  const tab=notificationTab(storage);assert.equal((await tab.ctx.localNotifications())[0].id,event.id);
  assert.equal(storage.getItem(legacy),null);
});
await test('lost response and reload preserve ordered opened/confirmed replay exactly once',async()=>{
  const storage=memory(),server=new Map();let lose=true;
  const request=async body=>{if(!server.has(body.id))server.set(body.id,{...body});if(lose){lose=false;throw new Error('Load failed after commit');}return {event:server.get(body.id)};};
  let tab=notificationTab(storage,{request});const opened=await tab.ctx.recordReadyNotification(opening);await tab.ctx.recordReadyNotification({...opening,kind:'confirmed',attemptId:opened.attempt_id});
  tab.state.online=true;await tab.ctx.flushReadyNotifications();assert.equal(server.size,1);
  tab=notificationTab(storage,{online:true,request});await tab.ctx.flushReadyNotifications();assert.equal(server.size,2);assert.equal((await tab.ctx.localNotifications()).filter(e=>e.pending).length,0);assert.equal(notificationSummary((await tab.ctx.localNotifications())).kind,'confirmed');
});
await test('actor switch during acknowledgement leaves work isolated for original actor',async()=>{
  let release;const storage=memory();const tab=notificationTab(storage,{request:body=>new Promise(resolve=>{release=()=>resolve({event:body});})});
  await tab.ctx.recordReadyNotification(opening);tab.state.online=true;const pending=tab.ctx.flushReadyNotifications();while(!release) await new Promise(resolve=>setTimeout(resolve,1));tab.state.user={...worker,id:'another-user'};release();await pending;
  assert.equal((await tab.ctx.localNotifications()).length,0);tab.state.user=worker;assert.equal((await tab.ctx.localNotifications())[0].pending,true);
});
await test('unordered storage enumeration cannot send confirmation before its opened event',async()=>{
  const storage=memory();storage.key=i=>[...storage.map.keys()].reverse()[i]??null;
  const server=new Map();const tab=notificationTab(storage,{request:async body=>{
    if(body.kind!=='opened'&&![...server.values()].some(e=>e.attempt_id===body.attempt_id&&e.kind==='opened')) throw Object.assign(new Error('READY_NOTIFICATION_ATTEMPT_PENDING'),{httpStatus:409});
    server.set(body.id,body);return {event:body};
  }});
  const opened=await tab.ctx.recordReadyNotification(opening);await tab.ctx.recordReadyNotification({...opening,kind:'confirmed',attemptId:opened.attempt_id});
  tab.state.online=true;await tab.ctx.flushReadyNotifications();assert.equal(server.size,2);assert.equal((await tab.ctx.localNotifications()).filter(e=>e.pending).length,0);
});
await test('interrupted IndexedDB migration preserves every original event for recovery',async()=>{
  const storage=memory();const events=[101,102].map(order=>({id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),order_id:String(order),actor_id:worker.id,viewer_id:worker.id,kind:'opened',channel:'sms',pending:true}));
  const backup=JSON.stringify(events);storage.setItem(legacy,backup);
  const put=IDBObjectStore.prototype.put;let writes=0;
  const tab=notificationTab(storage);
  try {
    IDBObjectStore.prototype.put=function(...args){if(++writes===2)throw new DOMException('The quota has been exceeded.','QuotaExceededError');return put.apply(this,args);};
    await assert.rejects(tab.ctx.localNotifications(),/quota/);assert.equal(storage.getItem(legacy),backup);
  } finally { IDBObjectStore.prototype.put=put; }
  const restored=await tab.ctx.localNotifications();assert.equal(restored.length,2);assert.equal(new Set(restored.map(e=>e.id)).size,2);assert(restored.every(e=>e.pending));
});
await test('two actors can cache the same server event without overwriting visibility',async()=>{
  const storage=memory();const a=notificationTab(storage),b=notificationTab(storage,{user:{...worker,id:'viewer-b'}});
  const event=await a.ctx.recordReadyNotification(opening);
  await a.ctx.write([{...event,pending:false}]);await b.ctx.write([{...event,pending:false,viewer_id:'viewer-b'}]);
  assert.equal((await a.ctx.localNotifications()).length,1);assert.equal((await b.ctx.localNotifications()).length,1);assert.equal((await a.ctx.localNotifications())[0].viewer_id,worker.id);
});
await test('100 offline events survive restart and replay without duplicate server events',async()=>{
  const storage=memory(),server=new Map();const request=async body=>{server.set(body.id,body);return {event:body};};
  let tab=notificationTab(storage,{request});for(let i=0;i<100;i++)await tab.ctx.recordReadyNotification({...opening,orderId:String(1000+i)});
  tab=notificationTab(storage,{online:true,request});assert.equal((await tab.ctx.localNotifications()).length,100);await tab.ctx.flushReadyNotifications();await tab.ctx.flushReadyNotifications();assert.equal(server.size,100);assert.equal(tab.state.requests,100);assert((await tab.ctx.localNotifications()).every(e=>e.pending===false));
});
if(failures.length){console.error(failures.join('\n'));console.error(`${checks} passed; ${failures.length} failed`);process.exitCode=1;}else console.log(`PASS extended flow verification: ${checks} behavioral checks`);
