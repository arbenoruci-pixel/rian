import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as notificationModel from '../lib/readyNotificationModel.js';
import { verifyAndStoreWebhook } from '../lib/ringOneWayServer.js';
import { canTrackReadyNotifications, canUseCustomerCare, canManageCustomerCare } from '../lib/roles.js';
import { customerCareFailure } from '../lib/customerCareErrors.js';
import { customerCareServer } from '../lib/customerCareServer.js';
import { fixtureActor, fixtureClient, fixtureDatabase } from './customer-care-fixtures.mjs';

let checks = 0;
const check = (condition, message) => { assert(condition, message); checks++; };
// No external requests, customer messages or production writes. The companion
// rollback SQL verifies the real Postgres conflict-index contract separately.
const events = new Map();
let storeError = null, writes = 0;
const ringDb = { from(table) {
  if (table === 'ring_app_credentials') {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({data:{client_id:'fixture',client_secret:'fixture',hmac_key:'fixture-hmac',token_encryption_key:'fixture'}}) };
    return q;
  }
  assert.equal(table, 'ring_webhook_events');
  return { upsert: async (row, opts) => {
    writes++;
    assert.deepEqual(opts, {onConflict:'request_id',ignoreDuplicates:true});
    if (storeError) return {error:storeError};
    const key = row.request_id || crypto.randomUUID();
    if (!events.has(key)) events.set(key,row);
    return {error:null};
  }};
}};
const signed = payload => {
  const rawBody = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return { supabase:ringDb, rawBody, signature:crypto.createHmac('sha256','fixture-hmac').update(rawBody).digest('hex') };
};
const request = signed({meta:{request_id:'synthetic-1'},data:{type:'motion'}});
await verifyAndStoreWebhook(request); await verifyAndStoreWebhook(request);
check(events.size===1,'replayed signed webhook stored once');
const before = writes;
await assert.rejects(verifyAndStoreWebhook({...request,signature:'forged'}),/SIGNATURE_INVALID/);
check(writes===before,'invalid signature never reaches event storage');
await assert.rejects(verifyAndStoreWebhook(signed('{invalid')),/JSON_INVALID/); checks++;
storeError = {code:'42P10',message:'private database detail'};
await assert.rejects(verifyAndStoreWebhook(request),e=>e.code==='RING_WEBHOOK_STORE_FAILED' && e.extra.dbCode==='42P10' && !JSON.stringify(e.extra).includes('private')); checks++;
storeError = {code:'23505',message:'duplicate on an unrelated constraint'};
await assert.rejects(verifyAndStoreWebhook(request),/STORE_FAILED/); checks++;
storeError = null;
await verifyAndStoreWebhook(signed({data:{type:'motion'}}));
await verifyAndStoreWebhook(signed({data:{type:'motion'}}));
check(events.size===3,'events without request ids remain distinct');

for (const role of ['ADMIN','ADMIN_MASTER','DISPATCH','OWNER','PRONAR','SUPERADMIN','MASTER']) {
  check(canTrackReadyNotifications(role) && canUseCustomerCare(role) && canManageCustomerCare(role),`${role}: same client/server capability`);
}
for (const role of ['PUNTOR','PUNETOR','WORKER','BAZIST','BASE']) {
  check(canTrackReadyNotifications(role) && !canUseCustomerCare(role,'order'),`${role}: no unsupported customer-care request`);
}
check(!canTrackReadyNotifications('TRANSPORT') && !canUseCustomerCare('TRANSPORT') && canUseCustomerCare('TRANSPORT','order'),'transport requires its assigned order and has no base notification history');
check(!canUseCustomerCare('unknown','order') && !canTrackReadyNotifications(''),'unknown roles fail closed');
await assert.rejects(customerCareServer({action:'GET_CUSTOMER_CARE',clientId:fixtureClient.id},{supabase:{from(){assert.fail('denied role queried database');}},authUser:{...fixtureActor,role:'PUNTOR'}}),/FORBIDDEN/); checks++;
const brokenDb = fixtureDatabase(), originalFrom = brokenDb.from.bind(brokenDb);
brokenDb.from = table => table === 'transport_clients' ? {select(){return this;},eq(){return this;},maybeSingle:async()=>({error:{code:'NETWORK'}})} : originalFrom(table);
await assert.rejects(customerCareServer({action:'GET_CUSTOMER_CARE',clientId:fixtureClient.id},{supabase:brokenDb,authUser:fixtureActor}),e=>e.message==='CUSTOMER_LOOKUP_FAILED' && e.httpStatus===503); checks++;
for (const status of [400,403,404,409]) check(customerCareFailure({code:'CUSTOMER_REJECTED',httpStatus:status}).rejected,'definite rejection releases editor');
for (const error of [new Error('Load failed'),{code:'AUTH_REQUIRED',httpStatus:401},{code:'DEVICE_NOT_APPROVED',httpStatus:403},{code:'CUSTOMER_LOOKUP_FAILED',httpStatus:503}]) check(!customerCareFailure(error).rejected,'ambiguous/auth failure preserves intent key');

