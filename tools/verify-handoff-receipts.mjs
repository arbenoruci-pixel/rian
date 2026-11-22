import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { getHandoffReceiptTotals, getHandoffOutstandingAmount, validateReceiptAmount } from '../lib/handoffReceipts.js';
import { createHandoffReceiptHandler } from '../api/handoff-receipts.js';

// These are schema/function fixtures only. Every identity and amount below is synthetic.
const db = new PGlite();
const legacy = JSON.parse(fs.readFileSync('tools/fixtures/transport-control-ledger.json', 'utf8'));
const fixture = JSON.parse(fs.readFileSync('tools/fixtures/handoff-receipt-schema.json', 'utf8'));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.v;
const pass = message => console.log('PASS', message);
await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema private; grant usage on schema public,private to service_role,anon,authenticated;');
await db.exec(fs.readFileSync('tools/fixtures/base-bonus-evidence-schema.sql', 'utf8').split('CREATE OR REPLACE FUNCTION')[0]);
for (const table of ['cash_handoffs', 'cash_handoff_items', 'base_ready_bonus_allocations', 'company_budget_ledger', 'company_budget_summary', 'arka_cycles', 'arka_daily_close_items']) {
  const columns = [...legacy.columns, ...fixture.columns].filter(c => c.table === table);
  const defs = columns.map(c => `"${c.name}" ${c.default?.startsWith('nextval') ? 'bigserial' : (c.type === 'ARRAY' ? 'bigint[]' : c.type) + (c.default ? ' default ' + c.default : '')}${c.name === 'id' ? ' primary key' : ''}`);
  await db.exec(`create table public.${table}(${defs.join(',')});`);
}
await db.exec(`
  alter table cash_handoffs add constraint cash_handoffs_accepted_ledger_v1 check (status<>'ACCEPTED' or company_ledger_entry_id is not null);
  create unique index bonus_handoff_unique on base_ready_bonus_allocations(bonus_id,handoff_id);
  create unique index daily_item_unique on arka_daily_close_items(cycle_id,item_type,source_table,source_id) where source_id is not null;
  create unique index daily_date_unique on arka_cycles(cycle_date);
  create table arka_payment_exclusions(payment_id bigint,cancelled_at timestamptz);
  create table company_fixed_expenses(id int,amount numeric,active boolean,essential boolean);
  create table payroll_month_closes(id int,month_key text,status text,snapshot jsonb);
  create table worker_compensation_audit(worker_pin text,worker_name text,before_profile jsonb,after_profile jsonb,changed_by_pin text,changed_by_name text,change_note text);
  alter table base_ready_bonuses add column if not exists transport_control_id uuid;
  insert into company_budget_summary(id,current_balance,total_in,total_out)values(1,0,0,0);
`);
for (const f of legacy.functions.filter(f => ['base_ready_bonus_handoff_status_v1','base_ready_bonus_refresh_status_v1'].includes(f.name))) await db.exec(f.definition);
for (const f of fixture.functions.filter(f => f.name !== 'get_dispatch_daily_control_v1')) await db.exec(f.definition);
await db.exec('CREATE OR REPLACE FUNCTION public.preview_monthly_payroll_close' + fs.readFileSync('tools/fixtures/meal-policy-legacy-functions.sql','utf8').split('CREATE OR REPLACE FUNCTION public.preview_monthly_payroll_close')[1]);
await db.exec(fs.readFileSync('tools/fixtures/meal-policy-legacy-profile-save.sql','utf8'));
await db.exec(fs.readFileSync('tools/fixtures/handoff-receipt-daily-functions.sql', 'utf8'));
await db.exec(fs.readFileSync('tools/fixtures/handoff-receipt-legacy-guards.sql', 'utf8'));
await db.exec(fs.readFileSync('tools/fixtures/handoff-receipt-client-guard.sql', 'utf8'));
// Operations are outside this cash accounting test; actual preview v2/v3 and close v2 are retained.
await db.exec(`create function get_dispatch_daily_control_v1(text,date) returns jsonb language sql as $$select '{"operations":{}}'::jsonb$$;
  create trigger guard_handoff before insert or update on cash_handoffs for each row execute function private.guard_cash_handoff_v1();
  create trigger guard_ledger before insert or update on company_budget_ledger for each row execute function private.guard_company_budget_ledger_v1();
  create trigger guard_payment before insert or update on arka_pending_payments for each row execute function private.guard_arka_cash_payment_v1();
  create trigger guard_payment_client before insert or update on arka_pending_payments for each row execute function private.guard_arka_cash_payment_client_v2();
  create constraint trigger accepted_complete after insert or update on cash_handoffs deferrable initially deferred for each row when (new.status='ACCEPTED') execute function private.assert_accepted_handoff_complete_v1();
  create trigger handoff_bonus after update of status on cash_handoffs for each row execute function base_ready_bonus_handoff_status_v1();
  grant select on all tables in schema public to service_role;
`);
await db.exec(fs.readFileSync('supabase/migrations/20261122015736_meal_monthly_policy_v1.sql','utf8'));
const migration = fs.readFileSync('supabase/migrations/20261122015743_actual_handoff_receipts_v1.sql', 'utf8');
// Production's unchanged legacy payroll lines are CRLF while the preceding
// meal overlay adds LF lines. Preserve that shape to catch exact-anchor drift.
const deployedPayroll = JSON.parse(fs.readFileSync('tools/fixtures/handoff-receipt-payroll-after-meal.json','utf8')).definition;
assert.ok(deployedPayroll.includes('\r\n') && deployedPayroll.includes('meal_policy_amount_v1'));
await db.exec(deployedPayroll);
await db.exec(migration);
const patchedMixedPayroll = await one("select pg_get_functiondef('public.preview_monthly_payroll_close(text)'::regprocedure) v");
assert.match(await one("select definition v from private.handoff_receipts_v1_previous_functions where signature='preview_monthly_payroll_close(text)'"),/\r\n/);
// The same financial patch must also work on an LF-only database, and its
// normalized result must be identical to the deployed mixed-line-ending shape.
await db.exec(deployedPayroll.replaceAll('\r\n','\n'));
await db.exec(migration);
assert.equal((await one("select pg_get_functiondef('public.preview_monthly_payroll_close(text)'::regprocedure) v")).replaceAll('\r\n','\n'),patchedMixedPayroll.replaceAll('\r\n','\n'));
await db.exec(migration);
assert.equal(await one('select count(*)::int v from private.handoff_receipts_v1_previous_functions'),8);
assert.match(await one("select definition v from private.handoff_receipts_v1_previous_functions where signature='get_worker_finance_snapshot_v1(text,text,date)'"),/meal_policy_amount_v1/);
pass('migration handles live mixed CRLF/LF and LF-only payroll after the meal policy, reapplies safely, preserves backups and compiles against current cash, ledger, payment, deferred acceptance and bonus guards');

