import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { notificationSummary, mergeNotificationEvents } from '../lib/readyNotificationModel.js';
import { normalizeReadyNotification, readyNotificationServer } from '../lib/readyNotificationServer.js';
const actor = {id:'11111111-1111-4111-8111-111111111111',name:'Test worker',role:'PUNTOR'};
const base = {id:'22222222-2222-4222-8222-222222222222',attempt_id:'33333333-3333-4333-8333-333333333333',order_id:'1185',actor_id:actor.id,channel:'sms',kind:'opened',occurred_at:'2026-09-11T10:00:00.000Z'};
assert.equal(normalizeReadyNotification({...base,author_name:'Forged'},actor).author_name,actor.name);
assert.throws(()=>normalizeReadyNotification({...base,actor_id:'other'},actor),/ACTOR_SESSION_MISMATCH/);
assert.throws(()=>normalizeReadyNotification(base,{...actor,role:'TRANSPORT'}),/ROLE_DENIED/);
assert.throws(()=>normalizeReadyNotification({...base,channel:'email'},actor),/EVENT_INVALID/);
assert.equal(notificationSummary([base]).kind,'opened');
const confirmed={...base,id:'c',kind:'confirmed',occurred_at:'2026-09-11T10:01:00Z'};
assert.equal(notificationSummary([confirmed,base]).kind,'confirmed');
assert.equal(notificationSummary([confirmed,{...base,id:'d',attempt_id:'another',occurred_at:'2026-09-11T10:02:00Z'}]).kind,'confirmed');
assert.equal(notificationSummary([confirmed,{...confirmed,id:'d',kind:'cancelled',occurred_at:'2026-09-11T10:02:00Z'}]).kind,'cancelled');
assert.equal(mergeNotificationEvents([base],[{...base,pending:false}]).length,1);
// Execute the actual persistence/replay implementation with browser dependencies.
const storage=new Map(); let online=false, requests=0, loggedActor=actor, rejectNetwork=false, denied=false, loseReply=false;
const server=new Map(); let id=10;
const ctx=vm.createContext({
  readBestActor:()=>loggedActor,getDeviceId:()=>{},mergeNotificationEvents,
  window:{dispatchEvent(){},addEventListener(){},setInterval(){}},Event:class{},document:{addEventListener(){}},
  navigator:{get onLine(){return online;}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(id++).padStart(12,'0')}`},
  AbortController,setTimeout,clearTimeout,
  fetch:async(_,options)=>{requests++; const body=JSON.parse(options.body);
    if(denied)return {ok:false,status:403,json:async()=>({ok:false,error:'DEVICE_NOT_APPROVED'})};
    if(rejectNetwork)throw new Error('Load failed');
    if(!server.has(body.id))server.set(body.id,{...body,created_at:body.occurred_at});
    if(loseReply){loseReply=false;throw new Error('Load failed after commit');}
    return {ok:true,json:async()=>({ok:true,event:server.get(body.id)})};
  }
});
const source=fs.readFileSync('lib/readyNotifications.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
vm.runInContext(source,ctx);
const opened=ctx.recordReadyNotification({orderId:'1185',channel:'sms',kind:'opened'});
ctx.recordReadyNotification({orderId:'1185',channel:'sms',kind:'confirmed',attemptId:opened.attempt_id});
assert.equal(requests,0);assert.equal(JSON.parse(storage.values().next().value).length,2);
loggedActor={...actor,id:'another'};online=true;await ctx.flushReadyNotifications();assert.equal(requests,0);
loggedActor=actor;rejectNetwork=true;await ctx.flushReadyNotifications();assert.equal(ctx.localNotifications().filter(e=>e.pending).length,2);
rejectNetwork=false;denied=true;await ctx.flushReadyNotifications();assert.equal(server.size,0);
denied=false;loseReply=true;await ctx.flushReadyNotifications();assert.equal(server.size,1);assert.equal(ctx.localNotifications().filter(e=>e.pending).length,2);await ctx.flushReadyNotifications();assert.equal(server.size,2);assert.equal(ctx.localNotifications().filter(e=>e.pending).length,0);
await ctx.flushReadyNotifications();assert.equal(server.size,2);
// No silent success or app handoff if storage is full or corrupt.
ctx.localStorage.setItem=()=>{throw new Error('QuotaExceededError');};
assert.throws(()=>ctx.recordReadyNotification({orderId:'1185',channel:'sms',kind:'opened'}),/Quota/);
ctx.localStorage.getItem=()=>'{broken';assert.throws(()=>ctx.localNotifications());
// API always authorizes before any database call.
await assert.rejects(readyNotificationServer({action:'GET_READY_NOTIFICATIONS',order_ids:['1185']},{authUser:null,supabase:{from(){assert.fail();}}}),/AUTH_REQUIRED/);
console.log('PASS ready notifications: honest status, worker identity, immutable events, offline persistence, actor isolation, network/auth retention, replay and storage failures.');
// Exercise server insertion, replay conflict and ownership of opened attempts.
const savedEvents=[];
const sb={from(name){
  assert(['orders','ready_notification_events'].includes(name));
  const filters=[];let inserting=null,single=false;
  const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},in(k,v){filters.push([k,v]);return q;},order(){return q;},limit(){return q;},single(){single=true;return q;},maybeSingle(){single=true;return q;},insert(e){inserting=e;return q;},then(resolve){
    if(name==='orders')return Promise.resolve({data:{id:1185}}).then(resolve);
    if(inserting){if(savedEvents.some(e=>e.id===inserting.id))return Promise.resolve({error:{code:'23505'}}).then(resolve);savedEvents.push({...inserting});return Promise.resolve({data:inserting}).then(resolve);}
    const result=savedEvents.filter(e=>filters.every(([k,v])=>Array.isArray(v)?v.includes(String(e[k])):String(e[k])===String(v)));
    return Promise.resolve({data:single?result[0]||null:result}).then(resolve);
  }};return q;
}};
const args={supabase:sb,authUser:actor};
await readyNotificationServer({...base,action:'ADD_READY_NOTIFICATION'},args);
await readyNotificationServer({...base,action:'ADD_READY_NOTIFICATION'},args);assert.equal(savedEvents.length,1);
await assert.rejects(readyNotificationServer({...base,channel:'viber',action:'ADD_READY_NOTIFICATION'},args),/RETRY_CONFLICT/);
await assert.rejects(readyNotificationServer({...base,id:'44444444-4444-4444-8444-444444444444',attempt_id:'55555555-5555-4555-8555-555555555555',kind:'confirmed',action:'ADD_READY_NOTIFICATION'},args),/ATTEMPT_PENDING/);
await readyNotificationServer({...base,id:'44444444-4444-4444-8444-444444444444',kind:'confirmed',action:'ADD_READY_NOTIFICATION'},args);
assert.equal(savedEvents.length,2);
console.log('PASS notification server replay, conflict rejection and confirmation ownership.');