// Render the shipping JSX with synthetic dependency boundaries. In particular,
// transport/local order IDs must not acquire a numeric-base-only handoff guard.
const require = createRequire(import.meta.url);
function component(file, overrides) {
  const compiled = transformSync(fs.readFileSync(file,'utf8'),{loader:'jsx',format:'cjs',jsx:'automatic'}).code;
  const module={exports:{}};
  vm.runInNewContext(compiled,{module,exports:module.exports,require:name=>overrides[name]||require(name)});
  return module.exports;
}
let uiActor={id:'synthetic-worker',role:'PUNTOR'};
const Care=component('components/CustomerCare.jsx',{
  '@/lib/approvedApiRequest':{approvedApiRequest:()=>assert.fail('render sent a request')},
  '@/lib/sessionStore':{readBestActor:()=>uiActor},
  '@/lib/roles':{canUseCustomerCare},'@/lib/customerCareErrors':{customerCareFailure},
}).default;
for (const [role,orderId,visible] of [['PUNTOR','fixture-order',false],['DISPATCH','',true],['TRANSPORT','',false],['TRANSPORT','fixture-order',true]]) {
  uiActor={id:'synthetic-worker',role};
  const html=renderToStaticMarkup(React.createElement(Care,{clientId:'fixture-client',orderId}));
  check(!!html===visible,`${role}: actual component respects order/role capability`);
}
let captured,recorded=0,tracking=true;
const Ready=component('components/ReadyNotification.jsx',{
  './SmartSmsModal':{default:props=>{captured=props;return React.createElement('div',null,props.children);},__esModule:true},
  '../lib/readyNotificationModel.js':notificationModel,
  '../lib/readyNotifications.js':{
    NOTIFICATION_CHANGE:'fixture-change',currentNotificationActorId:()=>uiActor.id,
    canUseReadyNotifications:()=>tracking,localNotifications:()=>[],fetchReadyNotifications:async()=>({}),
    recordReadyNotification:()=>{recorded++;return {id:'fixture'};},
  },
}).TrackedReadySmsModal;
for (const orderId of ['11111111-1111-4111-8111-111111111111','local-order','']) {
  renderToStaticMarkup(React.createElement(Ready,{isOpen:true,orderId}));
  check(captured.onAction===undefined,'transport/local SMS handoff is not blocked by base-only tracking');
}
renderToStaticMarkup(React.createElement(Ready,{isOpen:true,orderId:'123'}));
check(captured.onAction('sms')===true && recorded===1,'base SMS persists opened event before handoff');
tracking=false;renderToStaticMarkup(React.createElement(Ready,{isOpen:true,orderId:'123'}));
check(captured.onAction===undefined,'unsupported role can open message without false tracking');

// Exercise the actual diagnostic handler, including PostgREST resolved errors.
const incidentSource = fs.readFileSync('api/runtime-incident.js','utf8').replace(/^import .*;\n/gm,'').replace('export default ','');
for (const dbError of [null,{code:'23502',message:'private detail'}]) {
  let output, logged;
  const context=vm.createContext({
    readBody:async()=>({bootId:'synthetic-boot',currentPath:'/dispatch'}),
    createAdminClientOrThrow:()=>({from:()=>({insert:async()=>({error:dbError})})}),
    apiOk:(_res,data)=>{output=data;},apiFail:()=>assert.fail('diagnostics interrupted app'),
    console:{error:(_tag,data)=>{logged=data;}},
  });
  vm.runInContext(incidentSource,context);await context.handler({method:'POST'},{});
  check(output.stored===!dbError,'diagnostic persistence reflects actual database result');
  if(dbError)check(logged.code==='23502'&&!JSON.stringify(logged).includes('private'),'diagnostic failure observable without private context');
}

