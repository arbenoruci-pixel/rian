import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Exercise the real account and Kapaku React pages with synthetic service
// responses. No database, network or financial mutations are performed.
const mocks = {
  '@/lib/actorSession': 'export const getActor=()=>window.actor;',
  '@/lib/routerCompat.jsx': `import React from 'react';const router={replace:()=>{},push:()=>{}};export const useRouter=()=>router;export default function Link({children,to,href,className}){return <a href={to||href} className={className}>{children}</a>;}`,
  '@/lib/supabaseClient': 'export const supabase={rpc:(name,args)=>window.rpc(name,args)};',
  '@/lib/corporateFinance': 'export const listWorkerDebtRows=async()=>[];',
  '@/lib/arkaService': 'export const listWorkerHandoffs=async()=>window.handoffs;export const listWorkerPendingPayments=async()=>window.payments;',
  '@/lib/usersService': 'export const fetchSessionUserByPin=async()=>window.worker;',
  '@/lib/ordersService': 'export const listMixedOrderRecords=async()=>[];',
  '@/lib/mealPolicyClient': 'export const fetchMealPolicy=options=>window.readPolicy(options);',
  '@/lib/handoffReceiptClient': 'export const requestHandoffReceipts=options=>window.readReceipts(options);',
  '@/components/WorkerBonusAccount': 'export default function WorkerBonusAccount(){return null;}',
  '@/components/HandoffReceiptsPanel': 'export default function HandoffReceiptsPanel(){return null;}',
};
const bundle = await build({
  stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Account from './app/llogaria-ime/page.jsx';import Kapaku from './app/arka/kapaku/page.jsx';const root=createRoot(document.getElementById('root'));window.renderPage=()=>root.render(window.mode==='kapaku'?<Kapaku/>:<Account/>);`, loader:'jsx', resolveDir:process.cwd() },
  bundle:true, write:false, format:'iife', jsx:'automatic', loader:{'.css':'empty'}, define:{'process.env.NODE_ENV':'"test"'},
  plugins:[{name:'synthetic-finance-services',setup(builder){
    builder.onResolve({filter:/^@\//},args => Object.hasOwn(mocks,args.path) ? {path:args.path,namespace:'fixture'} : builder.resolve('./'+args.path.slice(2),{resolveDir:process.cwd(),kind:args.kind}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args => ({contents:mocks[args.path],loader:'jsx',resolveDir:process.cwd()}));
  }}],
});
const ids = { manager:'10000000-0000-4000-8000-000000000001', worker:'20000000-0000-4000-8000-000000000001', other:'20000000-0000-4000-8000-000000000002' };
const manager = {id:ids.manager,pin:'9900',name:'Fixture Manager',role:'DISPATCH',is_active:true};
const worker = {id:ids.worker,pin:'9911',name:'Fixture Worker',role:'PUNTOR',is_active:true,salary:500,pay_salary_enabled:true,pay_meal_enabled:true,pay_meal_amount:3};
const clone = value => JSON.parse(JSON.stringify(value));
let dom;
const doc = () => dom.window.document;
const body = () => doc().body.textContent;
const button = label => [...doc().querySelectorAll('button')].find(node => node.textContent.trim()===label);
async function until(predicate,label='page update') {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error(`Timed out: ${label}\n${body()}`);
}
async function click(label) {
  await until(()=>button(label)&&!button(label).disabled,label);
  button(label).click();await new Promise(resolve=>setTimeout(resolve,25));
}
function field(placeholder,value) {
  const node=[...doc().querySelectorAll('input')].find(input=>input.placeholder===placeholder);
  assert.ok(node,placeholder);
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(node,value);
  node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
}
function stat(label,selector='.statCard',labelSelector='.statLabel',valueSelector='.statValue') {
  const card=[...doc().querySelectorAll(selector)].find(node=>node.querySelector(labelSelector)?.textContent===label);
  assert.ok(card,`Missing metric ${label}`);
  return card.querySelector(valueSelector)?.textContent;
}
function kapakuStat(label){return stat(label,'.arkaMiniStat','.arkaMiniStatLabel','.arkaMiniStatValue');}
function policy(actorId=ids.manager) {
  return {ok:true,actorId,businessDate:'2026-12-02',serverNow:'2026-12-02T12:00:00Z',settings:[{policyKey:'meal_monthly_2026_12',effectiveFrom:'2026-12-01',dailyRate:3,workDays:26,monthlyAmount:78,enabled:true}],policies:[{policyKey:'meal_monthly_2026_12',workerId:ids.worker,enabled:true}],acknowledged:[],dailyMealsAllowed:false};
}
async function open(mode='account',{resolved=false,policyFail=false,financeFail=false,holdPreview=false}={}) {
  dom?.window.close();
  const virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',error=>{throw error;});
  dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.test/'+(mode==='kapaku'?'arka/kapaku':'llogaria-ime'),pretendToBeVisual:true,runScripts:'outside-only',virtualConsole});
  const w=dom.window;
  w.mode=mode;w.actor=clone(mode==='kapaku'?manager:worker);w.worker=clone(worker);
  w.policyFail=policyFail;w.financeFail=financeFail;w.holdPreview=holdPreview;w.calls=[];w.writes=[];
  w.handoffs=[{id:41,amount:100,worker_pin:worker.pin,worker_name:worker.name,status:resolved?'ACCEPTED':'PENDING_DISPATCH_APPROVAL',submitted_at:'2026-12-01T10:00:00Z',receipt_updated_at:'2026-12-02T10:00:00Z',receipt_tracking:true,receipt_worker_id:worker.id,receipt_received_amount:95,receipt_resolved_amount:resolved?5:0,receipt_outstanding_amount:resolved?0:5,pending_payment_ids:[71]},{id:40,amount:20,worker_pin:worker.pin,status:'ACCEPTED',submitted_at:'2026-12-01T09:00:00Z',decided_at:'2026-12-01T09:00:00Z',receipt_tracking:false}];
  w.payments=[{id:71,amount:100,type:'IN',status:resolved?'ACCEPTED_BY_DISPATCH':'PENDING_DISPATCH_APPROVAL',created_by_pin:worker.pin,created_by_name:worker.name,created_at:'2026-12-01T09:00:00Z'},{id:70,amount:20,type:'IN',status:'ACCEPTED_BY_DISPATCH',created_by_pin:worker.pin,created_by_name:worker.name,created_at:'2026-12-01T08:00:00Z'}];
  const preview=()=>({summary:{current_balance:3000,total_in:3000,total_out:0},users:[clone(worker)],monthPayments:clone(w.payments),openPayments:[],fixedExpenses:[],ledger:[],owners:[],ownerEntries:[]});
  w.readPolicy=async options=>{
    w.calls.push({name:'policy',options});
    if(w.policyFail)throw new Error('Fixture policy unavailable');
    return policy(w.actor.id);
  };
  w.readReceipts=async options=>{
    w.calls.push({name:'receipts',options});
    return {ok:true,actorId:w.actor.id,manager:true,handoffs:clone(w.handoffs),summary:{outstandingTotal:resolved?0:5,receivedToday:95}};
  };
  w.rpc=async(name,args)=>{
    w.calls.push({name,args});
    if(name==='get_worker_finance_snapshot_v1')return w.financeFail?{data:null,error:new Error('Fixture finance unavailable')}:{data:{cash:{today_gross:100,open_due_to_base:0,received_handoff_total:115,pending_handoff_total:resolved?0:5,pending_handoff_count:resolved?0:1}},error:null};
    if(name==='get_arka_kapaku_preview'){
      if(w.holdPreview)return new Promise(resolve=>{w.releasePreview=()=>resolve({data:preview(),error:null});});
      return {data:preview(),error:null};
    }
    if(name==='post_manual_budget_adjustment'){w.writes.push(args);return {data:{ok:true},error:null};}
    throw new Error('Unexpected fixture RPC '+name);
  };
  w.eval(bundle.outputFiles[0].text);w.renderPage();
  await new Promise(resolve=>setTimeout(resolve,35));
  return w;
}

let w=await open();
await until(()=>body().includes('USHQIMI MUJOR'));
assert.match(stat('USHQIMI MUJOR'),/78,00/);
await click('CASH & POROSI');
await until(()=>doc().querySelector('.cashQuickGrid'));
assert.match(stat('DORËZUAR'),/115,00/,'Canonical actual receipts include partial cash and legacy cash once');
assert.match(stat('DORËZUAR GJITHSEJ'),/115,00/);
assert.match(stat('TOTAL NË PRITJE'),/5,00/,'Only the partial receipt residual remains pending');
await click('SHIH DORËZIMET NË PRITJE');
assert.match(doc().querySelector('.historyList.compactTop .historyAmount').textContent,/5,00/);
assert.ok(body().includes('Pranuar pjesërisht'));
console.log('PASS real personal account shows actual partial receipts once and residual pending amounts');

w=await open('account',{resolved:true});
await until(()=>body().includes('USHQIMI MUJOR'));
await click('CASH & POROSI');
assert.match(stat('DORËZUAR GJITHSEJ'),/115,00/,'Noncash resolution never increases received cash');
assert.match(stat('TOTAL NË PRITJE'),/^0,00/);
await click('HISTORIA');
const receiptRow=[...doc().querySelectorAll('.historyRow')].find(row=>row.querySelector('.historyType')?.textContent==='DORËZIM · PRANUAR REALISHT');
assert.ok(receiptRow);
assert.match(receiptRow.querySelector('.historyAmount').textContent,/95,00/);
assert.match(receiptRow.querySelector('.historyDesc').textContent,/Pritej 100,00.*Mbeten 0,00.*Sqaruar pa cash 5,00/);
console.log('PASS real personal history separates expected, received and noncash-resolved money');

w=await open('account',{financeFail:true});
await until(()=>doc().querySelector('[role=alert]'));
await click('CASH & POROSI');
assert.equal(doc().querySelector('.cashQuickGrid'),null,'Missing authoritative cash never becomes displayed zero or duplicated legacy total');
console.log('PASS personal cash figures fail closed when canonical finance cannot load');

w=await open('kapaku');
await until(()=>button('HEK NGA BUXHETI')&&!button('HEK NGA BUXHETI').disabled,'Kapaku verification');
assert.match(kapakuStat('Rroga neto'),/578,00/,'Current December salary includes the dated 78 allowance');
assert.match(kapakuStat('Në pritje dispatch'),/5,00/,'Kapaku uses authoritative residuals');
assert.ok(body().includes('€1.417,00'),'Profit reserves include 578 salary and 5 residual from 3000 cash minus 1000 reserve');
assert.equal(w.calls.find(call=>call.name==='policy').options.scope,'team');
assert.equal(w.calls.find(call=>call.name==='get_arka_kapaku_preview').args.p_month_start,'2026-12-01T00:00:00.000Z','Payroll month follows server date');
await click('HEK NGA BUXHETI');
field('0.00','25');field('Shkruaj arsyen e rregullimit','Fixture reason');
w.policyFail=true;
await click('KONFIRMO HEQJEN');
await until(()=>body().includes('Fixture policy unavailable'));
assert.equal(w.writes.length,0,'A failed fresh policy check blocks manual cash out');
console.log('PASS Kapaku uses dated payroll and residuals and rechecks policy before budget movement');

w=await open('kapaku',{policyFail:true});
await until(()=>body().includes('Fixture policy unavailable'));
assert.equal(kapakuStat('Rroga neto'),'—');
assert.equal(kapakuStat('Në pritje dispatch'),'—');
assert.ok(body().includes('PRET VERIFIKIMIN'));
assert.equal(button('HEK NGA BUXHETI').disabled,true);
assert.equal(w.calls.some(call=>call.name==='get_arka_kapaku_preview'),false);
console.log('PASS Kapaku hides unverified profit and disables financial adjustments on unavailable policy');

w=await open('kapaku',{holdPreview:true});
await until(()=>typeof w.releasePreview==='function');
const releaseOld=w.releasePreview;
w.actor={id:ids.other,pin:'9912',name:'Other fixture',role:'PUNTOR',is_active:true};w.policyFail=true;
w.dispatchEvent(new w.Event('tepiha:session-changed'));
await until(()=>body().includes('Fixture policy unavailable'));
releaseOld();await new Promise(resolve=>setTimeout(resolve,40));
assert.equal(kapakuStat('Rroga neto'),'—');
assert.equal(button('HEK NGA BUXHETI'),undefined);
assert.equal(body().includes('€3.000,00'),false,'Late response from old account cannot restore financial figures');
console.log('PASS Kapaku account switch discards late old-account results and removes manager actions');
dom.window.close();
console.log('Receipt account UI: 6 scenario groups passed.');
