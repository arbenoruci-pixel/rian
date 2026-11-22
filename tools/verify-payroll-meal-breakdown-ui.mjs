import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Render the actual payroll page and calculation model against synthetic read
// services. No network access, live identities or financial writes are used.
const mocks = {
  '@/lib/routerCompat.jsx': `import React from 'react';const router={push:()=>{},replace:()=>{}};export const useRouter=()=>router;export default function Link({href,children,className}){return <a href={href} className={className}>{children}</a>;}`,
  '@/lib/supabaseClient': 'export const supabase={from:table=>window.readTable(table),rpc:()=>window.forbidWrite()};',
  '@/lib/arkaService': 'export const listPendingPaymentRecords=options=>window.readPayments(options);',
  '@/lib/arka/arkaClient': 'export const arkaTransaction=()=>window.forbidWrite();export const buildArkaIdempotencyKey=()=>"fixture-key";',
  '@/lib/usersService': 'export const listUserRecords=async()=>window.staff;export const updateUserRecord=()=>window.forbidWrite();export const deleteUserRecord=()=>window.forbidWrite();',
  '@/lib/mealPolicyClient': 'export const fetchMealPolicy=options=>window.readPolicy(options);',
  '@/lib/handoffReceiptClient': 'export const requestHandoffReceipts=async()=>({ok:true,handoffs:[]});',
  '@/components/WorkerCompensationEditor': 'export default function WorkerCompensationEditor(){return null;}',
};
const bundle = await build({
  stdin: { contents:`import React from 'react';import {createRoot} from 'react-dom/client';import PayrollPage from './app/arka/payroll/page.jsx';const root=createRoot(document.getElementById('root'));root.render(<PayrollPage/>);`,resolveDir:process.cwd(),loader:'jsx' },
  bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"test"'},
  plugins:[{name:'synthetic-payroll-read-services',setup(builder){
    builder.onResolve({filter:/^@\//},args=>Object.hasOwn(mocks,args.path)?{path:args.path,namespace:'fixture'}:builder.resolve('./'+args.path.slice(2),{resolveDir:process.cwd(),kind:args.kind}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'jsx',resolveDir:process.cwd()}));
  }}],
});
const ids={manager:'10000000-0000-4000-8000-000000000001',worker:'20000000-0000-4000-8000-000000000001'};
const manager={id:ids.manager,pin:'9900',name:'Fixture Manager',role:'DISPATCH',is_active:true};
const worker={id:ids.worker,pin:'9911',name:'Fixture Worker',role:'PUNTOR',is_active:true,salary:700,pay_salary_enabled:true,pay_meal_enabled:true,pay_meal_amount:3,pay_transport_bonus_enabled:false,pay_transport_bonus_amount:0,pay_commission_enabled:false,pay_ready_bonus_enabled:false,pay_cash_mode:'FULL_CASH',avans_manual:0,borxh_afatgjat:0};
const clone=value=>JSON.parse(JSON.stringify(value));
let dom;
let passed=0;
const pass=name=>{passed++;console.log('PASS '+name);};
const doc=()=>dom.window.document;
const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
const text=node=>normalize((node||doc().body).textContent);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label='payroll UI update'){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if(predicate())return;await sleep(10);}
  throw new Error(`Timed out: ${label}\n${text()}`);
}
function labeledValue(container,label,{rowSelector='p',labelSelector='span',valueSelector='strong',prefix=false}={}){
  const row=[...container.querySelectorAll(rowSelector)].find(node=>prefix?text(node.querySelector(labelSelector)).startsWith(label):text(node.querySelector(labelSelector))===label);
  assert.ok(row,`Missing ${label}`);
  return text(row.querySelector(valueSelector));
}
function detail(){return doc().querySelector('.payrollDetailModal');}
function breakdown(){return [...detail().querySelectorAll('.breakdownCard')].find(node=>text(node.querySelector('h3'))==='PAGA QË LLOGARITET');}
function detailMetric(label){return labeledValue(detail(),label,{rowSelector:'.detailBox'});}
function monthGross(){return labeledValue(doc().querySelector('.calcGrid'),'Rroga + shtesa mujore, gjithsej',{rowSelector:'div'});}
async function selectMonth(month){
  const input=doc().querySelector('input[type="month"]');
  assert.ok(input);
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,month);
  input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await until(()=>dom.window.monthReads.includes(month),'selected-month read');
  await until(()=>[...doc().querySelectorAll('button')].some(node=>text(node)==='RIFRESKO'&&!node.disabled),'selected-month loaded');
}
async function openDetails(){
  await until(()=>doc().querySelector('button.workerRow'));
  doc().querySelector('button.workerRow').click();
  await until(()=>detail());
}
function assertNoWrites(){assert.equal(dom.window.writes,0,'Viewing payroll must not submit financial operations');}
async function open({member=true,legacyAmount=3,initialMonth='2026-11',transport=0,advance=0,paid=false,closed=false}={}){
  if(dom){assertNoWrites();dom.window.close();}
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>{throw error;});
  dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.test/arka/payroll',pretendToBeVisual:true,runScripts:'outside-only',virtualConsole});
  const w=dom.window;const ActualDate=w.Date;
  w.Date=class extends ActualDate{constructor(...args){super(...(args.length?args:[`${initialMonth}-02T12:00:00Z`]));}static now(){return ActualDate.parse(`${initialMonth}-02T12:00:00Z`);}};
  w.localStorage.setItem('CURRENT_USER_DATA',JSON.stringify(manager));
  w.writes=0;w.policyCalls=0;w.monthReads=[];
  w.forbidWrite=()=>{w.writes++;throw new Error('Unexpected financial write from payroll view');};
  w.alert=message=>{throw new Error('Unexpected alert: '+message);};
  w.confirm=()=>{throw new Error('Unexpected payment confirmation');};
  w.staff=[{...clone(worker),pay_meal_amount:legacyAmount,pay_transport_bonus_enabled:transport>0,pay_transport_bonus_amount:transport,avans_manual:advance}];
  w.payments=paid?[{id:801,type:'SALARY_PAYMENT',status:'SALARY_PAID',amount:748,created_by_pin:worker.pin,created_by_name:worker.name,created_at:'2026-12-02T10:00:00Z',note:'RROGA 2026-12'}]:[];
  w.readPayments=async options=>w.payments.filter(row=>Object.entries(options?.eq||{}).every(([key,value])=>row[key]===value)&&Object.entries(options?.in||{}).every(([key,values])=>values.includes(row[key])));
  w.readPolicy=async options=>{
    assert.equal(options.scope,'team');w.policyCalls++;
    return {ok:true,actorId:ids.manager,businessDate:'2026-12-02',serverNow:'2026-12-02T12:00:00Z',settings:[{policyKey:'meal_monthly_2026_12',effectiveFrom:'2026-12-01',dailyRate:3,workDays:26,monthlyAmount:78,enabled:true}],policies:member?[{policyKey:'meal_monthly_2026_12',workerId:ids.worker,enabled:true}]:[],acknowledged:[],dailyMealsAllowed:false};
  };
  w.readTable=table=>{
    const filters=[];let single=false;
    const chain={
      select(){return chain;},eq(key,value){filters.push(['eq',key,value]);return chain;},is(key,value){filters.push(['eq',key,value]);return chain;},gte(key,value){filters.push(['gte',key,value]);return chain;},lt(key,value){filters.push(['lt',key,value]);return chain;},in(key,value){filters.push(['in',key,value]);return chain;},ilike(key,value){filters.push(['ilike',key,value]);return chain;},order(){return chain;},limit(){return chain;},maybeSingle(){single=true;return chain;},
      then(resolve,reject){
        try{
          let rows=[];
          if(table==='payroll_month_closes'){
            const month=filters.find(([,key])=>key==='month_key')?.[2];w.monthReads.push(month);
            rows=closed&&month==='2026-12'?[{id:31,month_key:month,status:'CLOSED',cancelled_at:null,closed_at:'2027-01-01T10:00:00Z',company_balance_before:5000,company_balance_after:4345,total_salary_base:640,total_advances:12,total_net_pay:655,total_workers:1}]:[];
          }else if(table==='payroll_month_close_items')rows=[{id:32,close_id:31,worker_pin:worker.pin,worker_name:worker.name,net_pay:655,salary_base:640,status:'ACCEPTED'}];
          else if(table==='arka_pending_payments')rows=clone(w.payments);
          else if(table==='company_budget_summary')rows=[{id:1,current_balance:10000,total_in:10000,total_out:0}];
          else if(!['company_fixed_expenses','arka_payment_exclusions'].includes(table))throw new Error('Unexpected read table '+table);
          rows=rows.filter(row=>filters.every(([kind,key,value])=>kind==='eq'?row[key]===value:kind==='in'?value.includes(row[key]):kind==='gte'?row[key]>=value:kind==='lt'?row[key]<value:kind==='ilike'?String(row[key]||'').toUpperCase().includes(String(value).replaceAll('%','').toUpperCase()):false));
          return Promise.resolve(resolve({data:single?rows[0]||null:rows,error:null}));
        }catch(error){return reject?Promise.resolve(reject(error)):Promise.reject(error);}
      },
    };return chain;
  };
  w.eval(bundle.outputFiles[0].text);
  await until(()=>doc().querySelector('input[type="month"]'));
  await until(()=>[...doc().querySelectorAll('button')].some(node=>text(node)==='RIFRESKO'&&!node.disabled));
  return w;
}