// Daily expense: execute the shipping click handler and durable intent store.
const expenseSource=fs.readFileSync('lib/dailyExpenseIntent.js','utf8').replace(/export /g,'');
const wizard=fs.readFileSync('components/ArkaDailyCloseWizard.jsx','utf8');
const expenseHandler=wizard.slice(wizard.indexOf('  async function createDailyExpense('),wizard.indexOf('  async function runServerCheck('));
const expenseStorage=new Map(),expenseLedger=new Map();let expenseCalls=0,loseExpenseReply=true,storageBlocked=false;
function expenseHarness(){
  const noop=()=>{};
  const ctx=vm.createContext({
    localStorage:{getItem:k=>expenseStorage.get(k)||null,setItem:(k,v)=>{if(storageBlocked)throw new Error('QuotaExceededError');expenseStorage.set(k,v);},removeItem:k=>expenseStorage.delete(k)},
    crypto:{randomUUID:crypto.randomUUID},actor:{id:'fixture-manager',pin:'fixture-pin'},newExpenseAmount:'1.25',newExpenseNote:'Synthetic expense',
    newExpenseIntentRef:{current:null},expenseMutationLockRef:{current:false},countedCashManualRef:{current:false},
    navigator:{onLine:true},parseMoneyInput:Number,withDeadline:fn=>fn(),EXPENSE_CREATE_RPC:'create_and_resolve_arka_expense_v2',
    setError:noop,setNewExpenseBusy:noop,setExpenseActionMessage:noop,setDryRun:noop,setFinalConfirm:noop,setCountedCash:noop,
    setNewExpenseAmount:noop,setNewExpenseNote:noop,setNewExpenseOpen:noop,loadPreview:async()=>{},money:n=>String(n),
    supabase:{rpc:async(name,payload)=>{expenseCalls++;assert.equal(name,'create_and_resolve_arka_expense_v2');
      if(!expenseLedger.has(payload.p_idempotency_key))expenseLedger.set(payload.p_idempotency_key,{...payload});
      if(loseExpenseReply){loseExpenseReply=false;throw new Error('Load failed after commit');}
      return {data:{ok:true}};
    }},
  });vm.runInContext(expenseSource+'\n'+expenseHandler,ctx);return ctx;
}
let expense=expenseHarness();await expense.createDailyExpense();
check(expenseLedger.size===1&&expenseStorage.size===1,'lost expense reply retains durable intent');
const expenseKey=[...expenseLedger.keys()][0];
expense=expenseHarness();await expense.createDailyExpense();
check(expenseLedger.size===1&&expenseCalls===2&&expenseStorage.size===0,'reload and retry debit only once and clear after acknowledgement');
check([...expenseLedger.keys()][0]===expenseKey,'reload preserves original expense key');
await expense.createDailyExpense();check(expenseLedger.size===2,'a later acknowledged separate expense receives a new key');
storageBlocked=true;const callsBefore=expenseCalls;await expenseHarness().createDailyExpense();
check(expenseCalls===callsBefore,'storage failure prevents unprotected expense request');storageBlocked=false;
expense=expenseHarness();
expense.prepareDailyExpenseIntent('fixture-manager',{p_actor_pin:'fixture-pin',p_amount:4,p_note:'Retained'});
check(expense.readDailyExpenseIntent('other-actor')===null,'expense recovery isolates actors');
const oldPending=expense.readDailyExpenseIntent('fixture-manager').p_idempotency_key;
expense.acknowledgeDailyExpenseIntent('fixture-manager','unrelated-key');
check(expense.readDailyExpenseIntent('fixture-manager').p_idempotency_key===oldPending,'acknowledgement cannot clear a different pending expense');
const beforeMismatch=expenseCalls;await expense.createDailyExpense();
check(expenseCalls===beforeMismatch,'different pending payload requires review before replay');