const manager = randomUUID(), worker = randomUUID(), secondManager = randomUUID();
for (const [id, pin, name, role] of [[manager,'9001','Fixture Manager','DISPATCH'],[secondManager,'9002','Second Manager','ADMIN'],[worker,'8001','Fixture Worker','PUNTOR']]) {
  await db.query('insert into users(id,pin,name,role,is_active,pay_ready_bonus_enabled)values($1,$2,$3,$4,true,true)', [id,pin,name,role]);
}
async function seedHandoff(amount = 100, pin = '8001', sourceAmount = amount) {
  return db.transaction(async tx => {
    const name = (await tx.query('select name from users where pin=$1',[pin])).rows[0].name;
    const p = (await tx.query("insert into arka_pending_payments(amount,type,status,created_by_pin,created_by_name,created_at,updated_at,idempotency_key) values($1,'IN','PENDING',$2,$4,now(),now(),$3) returning id", [sourceAmount,pin,randomUUID(),name])).rows[0].id;
    const h = (await tx.query("insert into cash_handoffs(worker_pin,worker_name,amount,status) values($1,$3,$2,'PENDING_DISPATCH_APPROVAL') returning id", [pin,amount,name])).rows[0].id;
    await tx.query('insert into cash_handoff_items(handoff_id,pending_payment_id,amount)values($1,$2,$3)', [h,p,amount]);
    await tx.query("update arka_pending_payments set status='PENDING_DISPATCH_APPROVAL' where id=$1", [p]);
    return { id: Number(h), paymentId: Number(p), amount };
  });
}
const getHandoff = h => one('select to_jsonb(h) v from cash_handoffs h where id=$1',[h.id]);
const balance = () => one('select current_balance::float8 v from company_budget_summary where id=1');
const receipt = (h, amount, expected, extra = {}) => one('select record_cash_handoff_receipt_v1($1,$2,$3,$4,$5,$6,$7,$8) v', [extra.actor || manager,h.id,extra.kind || 'RECEIPT',amount,expected,extra.reason || 'FIXTURE',extra.note ?? 'Fixture explanation',extra.key || randomUUID()]);
const legacyAccept = h => one('select accept_cash_handoff_atomic($1,$2,$3) v', [h.id,'9001','Fixture Manager']);

