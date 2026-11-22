import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createMealPolicyHandler } from '../api/meal-policy.js';
import { mealBusinessDate, resolveMonthlyMealAllowance, activeOwnMealPolicy, dailyMealsAllowed } from '../lib/mealPolicy.js';
import { buildMonthlyPayrollPreview, pendingPayrollHandoffSummary } from '../lib/payrollMonthClose.js';
import { loadWorkerHandoffPreview } from '../lib/workerHandoffPreview.js';
import { validateMealPolicySalaryBasis } from '../lib/mealPolicyPayrollGuard.js';
import { runArkaTransaction } from '../lib/arka/arkaEngine.js';

// Isolated synthetic database. The clock override exists only in this test DB;
// production enforcement always uses PostgreSQL's real now(). No network calls.
const pg = new PGlite();
let passed=0;
const pass=name=>{passed++;console.log('PASS '+name);};
const ids={first:'20000000-0000-4000-8000-000000000001',second:'20000000-0000-4000-8000-000000000002',third:'20000000-0000-4000-8000-000000000003',other:'20000000-0000-4000-8000-000000000004',inactive:'20000000-0000-4000-8000-000000000005',manager:'10000000-0000-4000-8000-000000000001'};
const pins={first:'9911',second:'9912',third:'9913',other:'9914',inactive:'9915',manager:'9900'};
const policyKey='meal_monthly_2026_12';
await pg.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  grant usage on schema public to service_role,anon,authenticated;
  select set_config('fixture.now','2026-11-30T22:59:59Z',false);
  create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select current_setting('fixture.now')::timestamptz $$;
  create or replace function pg_catalog.clock_timestamp() returns timestamptz language sql volatile as $$ select current_setting('fixture.now')::timestamptz $$;
  create table users(id uuid primary key,pin text unique,name text,role text,is_active boolean default true,salary numeric default 500,salary_day int default 1,avans_manual numeric default 0,borxh_afatgjat numeric default 0,pay_salary_enabled boolean default true,pay_meal_enabled boolean default true,pay_meal_amount numeric default 3,pay_commission_enabled boolean default false,pay_commission_rate_m2 numeric default 0,pay_transport_bonus_enabled boolean default false,pay_transport_bonus_amount numeric default 0,pay_ready_bonus_enabled boolean default false,pay_cash_mode text default 'FULL_CASH',pay_notes text,pay_updated_at timestamptz,pay_updated_by_pin text,pay_updated_by_name text);
  create table tepiha_user_devices(device_id text primary key,user_id uuid,is_approved boolean default true);
  alter table users add column bonus_ushqim numeric default 3,add column bonus_transport numeric default 0,add column is_hybrid_transport boolean default false,add column commission_rate_m2 numeric default 0;
  create table worker_compensation_audit(worker_pin text,worker_name text,before_profile jsonb,after_profile jsonb,changed_by_pin text,changed_by_name text,change_note text);
  create table arka_pending_payments(id bigint generated always as identity primary key,amount numeric,type text,status text,source_module text,transport_order_id uuid,transport_code_str text,transport_m2 numeric,order_code text,client_name text,created_by_pin text,created_by_name text,handed_by_pin text,created_at timestamptz default now(),updated_at timestamptz default now(),note text,handoff_note text,idempotency_key text);
  create table arka_payment_exclusions(payment_id bigint,cancelled_at timestamptz);
  create table cash_handoffs(id bigint,worker_pin text,status text,amount numeric,decided_at timestamptz);
  create table company_budget_summary(id int,current_balance numeric);
  insert into company_budget_summary values(1,10000);
  create table company_fixed_expenses(id int,amount numeric,active boolean,essential boolean);
  create table payroll_month_closes(id int,month_key text,status text,snapshot jsonb);
  insert into payroll_month_closes values(1,'2026-10','CLOSED','{"meal":17,"net":517}');
  grant select on users,tepiha_user_devices,arka_pending_payments,company_budget_summary to service_role;