let w=await open();
await until(()=>doc().querySelector('button.workerRow'));
await selectMonth('2026-12');await until(()=>monthGross()==='€778,00');await openDetails();
assert.equal(detailMetric('Rroga bazë'),'€700,00');assert.equal(detailMetric('Për me ia dhënë'),'€778,00');
assert.equal(labeledValue(breakdown(),'Ushqimi mujor',{prefix:true}),'€78,00');
assert.equal(labeledValue(breakdown(),'Rroga + shtesa mujore'),'€778,00');
assert.match(text(breakdown()),/€3,00 × 26 ditë pune/);
assert.equal(text(detail().querySelector('.formulaLine')),'RROGA BAZË €700,00 + USHQIMI MUJOR €78,00 - AVANS PERSONAL €0,00 = NETO €778,00');
assert.equal(monthGross(),'€778,00');
assert.match(text(doc().querySelector('.calcDetails')),/Rroga bazë \+ ushqimi mujor \+ shtesa fikse e transportit/);
pass('selecting December shows 700 base + 78 food = 778 net, with a separate allowance and correctly named month gross');

w=await open({legacyAmount:3});await openDetails();
assert.equal(detailMetric('Rroga bazë'),'€700,00');assert.equal(labeledValue(breakdown(),'Ushqimi mujor',{prefix:true}),'€3,00');
assert.equal(text(detail().querySelector('.formulaLine')),'RROGA BAZË €700,00 + USHQIMI MUJOR €3,00 - AVANS PERSONAL €0,00 = NETO €703,00');
assert.equal(monthGross(),'€703,00');assert.doesNotMatch(text(detail()),/€78,00|26 ditë pune/);
pass('historical November uses its actual legacy allowance and never borrows the December rate or 26-day calculation');