const old = await seedHandoff(25);
await legacyAccept(old);
const oldSnapshot = await getHandoff(old);
assert.equal(await balance(),25);
assert.equal(oldSnapshot.receipt_tracking,false);

const h = await seedHandoff(100,'8001',107.5), requestKey = randomUUID();
const bonusPayment = await one("insert into arka_pending_payments(amount,type,status,created_by_pin,created_by_name) values(7,'READY_48H_BONUS','PENDING','8001','Fixture Worker') returning id v");
const bonusId = await one("insert into base_ready_bonuses(worker_pin,worker_name,amount,remaining_amount,reserved_amount,retained_amount,status,eligible,arka_payment_id)values('8001','Fixture Worker',7,0,7,0,'RESERVED',true,$1) returning id v",[bonusPayment]);
await db.query("insert into base_ready_bonus_allocations(bonus_id,handoff_id,amount,status)values($1,$2,7,'RESERVED')",[bonusId,h.id]);
const transportBonusPayment = await one("insert into arka_pending_payments(amount,type,status,created_by_pin,created_by_name) values(0.5,'READY_48H_BONUS','PENDING','8001','Fixture Worker') returning id v");
const transportBonusId = await one("insert into base_ready_bonuses(worker_pin,worker_name,amount,remaining_amount,reserved_amount,retained_amount,status,eligible,arka_payment_id,transport_control_id)values('8001','Fixture Worker',0.5,0,0.5,0,'RESERVED',true,$1,$2) returning id v",[transportBonusPayment,randomUUID()]);
await db.query("insert into base_ready_bonus_allocations(bonus_id,handoff_id,amount,status)values($1,$2,0.5,'RESERVED')",[transportBonusId,h.id]);
let r = await receipt(h,70,100,{key:requestKey});
assert.equal(r.handoff.amount,100);
assert.equal(r.handoff.receipt_outstanding_amount,30);
assert.equal(r.handoff.status,'PENDING_DISPATCH_APPROVAL');
assert.equal(await balance(),95);
assert.equal(await one('select retained_amount::float8 v from base_ready_bonuses where id=$1',[bonusId]),7);
assert.equal(await one('select reserved_amount::float8 v from base_ready_bonuses where id=$1',[bonusId]),0);
assert.equal(await one('select retained_amount::float8 v from base_ready_bonuses where id=$1',[transportBonusId]),0.5);
assert.equal(await one('select amount::float8 v from arka_pending_payments where id=$1',[h.paymentId]),107.5);
const retainedAt = await one('select updated_at::text v from base_ready_bonus_allocations where bonus_id=$1',[bonusId]);
assert.equal(await one('select status v from arka_pending_payments where id=$1',[h.paymentId]),'PENDING_DISPATCH_APPROVAL');
assert.deepEqual(await getHandoff(old),oldSnapshot);
pass('partial receipt credits actual cash only, keeps expectation and client payment intact, retains bonus once and preserves old accepted history');

r = await receipt(h,70,100,{key:requestKey});
assert.equal(r.replayed,true); assert.equal(await balance(),95);
await assert.rejects(receipt(h,69,100,{key:requestKey}),/IDEMPOTENCY_CONFLICT/);
await assert.rejects(receipt(h,31,30),/AMOUNT_INVALID/);
await assert.rejects(receipt(h,-1,30),/AMOUNT_INVALID/);
await assert.rejects(receipt(h,0.001,30),/AMOUNT_INVALID/);
await assert.rejects(receipt(h,10,100),/STATE_CHANGED/);
await assert.rejects(receipt(h,10,30,{note:''}),/REASON_REQUIRED/);
await assert.rejects(receipt(h,10,30,{actor:worker}),/FORBIDDEN/);
const own = await seedHandoff(40,'9001');
await assert.rejects(receipt(own,40,40),/SELF_APPROVAL/);
assert.equal(await balance(),95);
pass('retries are idempotent; changed requests, invalid/over receipts, stale balances, missing reasons, workers and self-approval fail atomically');

