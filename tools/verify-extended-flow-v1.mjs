import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { notificationSummary, mergeNotificationEvents, isReadyNotificationOrderId } from '../lib/readyNotificationModel.js';
import { canTrackReadyNotifications } from '../lib/roles.js';

let checks=0;const failures=[];
async function test(name,fn){try{await fn();checks++;}catch(e){failures.push(`${name}: ${e.message}`);}}
const searchSource=fs.readFileSync('lib/homeSearch.js','utf8').replace(/export /g,'');
const search=vm.createContext({URLSearchParams});vm.runInContext(searchSource,search);
await test('BASE code does not include another client with the same internal order ID',()=>{
  assert.equal(search.rowMatches({id:123,code:999,status:'gati',client_name:'Synthetic other client'},'123'),false);
  assert.equal(search.rowMatches({id:456,code:123,status:'gati',client_name:'Synthetic requested client'},'123'),true);
});
for(const query of ['000123','123']) await test(`permanent code ${query} includes repeat visits only for that client`,()=>{
  const fixtures=[{id:500,code:123},{id:600,code:123},{id:123,code:900}].map(row=>({...row,status:'pastrim'}));
  assert.deepEqual(fixtures.filter(row=>search.rowMatches(row,query)).map(row=>row.id),[500,600]);
});