w=await open({member:false,initialMonth:'2026-12'});await openDetails();
assert.equal(labeledValue(breakdown(),'Ushqimi mujor',{prefix:true}),'€0,00');assert.equal(detailMetric('Për me ia dhënë'),'€700,00');
assert.equal(text(detail().querySelector('.formulaLine')),'RROGA BAZË €700,00 - AVANS PERSONAL €0,00 = NETO €700,00');
assert.equal(monthGross(),'€700,00');assert.doesNotMatch(text(detail()),/€78,00|26 ditë pune/);
pass('a noneligible worker has an explicit zero food component and a consistent base-only formula');

w=await open({initialMonth:'2026-12',transport:20,advance:50});await openDetails();
assert.equal(labeledValue(breakdown(),'Shtesa mujore e transportit'),'€20,00');assert.equal(labeledValue(breakdown(),'Rroga + shtesa mujore'),'€798,00');
assert.equal(detailMetric('Për me ia dhënë'),'€748,00');assert.equal(monthGross(),'€798,00');
assert.equal(text(detail().querySelector('.formulaLine')),'RROGA BAZË €700,00 + USHQIMI MUJOR €78,00 + SHTESA E TRANSPORTIT €20,00 - AVANS PERSONAL €50,00 = NETO €748,00');
pass('fixed transport and personal advances remain distinct and reconcile the displayed gross and net without changing calculations');

w=await open({initialMonth:'2026-12',advance:900});await openDetails();
assert.equal(detailMetric('Për me ia dhënë'),'€0,00');assert.equal(monthGross(),'€778,00');
assert.equal(labeledValue(breakdown(),'Ushqimi mujor',{prefix:true}),'€78,00');
assert.equal(text(detail().querySelector('.formulaLine')),'Avansi personal €900,00 tejkalon rrogën me shtesat €778,00. Neto për pagesë €0,00. Avans për bartje €122,00.');
assert.equal(detail().querySelector('.detailPayBtn').disabled,true);
pass('excess advances show zero net and the existing carryover separately without a false subtraction equality');

w=await open({initialMonth:'2026-12',transport:20,advance:50,paid:true});await openDetails();
assert.equal(detailMetric('Paguar këtë muaj'),'€748,00');assert.equal(detailMetric('Për me ia dhënë'),'€0,00');
assert.equal(text(detail().querySelector('.formulaLine')),'PAGUAR KËTË MUAJ €748,00 · MBETET PËR PAGESË €0,00');
assert.equal(detail().querySelector('.detailPayBtn').disabled,true);
pass('already paid salary shows the recorded payment and zero remaining instead of an incorrect arithmetic equation');

w=await open({initialMonth:'2026-12',closed:true});await until(()=>doc().querySelector('.closedSnapshotDashboard'));
assert.equal(labeledValue(doc().querySelector('.closedSnapshotDashboard'),'RROGA BAZË',{rowSelector:'.moneyTile'}),'€640,00');
assert.equal(labeledValue(doc().querySelector('.closedSnapshotDashboard'),'PAYROLL OUT',{rowSelector:'.moneyTile'}),'€655,00');
assert.equal(text(doc().querySelector('.closedSnapshotDashboard .workerRight b')),'€655,00');
assert.equal(w.policyCalls,0);assert.equal(doc().querySelector('button.workerRow'),null);assert.doesNotMatch(text(doc().querySelector('.closedSnapshotDashboard')),/€78,00|26 ditë pune/);
assertNoWrites();
pass('closed December snapshots keep recorded totals and read-only rows without inventing a food breakdown from current policy');
dom.window.close();
console.log(`Payroll meal breakdown UI: ${passed} verification groups passed.`);