await assert.rejects(legacyAccept(h),/USE_ACTUAL_RECEIPT|EXPECTATION_IMMUTABLE/);
await assert.rejects(db.query("update cash_handoffs set status='REJECTED' where id=$1",[h.id]),/USE_ACTUAL_RECEIPT/);
await assert.rejects(db.query("update cash_handoff_items set released_at=now() where handoff_id=$1",[h.id]),/IMMUTABLE/);
await assert.rejects(db.query("update arka_pending_payments set status='PENDING' where id=$1",[h.paymentId]),/PAYMENT_CHAIN_INVALID/);
await assert.rejects(db.query("update cash_handoffs set amount=99 where id=$1",[h.id]),/USE_ACTUAL_RECEIPT/);
await assert.rejects(db.query('delete from cash_handoff_receipt_events where handoff_id=$1',[h.id]),/IMMUTABLE/);
pass('cached legacy acceptance/rejection, client cash reopen, item release and receipt mutation cannot bypass the chain');

const race = await Promise.allSettled([receipt(h,10,30),receipt(h,10,30)]);
assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
assert.match(race.find(x=>x.status==='rejected').reason.message,/STATE_CHANGED/);
assert.equal(await balance(),105);
r = await receipt(h,20,20);
assert.equal(r.handoff.status,'ACCEPTED'); assert.equal(r.handoff.receipt_received_amount,100);
assert.equal(await balance(),125);
assert.equal(await one('select status v from arka_pending_payments where id=$1',[h.paymentId]),'ACCEPTED_BY_DISPATCH');
assert.equal(await one('select retained_amount::float8 v from base_ready_bonuses where id=$1',[bonusId]),7);
assert.equal(await one('select retained_amount::float8 v from base_ready_bonuses where id=$1',[transportBonusId]),0.5);
assert.equal(await one('select updated_at::text v from base_ready_bonus_allocations where bonus_id=$1',[bonusId]),retainedAt);
assert.equal(await one("select count(*)::int v from company_budget_ledger where related_handoff_id=$1 and source_type='cash_handoff'",[h.id]),0);
pass('queued competing requests use the outstanding comparison; later/final receipts settle once without repeating bonuses or legacy credit');

const shortage = await seedHandoff(60);
await receipt(shortage,50,60);
const beforeResolution = await balance();
r = await receipt(shortage,10,10,{kind:'RESOLUTION',note:'Fixture documented adjustment with no cash'});
assert.equal(await balance(),beforeResolution);
assert.equal(r.event.ledger_entry_id,null); assert.equal(r.event.outstanding_before,10); assert.equal(r.event.outstanding_after,0);
assert.equal(r.event.actor_id,manager); assert.equal(r.handoff.status,'ACCEPTED');
assert.equal(r.handoff.receipt_received_amount,50); assert.equal(r.handoff.receipt_resolved_amount,10);
const none = await seedHandoff(15);
await receipt(none,0,15);
r = await receipt(none,15,15,{kind:'RESOLUTION'});
assert.equal(r.handoff.company_ledger_entry_id,null); assert.equal(await balance(),beforeResolution);
pass('zero cash and audited noncash resolutions close only the recorded shortage and never add money to company budget');

await db.exec('set role anon');
await assert.rejects(receipt(await Promise.resolve({id:h.id}),1,1),/permission denied/);
await assert.rejects(db.query('select * from cash_handoff_receipt_events'),/permission denied/);
await db.exec('reset role; set role service_role');
await assert.rejects(db.query("insert into cash_handoff_receipt_events(handoff_id)values(1)"),/permission denied/);
await db.exec('reset role');
await db.exec('update cash_handoff_receipt_settings set enabled=false where id=1');
await assert.rejects(receipt(own,40,40,{actor:secondManager}),/WORKFLOW_PAUSED/);
assert.equal((await receipt(h,70,100,{key:requestKey})).replayed,true);
await db.exec('update cash_handoff_receipt_settings set enabled=true where id=1');
pass('new writes and raw event access are unavailable to client roles; pause preserves safe idempotent replay and all existing receipts');