const legacy='tepiha_ready_notifications_v1';
function memory(){const map=new Map();const storage={map,hook:null,get length(){return map.size;},key:i=>[...map.keys()][i]??null,getItem(k){const value=map.get(k)||null;if(storage.hook){const hook=storage.hook;storage.hook=null;hook(k);}return value;},setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};return storage;}
const worker={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic worker',role:'DISPATCH'};
function notificationTab(storage,{online=false,request=async()=>({}),user=worker}={}){
  const state={online,user,requests:0,events:0};
  const ctx=vm.createContext({
    canTrackReadyNotifications,isReadyNotificationOrderId,mergeNotificationEvents,readBestActor:()=>state.user,getDeviceId:()=>{},
    navigator:{get onLine(){return state.online;}},localStorage:storage,crypto:{randomUUID:crypto.randomUUID},
    Event:class{},window:{dispatchEvent(){state.events++;},addEventListener(){},setInterval(){}},document:{addEventListener(){}},
    approvedApiRequest:async(_url,body)=>{state.requests++;return request(body);},
  });
  vm.runInContext(fs.readFileSync('lib/readyNotifications.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,''),ctx);
  return {ctx,state};
}
const opening={orderId:'101',channel:'sms',kind:'opened'};
await test('simultaneous tabs preserve both offline notification attempts',()=>{
  const storage=memory();const a=notificationTab(storage),b=notificationTab(storage);
  storage.hook=()=>b.ctx.recordReadyNotification({...opening,orderId:'102'});
  a.ctx.recordReadyNotification(opening);
  const events=notificationTab(storage).ctx.localNotifications();
  assert.equal(events.length,2);assert.equal(new Set(events.map(e=>e.order_id)).size,2);
});
await test('late local write never restores pending after server acknowledgement',()=>{
  const storage=memory();const tab=notificationTab(storage);tab.ctx.recordReadyNotification(opening);
  const stale=tab.ctx.localNotifications();tab.ctx.write(stale.map(e=>({...e,pending:false})));tab.ctx.write(stale);
  assert.equal(tab.ctx.localNotifications()[0].pending,false);
});
for(const changed of [{id:crypto.randomUUID()},{order_id:'999'},{channel:'viber'},{kind:'confirmed'},{actor_id:'other'},{attempt_id:crypto.randomUUID()}]) await test('mismatched acknowledgement preserves original pending intent',async()=>{
  const storage=memory();const tab=notificationTab(storage,{request:async body=>({event:{...body,...changed}})});
  const event=tab.ctx.recordReadyNotification(opening);tab.state.online=true;await tab.ctx.flushReadyNotifications();
  const rows=tab.ctx.localNotifications();assert.equal(rows.length,1);assert.equal(rows[0].id,event.id);assert.equal(rows[0].pending,true);assert(rows[0].sync_error);
});
await test('missing acknowledgement never invents a saved event',async()=>{
  const storage=memory();const tab=notificationTab(storage);tab.ctx.recordReadyNotification(opening);tab.state.online=true;await tab.ctx.flushReadyNotifications();
  const rows=tab.ctx.localNotifications();assert.equal(rows.length,1);assert.equal(rows[0].pending,true);assert(rows[0].sync_error);
});
await test('legacy events migrate with identifiers and unsent payload intact',()=>{
  const storage=memory();const event={id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),order_id:'101',actor_id:worker.id,viewer_id:worker.id,channel:'sms',kind:'opened',pending:true};
  storage.setItem(legacy,JSON.stringify([event]));const tab=notificationTab(storage);assert.equal(tab.ctx.localNotifications()[0].id,event.id);tab.ctx.recordReadyNotification({...opening,orderId:'102'});
  const restarted=notificationTab(storage);assert.equal(restarted.ctx.localNotifications().length,2);assert.equal(restarted.ctx.localNotifications().find(e=>e.id===event.id).pending,true);
});
await test('migration storage failure preserves legacy backup and retries safely',()=>{
  const storage=memory();const event={id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),order_id:'101',actor_id:worker.id,viewer_id:worker.id,channel:'sms',kind:'opened',pending:true};
  const backup=JSON.stringify([event]);storage.setItem(legacy,backup);const write=storage.setItem;storage.setItem=()=>{throw new Error('QuotaExceededError');};
  const tab=notificationTab(storage);assert.throws(()=>tab.ctx.localNotifications(),/Quota/);assert.equal(storage.getItem(legacy),backup);
  storage.setItem=write;assert.equal(tab.ctx.localNotifications().length,1);
});
await test('lost response and reload preserve ordered opened/confirmed replay exactly once',async()=>{
  const storage=memory(),server=new Map();let lose=true;
  const request=async body=>{if(!server.has(body.id))server.set(body.id,{...body});if(lose){lose=false;throw new Error('Load failed after commit');}return {event:server.get(body.id)};};
  let tab=notificationTab(storage,{request});const opened=tab.ctx.recordReadyNotification(opening);tab.ctx.recordReadyNotification({...opening,kind:'confirmed',attemptId:opened.attempt_id});
  tab.state.online=true;await tab.ctx.flushReadyNotifications();assert.equal(server.size,1);
  tab=notificationTab(storage,{online:true,request});await tab.ctx.flushReadyNotifications();assert.equal(server.size,2);assert.equal(tab.ctx.localNotifications().filter(e=>e.pending).length,0);assert.equal(notificationSummary(tab.ctx.localNotifications()).kind,'confirmed');
});
await test('actor switch during acknowledgement leaves work isolated for original actor',async()=>{
  let release;const storage=memory();const tab=notificationTab(storage,{request:body=>new Promise(resolve=>{release=()=>resolve({event:body});})});
  tab.ctx.recordReadyNotification(opening);tab.state.online=true;const pending=tab.ctx.flushReadyNotifications();await Promise.resolve();tab.state.user={...worker,id:'another-user'};release();await pending;
  assert.equal(tab.ctx.localNotifications().length,0);tab.state.user=worker;assert.equal(tab.ctx.localNotifications()[0].pending,true);
});
await test('unordered storage enumeration cannot send confirmation before its opened event',async()=>{
  const storage=memory();storage.key=i=>[...storage.map.keys()].reverse()[i]??null;
  const server=new Map();const tab=notificationTab(storage,{request:async body=>{
    if(body.kind!=='opened'&&![...server.values()].some(e=>e.attempt_id===body.attempt_id&&e.kind==='opened')) throw Object.assign(new Error('READY_NOTIFICATION_ATTEMPT_PENDING'),{httpStatus:409});
    server.set(body.id,body);return {event:body};
  }});
  const opened=tab.ctx.recordReadyNotification(opening);tab.ctx.recordReadyNotification({...opening,kind:'confirmed',attemptId:opened.attempt_id});
  tab.state.online=true;await tab.ctx.flushReadyNotifications();assert.equal(server.size,2);assert.equal(tab.ctx.localNotifications().filter(e=>e.pending).length,0);
});
await test('partial migration failure preserves all original events on recovery',()=>{
  const storage=memory();const events=[101,102].map(order=>({id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),order_id:String(order),actor_id:worker.id,viewer_id:worker.id,kind:'opened',channel:'sms',pending:true}));
  const backup=JSON.stringify(events);storage.setItem(legacy,backup);let writes=0;const write=storage.setItem;storage.setItem=(key,value)=>{if(++writes===2)throw new Error('QuotaExceededError');write(key,value);};
  const tab=notificationTab(storage);assert.throws(()=>tab.ctx.localNotifications(),/Quota/);assert.equal(storage.getItem(legacy),backup);
  storage.setItem=write;const restored=tab.ctx.localNotifications();assert.equal(restored.length,2);assert.equal(new Set(restored.map(e=>e.id)).size,2);assert(restored.every(e=>e.pending));
});
await test('two actors can cache the same server event without overwriting visibility',()=>{
  const storage=memory();const a=notificationTab(storage),b=notificationTab(storage,{user:{...worker,id:'viewer-b'}});
  const event=a.ctx.recordReadyNotification(opening);
  a.ctx.write([{...event,pending:false}]);b.ctx.write([{...event,pending:false,viewer_id:'viewer-b'}]);
  assert.equal(a.ctx.localNotifications().length,1);assert.equal(b.ctx.localNotifications().length,1);assert.equal(a.ctx.localNotifications()[0].viewer_id,worker.id);
});
await test('100 offline events survive restart and replay without duplicate server events',async()=>{
  const storage=memory(),server=new Map();const request=async body=>{server.set(body.id,body);return {event:body};};
  let tab=notificationTab(storage,{request});for(let i=0;i<100;i++)tab.ctx.recordReadyNotification({...opening,orderId:String(1000+i)});
  tab=notificationTab(storage,{online:true,request});assert.equal(tab.ctx.localNotifications().length,100);await tab.ctx.flushReadyNotifications();await tab.ctx.flushReadyNotifications();assert.equal(server.size,100);assert.equal(tab.state.requests,100);assert(tab.ctx.localNotifications().every(e=>e.pending===false));
});
if(failures.length){console.error(failures.join('\n'));console.error(`${checks} passed; ${failures.length} failed`);process.exitCode=1;}else console.log(`PASS extended flow verification: ${checks} behavioral checks`);