`);
for(const [key,id] of Object.entries(ids)){
  await pg.query('insert into users(id,pin,name,role,is_active,pay_meal_enabled,pay_meal_amount) values($1,$2,$3,$4,$5,$6,$7)',[id,pins[key],'Fixture '+key,key==='manager'?'ADMIN':key==='third'?'TRANSPORT':'PUNTOR',key!=='inactive',key!=='third',key==='third'?0:3]);
  await pg.query('insert into tepiha_user_devices values($1,$2,true)',['fixture-'+key,id]);
}
await pg.query('insert into tepiha_user_devices values($1,$2,false)',['fixture-unapproved',ids.first]);
await pg.exec(await readFile(new URL('./fixtures/meal-policy-legacy-functions.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('./fixtures/meal-policy-legacy-profile-save.sql',import.meta.url),'utf8'));
const migration=await readFile(new URL('../supabase/migrations/20261122015736_meal_monthly_policy_v1.sql',import.meta.url),'utf8');
await pg.exec(migration);
for(const key of ['first','second','third'])await pg.query('insert into meal_policy_members(policy_key,worker_id) values($1,$2)',[policyKey,ids[key]]);
await pg.exec(migration);
assert.equal((await pg.query('select count(*)::int count from meal_policy_function_backups')).rows[0].count,4);
assert.deepEqual((await pg.query('select snapshot from payroll_month_closes where id=1')).rows[0].snapshot,{meal:17,net:517});
pass('migration applies twice, preserves function backups and closed payroll snapshots');

const clock=async value=>pg.query("select set_config('fixture.now',$1,false)",[value]);
const rpcArgs={get_meal_policy_state_v1:['p_actor_id','p_scope','p_target_id'],acknowledge_meal_policy_v1:['p_actor_id','p_policy_key'],get_meal_policy_salary_basis_v1:['p_worker_pin','p_month_key']};
async function sqlFunction(name,args){
  const names=rpcArgs[name];assert.ok(names,'Only policy RPCs reach the fixture');
  const result=await pg.query('select public.'+name+'('+names.map((_,i)=>'$'+(i+1)).join(',')+') value',names.map(key=>args[key]??null));
  return result.rows[0].value;
}
function builder(table){
  assert.ok(['users','tepiha_user_devices','arka_pending_payments'].includes(table));
  let fields='*',single=false;const filters=[];
  const query={
    select(value){assert.match(value,/^[a-z_,*]+$/);fields=value;return query;},
    eq(field,value){assert.match(field,/^[a-z_]+$/);filters.push([field,'=',value]);return query;},
    ilike(field,value){assert.match(field,/^[a-z_]+$/);filters.push([field,'ilike',value]);return query;},
    order(){return query;},limit(){return query;},maybeSingle(){single=true;return query;},
    then(resolve,reject){return pg.query('select '+fields+' from public.'+table+(filters.length?' where '+filters.map(([field,operator],i)=>field+' '+operator+' $'+(i+1)).join(' and '):''),filters.map(([, , value])=>value)).then(result=>resolve({data:single?result.rows[0]||null:result.rows,error:null}),reject);},
    insert(){throw new Error('UNEXPECTED_FINANCIAL_INSERT');},update(){throw new Error('UNEXPECTED_FINANCIAL_UPDATE');},delete(){throw new Error('UNEXPECTED_FINANCIAL_DELETE');},
  };return query;
}
const db={from:builder,async rpc(name,args){try{return {data:await sqlFunction(name,args),error:null};}catch(error){return {data:null,error:{message:error.message}};}}};
const handler=createMealPolicyHandler({createClient:()=>db});
async function api(key,body={},overrides={}){
  let output;
  const req={method:overrides.method||'POST',headers:{host:'fixture.test',origin:'https://fixture.test','content-type':'application/json',cookie:'tepiha_device_id=fixture-'+key,...overrides.headers},body:{expectedActorId:ids[key]||ids.first,...body}};
  const res={statusCode:200,headers:{},setHeader(name,value){this.headers[name]=value;},end(value){output=value;}};
  await handler(req,res);return {status:res.statusCode,data:JSON.parse(output),headers:res.headers};
}
await pg.exec('set role service_role');
const initial=await api('first',{action:'read'});
assert.equal(initial.status,200);assert.equal(initial.data.businessDate,'2026-11-30');assert.equal(initial.data.dailyMealsAllowed,true);
assert.equal(initial.data.policies.length,1);assert.equal(initial.data.policies[0].workerId,ids.first);
assert.equal(Date.parse(initial.data.nextActivationAt),Date.parse('2026-11-30T23:00:00Z'));
assert.equal(activeOwnMealPolicy(initial.data),null);
assert.equal((await api('first',{action:'acknowledge',policyKey})).status,403);
assert.equal((await api('first',{action:'read',scope:'team'})).status,403);
assert.equal((await api('first',{action:'read',targetPin:pins.second})).status,403);
assert.equal((await api('manager',{action:'read',targetPin:pins.second})).data.targetId,ids.second);
assert.equal((await api('manager',{action:'read',scope:'team'})).data.policies.length,3);
assert.equal((await api('first',{action:'read',expectedActorId:ids.second})).status,403);
assert.equal((await api('inactive')).status,403);
assert.equal((await api('unapproved')).status,403);
assert.equal((await api('first',{}, {headers:{cookie:''}})).status,401);
assert.equal((await api('first',{}, {headers:{origin:'https://other.test'}})).status,403);
assert.equal((await api('first',{}, {headers:{'content-type':'text/plain'}})).status,415);
assert.equal((await api('first',{}, {headers:{'content-length':'2100'}})).status,413);
assert.equal((await api('first',{}, {method:'GET'})).status,405);
assert.match(initial.headers['cache-control'],/no-store/);
await assert.rejects(()=>sqlFunction('get_meal_policy_state_v1',{p_actor_id:ids.first,p_scope:'team',p_target_id:ids.second}),/MEAL_POLICY_FORBIDDEN/);
pass('secure device-authenticated API scopes canonical UUIDs, rejects cross-worker and stale-session reads, and disallows premature acknowledgment');

assert.equal(mealBusinessDate('2026-11-30T22:59:59Z'),'2026-11-30');
assert.equal(mealBusinessDate('2026-11-30T23:00:00Z'),'2026-12-01');
const team=(await api('manager',{scope:'team'})).data;
const worker={id:ids.first,pin:pins.first,name:'Fixture first',role:'PUNTOR',is_active:true,salary:500,pay_salary_enabled:true,pay_meal_enabled:true,pay_meal_amount:3,pay_transport_bonus_enabled:true,pay_transport_bonus_amount:20};
assert.equal(resolveMonthlyMealAllowance(worker,'2026-11',team).amount,3);
assert.equal(resolveMonthlyMealAllowance(worker,'2026-12',team).amount,78);
assert.equal(resolveMonthlyMealAllowance(worker,'2027-02',team).amount,78);
assert.equal(resolveMonthlyMealAllowance({...worker,id:ids.other},'2026-12',team).amount,0);
assert.equal(resolveMonthlyMealAllowance({...worker,id:ids.third,pay_meal_enabled:false,pay_meal_amount:0},'2026-12',team).amount,78);
const nov=buildMonthlyPayrollPreview({workers:[worker],paymentRows:[],month:'2026-11',mealPolicy:team})[0];
const dec=buildMonthlyPayrollPreview({workers:[worker],paymentRows:[],month:'2026-12',mealPolicy:team})[0];
assert.equal(nov.gross,523);assert.equal(dec.gross,598);assert.equal(dec.bonusUshqim,78);
pass('November/December boundary is the Kosovo business clock; exactly 78 replaces the legacy component in selected and future months');

await pg.exec('reset role');
const oldMeal=(await pg.query("insert into arka_pending_payments(type,status,amount,created_by_pin,created_by_name,created_at,note,handoff_note) values('MEAL_PAYMENT','COLLECTED',3,$1,'Fixture first','2026-11-30T12:00:00Z','USHQIM','MEAL_DAY:2026-11-30') returning id",[pins.first])).rows[0].id;
const oldCarry=(await pg.query("insert into arka_pending_payments(type,status,amount,created_by_pin,created_by_name,created_at,note,handoff_note) values('MEAL_PAYMENT','COLLECTED',3,$1,'Fixture first','2026-11-30T12:00:00Z','USHQIM','MEAL_CARRY:2026-11-20 | MEAL_TARGETS:9911') returning id",[pins.first])).rows[0].id;
await assert.rejects(()=>pg.query("insert into arka_pending_payments(type,amount,created_at,note) values('MEAL_PAYMENT',3,'2026-11-30T12:00:00Z','MEAL_DAY:2026-12-01')"),/DAILY_MEALS_REPLACED/);
await clock('2026-11-30T23:00:00Z');
for(const kind of ['MEAL_PAYMENT','MEAL_COVERED']){
  await assert.rejects(()=>pg.query('insert into arka_pending_payments(type,amount,created_at,note) values($1,3,$2,$3)',[kind,'2026-11-20T12:00:00Z','MEAL_DAY:2026-11-20']),/DAILY_MEALS_REPLACED/);
}
await assert.rejects(()=>pg.query('update arka_pending_payments set amount=6 where id=$1',[oldMeal]),/DAILY_MEALS_REPLACED/);
await assert.rejects(()=>pg.query("update arka_pending_payments set type='EXPENSE' where id=$1",[oldMeal]),/DAILY_MEALS_REPLACED/);
await assert.rejects(()=>pg.query('update arka_pending_payments set created_by_pin=$1 where id=$2',[pins.other,oldMeal]),/DAILY_MEALS_REPLACED/);
await assert.rejects(()=>pg.query("update arka_pending_payments set handoff_note='MEAL_DAY:2026-11-29' where id=$1",[oldMeal]),/DAILY_MEALS_REPLACED/);
await pg.query("update arka_pending_payments set status='ACCEPTED_BY_DISPATCH',handoff_note='MEAL_DAY:2026-11-30 MEAL_SETTLED:fixture' where id=$1",[oldMeal]);
assert.equal((await pg.query('select amount from arka_pending_payments where id=$1',[oldMeal])).rows[0].amount,'3');
await pg.query("update arka_pending_payments set handoff_note='SETTLED_IN_HANDOFF:6001' where id=$1",[oldCarry]);
assert.match((await pg.query('select handoff_note from arka_pending_payments where id=$1',[oldCarry])).rows[0].handoff_note,/^SETTLED_IN_HANDOFF:6001.*MEAL_CARRY:2026-11-20/);
await assert.rejects(()=>pg.query("update arka_pending_payments set handoff_note='MEAL_CARRY:2026-11-20' where id=$1",[oldCarry]),/SETTLED_MEAL_CANNOT_BE_REOPENED/);
await assert.rejects(()=>pg.query("update arka_pending_payments set handoff_note='SETTLED_IN_HANDOFF:6002 | MEAL_CARRY:2026-11-20' where id=$1",[oldCarry]),/SETTLED_MEAL_CANNOT_BE_REOPENED/);
assert.equal((await pg.query("select count(*)::int count from arka_pending_payments where type in ('MEAL_PAYMENT','MEAL_COVERED')")).rows[0].count,2);
pass('server trigger blocks new daily claims, offline backdating and financial rewrites; existing prior-day claim remains settleable without duplication');

await pg.exec('set role service_role');
const active=(await api('first')).data;
assert.equal(active.businessDate,'2026-12-01');assert.equal(dailyMealsAllowed(active),false);assert.equal(activeOwnMealPolicy(active).monthlyAmount,78);
assert.equal((await api('other',{action:'acknowledge',policyKey})).status,403);
assert.equal((await api('first',{action:'acknowledge',policyKey,targetPin:pins.second})).status,403);
const ack=await api('first',{action:'acknowledge',policyKey});assert.equal(ack.status,200);
const secondAck=await api('first',{action:'acknowledge',policyKey});assert.equal(secondAck.data.acknowledgedAt,ack.data.acknowledgedAt);
assert.deepEqual((await api('first')).data.acknowledged,[policyKey]);
assert.deepEqual((await api('second')).data.acknowledged,[]);
pass('automatic active policy is eligibility-scoped and acknowledgment is durable, idempotent and isolated per worker');

await pg.exec('reset role');
const snapshot=async date=>(await pg.query('select get_worker_finance_snapshot_v1($1,$2,$3::date) value',[pins.first,pins.first,date])).rows[0].value;
assert.equal((await snapshot('2026-11-30')).payroll.meal_bonus,3);
assert.equal((await snapshot('2026-11-30')).profile.meal_amount,3);
assert.equal((await snapshot('2026-12-01')).payroll.meal_bonus,78);
assert.equal((await snapshot('2026-12-01')).payroll.gross_fixed,578);
const profile=(await pg.query('select get_worker_compensation_profile_v1($1,$1) value',[pins.first])).rows[0].value;
assert.equal(profile.meal_amount,78);assert.equal(profile.legacy_meal_amount,3);
const closePreview=async month=>(await pg.query('select preview_monthly_payroll_close($1) value',[month])).rows[0].value.workers.find(row=>row.worker_id===ids.first);
assert.equal((await closePreview('2026-11')).net_pay,500);
assert.equal((await closePreview('2026-12')).net_pay,578);
assert.equal((await closePreview('2026-12')).meal_allowance,78);
assert.equal((await pg.query('select pay_meal_amount from users where id=$1',[ids.first])).rows[0].pay_meal_amount,'3');
await pg.query('update users set pay_transport_bonus_enabled=true,pay_transport_bonus_amount=20 where id=$1',[ids.first]);
assert.equal((await closePreview('2026-12')).net_pay,598);
assert.equal((await closePreview('2026-12')).fixed_transport_allowance,20);
assert.equal((await snapshot('2026-12-01')).payroll.gross_fixed,598);
assert.equal((await closePreview('2026-11')).net_pay,500);
await pg.query('update users set pay_transport_bonus_enabled=false,pay_transport_bonus_amount=0 where id=$1',[ids.first]);
await pg.query('select save_worker_compensation_profile_v1($1,$2,$3,$4::jsonb)',[pins.manager,'Fixture manager',pins.first,JSON.stringify({meal_enabled:true,meal_amount:78,notes:'Fixture roundtrip'})]);
assert.equal((await pg.query('select pay_meal_amount from users where id=$1',[ids.first])).rows[0].pay_meal_amount,'3.00');
assert.equal((await snapshot('2026-11-30')).payroll.meal_bonus,3);
assert.equal((await pg.query('select pay_notes from users where id=$1',[ids.first])).rows[0].pay_notes,'Fixture roundtrip');
await assert.rejects(()=>pg.query('select save_worker_compensation_profile_v1($1,$2,$3,$4::jsonb)',[pins.manager,'Fixture manager',pins.first,JSON.stringify({meal_enabled:true,meal_amount:99})]),/MEAL_POLICY_PROFILE_MANAGED_BY_SCHEDULE/);
pass('actual patched profile, finance snapshot and server monthly preview agree on 78 while historical profiles and open November are preserved');

const actor={id:ids.first,pin:pins.first,role:'PUNTOR',is_active:true};
const preview=await loadWorkerHandoffPreview({actor,date:'2026-12-01',getCurrentActor:()=>actor,readFinance:async()=>({worker:actor,profile:{salary_enabled:true,meal_enabled:true,commission_enabled:false,transport_bonus_enabled:false,ready_bonus_enabled:false,cash_mode:'FULL_CASH'},cash:{rows:[{id:'fixture-cash'}],open_gross:100,open_due_to_base:100,open_commission:0}}),readBonuses:async()=>[],readMeals:async()=>[{id:'fixture-old-meal',amount:3,created_at:'2026-11-30T10:00:00Z'}],readMealCoverage:async()=>[],readMealPolicy:async()=>active});
assert.equal(preview.unsettledMealDeduct,3);assert.equal(preview.mealPolicy.dailyMealsAllowed,false);assert.equal(preview.straightSalaryOnly,false);
await assert.rejects(()=>loadWorkerHandoffPreview({actor,date:'2026-12-01',getCurrentActor:()=>actor,readFinance:async()=>preview.finance,readBonuses:async()=>[],readMeals:async()=>[],readMealCoverage:async()=>[],readMealPolicy:async()=>{throw new Error('offline fixture');}}),/offline fixture/);
pass('December handoff retains a prior-day unsettled meal once and fails closed when its authoritative policy cannot load');

const pendingRows=[
  {id:901,created_by_pin:pins.first,type:'BASE',status:'PENDING_DISPATCH_APPROVAL',amount:75,created_at:'2026-12-02T10:00:00Z'},
  {id:902,created_by_pin:pins.first,type:'BASE',status:'PENDING_DISPATCH_APPROVAL',amount:45,created_at:'2026-12-02T10:00:00Z'},
  {id:903,created_by_pin:pins.first,type:'BASE',status:'PENDING_DISPATCH_APPROVAL',amount:5,created_at:'2026-12-02T10:00:00Z'},
];
const partialHandoffs=[{id:601,worker_pin:pins.first,receipt_tracking:true,status:'PENDING_DISPATCH_APPROVAL',amount:100,receipt_received_amount:90,receipt_resolved_amount:0,receipt_outstanding_amount:10,pending_payment_ids:[901,902]}];
assert.deepEqual(pendingPayrollHandoffSummary(pendingRows,partialHandoffs),{amount:15,count:2});
assert.equal(pendingPayrollHandoffSummary(pendingRows).amount,125);
assert.equal(buildMonthlyPayrollPreview({workers:[worker],paymentRows:pendingRows,month:'2026-12',mealPolicy:team,handoffs:partialHandoffs})[0].pendingHandoff,15);
assert.equal(buildMonthlyPayrollPreview({workers:[worker],paymentRows:pendingRows,month:'2026-11',mealPolicy:team,handoffs:partialHandoffs})[0].pendingHandoff,0);
assert.throws(()=>pendingPayrollHandoffSummary(pendingRows,[{...partialHandoffs[0],pending_payment_ids:undefined}]),/LINKS_UNAVAILABLE/);
assert.throws(()=>pendingPayrollHandoffSummary(pendingRows,[...partialHandoffs,{...partialHandoffs[0],id:602}]),/LINKS_AMBIGUOUS/);
pass('payroll uses a tracked 100/received 90 residual of 10 once across source items, retains untracked amounts and selected-month scope, and refuses missing links');

await pg.exec('set role service_role');
await validateMealPolicySalaryBasis(db,{workerPin:pins.first,workerId:ids.first,monthKey:'2026-12',baseSalary:578,amount:568,advanceAmount:10});
await validateMealPolicySalaryBasis(db,{workerPin:pins.first,workerId:ids.first,monthKey:'2026-11',baseSalary:503,amount:493,advanceAmount:10});
await assert.rejects(()=>validateMealPolicySalaryBasis(db,{workerPin:pins.first,workerId:ids.second,monthKey:'2026-12',baseSalary:578,amount:568,advanceAmount:10}),/QUOTE_CHANGED/);
const salaryPayload={action:'PAYROLL_SALARY_PAYMENT',actorPin:pins.manager,workerPin:pins.first,workerId:ids.first,monthKey:'2026-12',baseSalary:503,amount:493,advanceAmount:10,idempotencyKey:'fixture-stale-payroll'};
await assert.rejects(()=>runArkaTransaction(salaryPayload,{supabase:db}),/MEAL_POLICY_PAYROLL_QUOTE_CHANGED/);
await assert.rejects(()=>runArkaTransaction({...salaryPayload,baseSalary:578,amount:493},{supabase:db}),/MEAL_POLICY_PAYROLL_QUOTE_CHANGED/);
assert.equal((await pg.query('select current_balance from company_budget_summary where id=1')).rows[0].current_balance,'10000');
assert.equal((await pg.query("select count(*)::int count from arka_pending_payments where type='SALARY_PAYMENT'")).rows[0].count,0);
pass('server salary path rejects stale food gross/net before any financial write; earlier-month payment basis and supported advances remain unchanged');

await pg.exec('reset role');
for(const role of ['anon','authenticated']){
  await pg.exec('set role '+role);
  await assert.rejects(()=>pg.query('select * from meal_policy_members'),/permission denied/);
  await assert.rejects(()=>pg.query('select get_meal_policy_state_v1($1)',[ids.first]),/permission denied/);
  await assert.rejects(()=>pg.query('select acknowledge_meal_policy_v1($1,$2)',[ids.first,policyKey]),/permission denied/);
  await pg.exec('reset role');
}
await pg.query('update meal_policy_versions set enabled=false where policy_key=$1',[policyKey]);
assert.equal(Number((await pg.query('select meal_policy_amount_v1($1,$2::date,3) amount',[ids.first,'2026-12-01'])).rows[0].amount),3);
assert.equal((await pg.query('select count(*)::int count from meal_policy_acknowledgements')).rows[0].count,1);
assert.equal((await pg.query('select snapshot from payroll_month_closes where id=1')).rows[0].snapshot.net,517);
pass('RLS/grants keep raw policy and acknowledgments private; reversible policy switch retains acknowledgments, financial history and closed snapshots');
await pg.close();
console.log(`Meal monthly policy: ${passed} verification groups passed.`);