const today = await one("select (now() at time zone 'Europe/Belgrade')::date::text v");
const businessDay = await one("select (now() at time zone 'Europe/Belgrade'-interval '4 hours')::date::text v");
let finance = await one('select get_worker_finance_snapshot_v1($1,$2,$3) v',['9001','8001',today]);
assert.equal(finance.cash.pending_handoff_total,0);
assert.equal(finance.cash.accepted_handoff_today,175);
assert.equal(finance.cash.received_handoff_total,175);
assert.equal(finance.cash.resolved_handoff_total,25);
const awaiting = await seedHandoff(80); await receipt(awaiting,65,80);
finance = await one('select get_worker_finance_snapshot_v1($1,$2,$3) v',['9001','8001',today]);
assert.equal(finance.cash.pending_handoff_total,15);
assert.equal(finance.cash.accepted_handoff_today,240);
const actualBudget = await balance();
const check = await one('select close_arka_day_receipts_v1($1,$2,$3,$4,$5,$6,$7,true) v',[manager,businessDay,actualBudget,actualBudget,'','',randomUUID()]);
assert.equal(check.expected_cash,actualBudget); assert.deepEqual(check.selected_handoff_ids,[]);
await assert.rejects(one('select close_arka_day_receipts_v1($1,$2,$3,$4,$5,$6,$7,false) v',[manager,businessDay,actualBudget,actualBudget-1,'','',randomUUID()]),/BUDGET_CHANGED/);
const closed = await one('select close_arka_day_receipts_v1($1,$2,$3,$4,$5,$6,$7,false) v',[manager,businessDay,actualBudget,actualBudget,'','',randomUUID()]);
assert.equal(closed.budget_balance,actualBudget);
assert.equal(closed.cycle.discrepancy,0);
assert.equal(closed.cycle.accepted_handoffs_total,actualBudget);
assert.equal(closed.items.filter(x=>x.source_table==='cash_handoff_receipt_events').reduce((n,x)=>n+x.amount,0),actualBudget-25);
assert.equal((await getHandoff(awaiting)).receipt_outstanding_amount,15);
pass('finance and close reports use actual receipts, preserve worker shortages and reject stale box totals');

const closeKey = randomUUID();
const closeArgs = [manager,businessDay,actualBudget-10,actualBudget,'FIXTURE_COUNT','Synthetic physical box difference',closeKey];
const firstClose = await one('select close_arka_day_receipts_v1($1,$2,$3,$4,$5,$6,$7,false) v',closeArgs);
const retryClose = await one('select close_arka_day_receipts_v1($1,$2,$3,$4,$5,$6,$7,false) v',closeArgs);
assert.equal(retryClose.replayed,true);
assert.equal(firstClose.cycle.discrepancy,-10); assert.deepEqual(retryClose.cycle,firstClose.cycle);
assert.equal(await one("select count(*)::int v from company_budget_ledger where category='DAILY_CASH_DISCREPANCY'"),1);
assert.equal(await balance(),actualBudget-10);
await db.exec('update cash_handoff_receipt_settings set enabled=false where id=1');
assert.equal((await one('select close_arka_day_receipts_v1($1,$2,$3,$4,$5,$6,$7,false) v',closeArgs)).replayed,true);
await assert.rejects(one('select close_arka_day_receipts_v1($1,$2,$3,$4,$5,$6,$7,false) v',[...closeArgs.slice(0,6),randomUUID()]),/WORKFLOW_PAUSED/);
await db.exec('update cash_handoff_receipt_settings set enabled=true where id=1');
await assert.rejects(one('select close_arka_day_receipts_v1($1,$2,$3,$4,$5,$6,$7,false) v',[...closeArgs.slice(0,2),actualBudget-11,...closeArgs.slice(3)]),/IDEMPOTENCY_CONFLICT/);
await assert.rejects(db.query('delete from cash_handoff_close_requests'),/IMMUTABLE/);
pass('lost daily-close response replays its exact saved result after a discrepancy, with one ledger adjustment and immutable audit');