const source = fs.readFileSync('lib/syncEngine.js','utf8');
const section = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const execution = [
  section('function validateOpShape(', 'function shouldRetryYet('),
  section('async function updateByIdOrLocalOid(', 'function firstPresent('),
  section('async function processOp(', 'function finishScheduledPromise('),
  section('export async function runSync(', 'export function initSyncEngine(').replace('export ',''),
].join('\n');
function syncHarness({found=false,error=null,type='patch_order_data',payload={table:'orders',id:'synthetic-local-order',data:{note:'fixture'}}}={}) {
  let dbFound=found, dbError=error;
  const op={op_id:'synthetic-op',type,payload};
  const pending=new Map([[op.op_id,op]]), calls=[];
  let deletes=0, permanent=0;
  const noop=()=>{};
  const ctx=vm.createContext({
    running:null,MAX_SYNC_RUN_MS:10000,SYNC_OP_TIMEOUT_MS:1000,
    getPayload:o=>o.payload||{},stripNonSchemaCols:v=>({...v}),normalizeBaseUpdatePatch:async(_t,_i,p)=>p,
    ensureArkaPaymentBeforePaidCashOrderPatch:async()=>{},isNumericDbId:v=>/^\d+$/.test(v),nowIso:()=>new Date().toISOString(),
    supabase:{from(table){const q={update(){return q;},eq(field,id){calls.push({table,field,id});return q;},select(){return q;},maybeSingle:async()=>({data:dbFound?{id:10}:null,error:dbError})};return q;}},
    acquireLock:()=>true,releaseLock:noop,refreshLock:noop,emitSyncStatus:noop,bumpSyncCounter:noop,syncDebugLog:noop,
    isOnline:()=>true,sortOps:v=>v,getPendingOps:async()=>[...pending.values()],isBaseScopedOp:()=>true,shouldRetryYet:()=>true,
    withSupabaseTimeout:p=>p,deleteOp:async id=>{deletes++;pending.delete(id);},clearPendingMutationsFromOp:noop,
    refreshSnapshot:async()=>[...pending.values()],logger:{error:noop},isNetworkLikeError:e=>e.message==='Load failed',isStructuralSchemaError:()=>false,isDeviceAuthorizationError:()=>false,
    markInsertMirrorState:async()=>{},buildRetriedOp:(o,e)=>({...o,lastError:e.message,status:'pending'}),pushOp:async o=>pending.set(o.op_id,o),
    discardPermanentOp:async(o,e)=>{permanent++;pending.set(o.op_id,{...o,status:'failed_permanently',lastError:e.message});},
    postArkaTransaction:async()=>{},
  });
  vm.runInContext(execution,ctx);
  return {ctx,pending,calls,op,setFound:v=>{dbFound=v;},setError:v=>{dbError=v;},state:()=>({deletes,permanent}),run:()=>ctx.runSync()};
}
const missing = syncHarness();
let result = await missing.run();
check(result.done===0 && missing.state().deletes===0 && missing.pending.size===1,'zero affected rows never remove queued update');
check(missing.state().permanent===0 && missing.pending.get('synthetic-op').lastError==='SYNC_ORDER_NOT_FOUND','missing order remains retryable until its create arrives');
check(missing.calls[0].field==='local_oid','local ids never queried against numeric primary key');
missing.setFound(true); result=await missing.run();
check(result.done===1 && missing.state().deletes===1 && missing.pending.size===0,'same operation acknowledged exactly once after order appears');
const outage=syncHarness({error:new Error('Load failed')});
await outage.run();
check(outage.calls.length===1 && outage.state().deletes===0 && outage.pending.size===1,'network failure is never hidden by a fallback query');
outage.setError(null);outage.setFound(true);await outage.run();
check(outage.state().deletes===1,'reconnection replays the retained operation');
for (const config of [{type:'legacy-unknown',payload:{value:'preserve me'}},{type:'upload_storage',payload:{bucket:'fixture'}}]) {
  const h=syncHarness(config);await h.run();
  check(h.state().deletes===0 && h.pending.size===1 && h.state().permanent===1,'unsupported/malformed operations preserved for review');
  assert.deepEqual(h.pending.get('synthetic-op').payload,config.payload);
  await assert.rejects(h.ctx.processOp(h.op),/UNSUPPORTED_SYNC_OPERATION|INVALID_STORAGE_OPERATION/);checks++;
}
const numeric = syncHarness({found:true,payload:{table:'orders',id:'10',data:{note:'fixture'}}});await numeric.run();
check(numeric.calls[0].field==='id' && numeric.state().deletes===1,'numeric server ids update by primary key');
console.log(`PASS app stability audit: ${checks} behavior checks covering Ring signatures/storage, role contracts, customer identity errors and durable sync acknowledgement/recovery.`);