const report = await one('select read_cash_handoff_receipts_v1($1,null) v',[manager]);
assert.equal(report.summary.outstandingTotal,55); assert.equal(report.summary.receivedToday,240);
assert.equal(report.handoffs.find(x=>Number(x.id)===own.id).can_receive,false);
assert.equal(report.handoffs.find(x=>Number(x.id)===awaiting.id).worker_id,worker);
assert.deepEqual(report.handoffs.find(x=>Number(x.id)===awaiting.id).pending_payment_ids,[awaiting.paymentId]);
assert.equal((await one('select read_cash_handoff_receipts_v1($1,null) v',[worker])).handoffs.every(x=>x.worker_pin==='8001'),true);
await assert.rejects(one('select read_cash_handoff_receipts_v1($1,$2) v',[worker,'9001']),/FORBIDDEN/);
pass('one stable read supplies canonical workers and exact manager totals; workers see only their own handoffs');
const payroll = await one('select preview_monthly_payroll_close($1) v',[today.slice(0,7)]);
assert.equal(payroll.pending_dispatch_total,55);
assert.equal(payroll.workers.find(x=>x.worker_id===worker).pending_dispatch_at_close,15);
assert.equal(payroll.workers.find(x=>x.worker_id===manager).pending_dispatch_at_close,40);
pass('monthly payroll pending cash replaces source payment amounts with each tracked handoff remaining amount once');

// Move only the first receipt into yesterday in this isolated synthetic fixture.
// This uses a privileged test setup operation; production mutation guards are restored immediately.
await db.exec('alter table cash_handoff_receipt_events disable trigger user; alter table company_budget_ledger disable trigger user;');
await db.query("update cash_handoff_receipt_events set created_at=now()-interval '1 day' where id=$1",[r.event.id]);
// Use a positive receipt so the day split is observable.
const firstEvent = await one("select id v from cash_handoff_receipt_events where handoff_id=$1 and amount=70",[h.id]);
await db.query("update cash_handoff_receipt_events set created_at=now()-interval '1 day' where id=$1",[firstEvent]);
await db.query("update company_budget_ledger set created_at=now()-interval '1 day' where source_type='cash_handoff_receipt' and source_id=$1",[firstEvent]);
await db.exec('alter table cash_handoff_receipt_events enable trigger user; alter table company_budget_ledger enable trigger user;');
finance = await one('select get_worker_finance_snapshot_v1($1,$2,$3) v',['9001','8001',today]);
assert.equal(finance.cash.accepted_handoff_today,170); assert.equal(finance.cash.received_handoff_total,240);
pass('a later final receipt contributes only the money received today, independently of the original handoff date');

assert.equal(getHandoffOutstandingAmount({ amount:100,status:'PENDING_DISPATCH_APPROVAL',receipt_tracking:true,receipt_received_amount:65,receipt_resolved_amount:5 }),30);
assert.equal(getHandoffReceiptTotals({ amount:100,status:'ACCEPTED' }).received,100);
assert.equal(validateReceiptAmount('0.001'),null);
assert.equal(validateReceiptAmount(''),null);

// Exercise the approved-device HTTP boundary against the same actual SQL RPCs.
const apiHandoff = await seedHandoff(20);
await db.exec('create table tepiha_user_devices(device_id text primary key,user_id uuid,is_approved boolean); grant select on tepiha_user_devices to service_role;');
for (const [device,id,approved] of [['fixture-manager',manager,true],['fixture-worker',worker,true],['fixture-unapproved',manager,false]]) await db.query('insert into tepiha_user_devices values($1,$2,$3)',[device,id,approved]);
function identityQuery(table) {
  assert.ok(['users','tepiha_user_devices'].includes(table));
  let fields='*'; const filters=[];
  const q={ select(value){assert.match(value,/^[a-z_,*]+$/);fields=value;return q;},eq(field,value){assert.match(field,/^[a-z_]+$/);filters.push([field,value]);return q;},maybeSingle(){return q;},then(resolve,reject){return db.query('select '+fields+' from '+table+' where '+filters.map(([field],i)=>field+'=$'+(i+1)).join(' and '),filters.map(([,value])=>value)).then(result=>resolve({data:result.rows[0]||null,error:null}),reject);} }; return q;
}
const rpcFields={read_cash_handoff_receipts_v1:['p_actor_id','p_worker_pin'],record_cash_handoff_receipt_v1:['p_actor_id','p_handoff_id','p_event_kind','p_amount','p_expected_outstanding','p_reason','p_note','p_request_key'],close_arka_day_receipts_v1:['p_actor_id','p_date','p_counted_cash','p_expected_budget','p_reason','p_note','p_request_key','p_dry_run']};
const connection={from:identityQuery,async rpc(name,args){const keys=rpcFields[name];assert.ok(keys);assert.deepEqual(Object.keys(args).sort(),[...keys].sort());try{return {data:await one('select '+name+'('+keys.map((_,i)=>'$'+(i+1)).join(',')+') v',keys.map(k=>args[k])),error:null};}catch(error){return {data:null,error:{message:error.message}};}}};
const handler=createHandoffReceiptHandler({createClient:()=>connection});
async function api(body={},overrides={}) {
  let output; const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(value){output=value;}};
  const req={method:overrides.method||'POST',headers:{host:'fixture.test',origin:'https://fixture.test','content-type':'application/json',cookie:'tepiha_device_id=fixture-manager',...overrides.headers},body:{expectedActorId:manager,...body}};
  await handler(req,res);return {status:res.statusCode,data:JSON.parse(output),headers:res.headers};
}
await db.exec('set role service_role');
assert.equal((await api({action:'list'},{headers:{cookie:''}})).status,401);
assert.equal((await api({action:'list'},{headers:{cookie:'tepiha_device_id=fixture-unapproved'}})).status,403);
assert.equal((await api({action:'list'},{headers:{origin:'https://elsewhere.test'}})).status,403);
assert.equal((await api({action:'list'},{headers:{'content-type':'text/plain'}})).status,415);
assert.equal((await api({action:'list'},{headers:{'content-length':'9000'}})).status,413);
assert.equal((await api({action:'list'},{method:'GET'})).status,405);
assert.equal((await api({action:'list',expectedActorId:worker})).status,403);
assert.equal((await api({action:'list',actorId:secondManager})).status,400);
assert.equal((await api({action:'list',targetPin:'9001',expectedActorId:worker},{headers:{cookie:'tepiha_device_id=fixture-worker'}})).status,403);
const apiPayload={action:'receive',handoffId:apiHandoff.id,amount:5,expectedOutstanding:20,note:'Fixture short receipt',requestKey:randomUUID()};
assert.equal((await api({...apiPayload,expectedActorId:worker},{headers:{cookie:'tepiha_device_id=fixture-worker'}})).status,403);
assert.equal((await api({...apiPayload,amount:null})).status,400);
assert.equal((await api({...apiPayload,amount:''})).status,400);
assert.equal((await api({...apiPayload,amount:20.01})).status,400);
const acceptedApi=await api(apiPayload);
assert.equal(acceptedApi.status,200,JSON.stringify(acceptedApi.data)); assert.equal(acceptedApi.data.handoff.outstanding,15);
assert.equal((await api(apiPayload)).data.replayed,true);
assert.equal((await api({...apiPayload,action:'resolve',amount:15,expectedOutstanding:15,requestKey:randomUUID(),confirmNoCash:false})).status,400);
const listApi=await api({action:'list'});
assert.equal(listApi.status,200);assert.match(listApi.headers['cache-control'],/no-store/);
assert.equal(listApi.data.handoffs.find(x=>x.id===apiHandoff.id).worker_id,worker);
assert.deepEqual(listApi.data.handoffs.find(x=>x.id===apiHandoff.id).pending_payment_ids,[apiHandoff.paymentId]);
assert.ok(listApi.data.events.every(e=>!('payload_hash' in e)&&!('request_key' in e)&&!('actor_id' in e)));
const apiBudget=await balance();
const dryApi=await api({action:'daily-check',date:businessDay,countedCash:apiBudget,expectedBudget:apiBudget,reason:'NO_DISCREPANCY',note:'',requestKey:randomUUID()});
assert.equal(dryApi.status,200,JSON.stringify(dryApi.data));assert.deepEqual(dryApi.data.selected_handoff_ids,[]);
await db.exec('reset role');
pass('approved-cookie API enforces active identity, same origin, role/scope, exact request fields, cents, noncash confirmation, stable retry and cash-only day check');
await db.close();
console.log('PASS all actual handoff receipt checks');
