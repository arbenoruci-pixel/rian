import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createWorkerHandoffTestDb } from './fixtures/worker-handoff-test-db.mjs';

// Actual SQL and actual HTTP boundary, against synthetic local PostgreSQL data.
// This test never connects to Supabase or writes a production financial record.
const oldActorId = randomUUID();
let oldHandoff,postCutoffLegacyFood;
const { db, migrationPaths } = await createWorkerHandoffTestDb({
  async beforeWizardMigration(pg) {
    await pg.query("insert into users(id,pin,name,role,is_active)values($1,'7999','Historical fixture','PUNTOR',true)",[oldActorId]);
    const payment = (await pg.query("insert into arka_pending_payments(amount,type,status,created_by_pin,created_by_name,created_at,updated_at,idempotency_key)values(87.23,'IN','PENDING','7999','Historical fixture',now(),now(),$1)returning id",[randomUUID()])).rows[0].id;
    const h = (await pg.query("insert into cash_handoffs(worker_pin,worker_name,amount,status,submitted_at)values('7999','Historical fixture',74.70,'PENDING_DISPATCH_APPROVAL',now())returning id")).rows[0].id;
    await pg.query('insert into cash_handoff_items(handoff_id,pending_payment_id,amount)values($1,$2,74.70)',[h,payment]);
    await pg.query("update arka_pending_payments set status='PENDING_DISPATCH_APPROVAL' where id=$1",[payment]);
    oldHandoff = (await pg.query('select to_jsonb(h) value from cash_handoffs h where id=$1',[h])).rows[0].value;
    postCutoffLegacyFood=Number((await pg.query("insert into arka_pending_payments(amount,type,status,note,created_by_pin,created_by_name,created_at,updated_at,idempotency_key)values(12,'EXPENSE','PENDING','Buk','7999','Historical fixture','2026-12-01T08:00:00Z',now(),$1)returning id",[randomUUID()])).rows[0].id);
  },
});
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0]?.value;
const pass = text => console.log('PASS', text);
const clock = value => db.query("select set_config('fixture.now',$1,false)",[value]);
const balance = () => one('select current_balance::float8 value from company_budget_summary where id=1');
const ledgerCount = () => one('select count(*)::int value from company_budget_ledger');
const receiptCount = () => one('select count(*)::int value from cash_handoff_receipt_events');
const financialState = async () => ({balance:await balance(),ledgerCount:await ledgerCount(),receiptCount:await receiptCount()});
const emptyOptions = () => ({mealChoice:'none',expenses:[]});
const preview = (actor,options=emptyOptions()) => one('select preview_worker_handoff_v1($1,$2::jsonb) value',[actor.id,JSON.stringify(options)]);
const submit = (actor,quote,{options=quote.options ?? emptyOptions(),physicalCash=quote.totals.projectedCash,differenceReason='',requestKey=randomUUID()}={}) => one('select submit_worker_handoff_v1($1,$2,$3,$4::jsonb,$5,$6) value',[actor.id,quote.snapshotHash,requestKey,JSON.stringify(options),physicalCash,differenceReason]);
const readSubmission = (actor,handoffId) => one('select read_worker_handoff_submission_v1($1,$2) value',[actor.id,handoffId]);
const decide = (actor,claimId,{approve=true,note='Verified synthetic receipt and funding source',requestKey=randomUUID()}={}) => one('select decide_worker_handoff_expense_v1($1,$2,$3,$4,$5) value',[actor.id,claimId,approve,note,requestKey]);
const reimburse = (actor,claimId,{amount=12,note='Handed exact reimbursement to fixture worker',requestKey=randomUUID()}={}) => one('select reimburse_worker_handoff_expense_v1($1,$2,$3,$4,$5) value',[actor.id,claimId,amount,note,requestKey]);
const receive = (actor,handoffId,amount,expected) => one('select record_cash_handoff_receipt_v1($1,$2,$3,$4,$5,$6,$7,$8) value',[actor.id,handoffId,'RECEIPT',amount,expected,'FIXTURE_COUNT','Synthetic physical cash count',randomUUID()]);
let workerNumber = 8100;
async function worker(role='PUNTOR',extras={}) {
  const actor={id:randomUUID(),pin:String(++workerNumber),name:`Fixture worker ${workerNumber}`,role,is_active:true};
  await db.query(`insert into users(id,pin,name,role,is_active,salary,salary_day,avans_manual,borxh_afatgjat,
    pay_salary_enabled,pay_meal_enabled,pay_meal_amount,pay_commission_enabled,pay_commission_rate_m2,
    pay_transport_bonus_enabled,pay_transport_bonus_amount,pay_ready_bonus_enabled,pay_cash_mode,
    is_hybrid_transport,commission_rate_m2,bonus_ushqim,bonus_transport)
    values($1,$2,$3,$4,true,500,1,0,0,true,$5,3,false,0,false,0,true,'FULL_CASH',false,0,3,0)`,[actor.id,actor.pin,actor.name,role,extras.mealEnabled??true]);
  return actor;
}
async function payment(actor,amount,{source='BASE',status='PENDING',createdAt='2026-11-21T10:00:00Z',m2=null}={}) {
  const orderId=await one("insert into orders(code,client_name,status,price_total,paid,paid_cash,created_at,updated_at,data)values(1000,'Fixture client','dorzim',$1,$1,$1,now(),now(),'{}')returning id value",[amount]);
  return Number(await one(`insert into arka_pending_payments(order_id,order_code,client_name,amount,type,status,source_module,created_by_pin,created_by_name,created_at,updated_at,idempotency_key,transport_m2)
    values($1,1000,'Fixture client',$2,$3,$4,$5,$6,$7,$8,now(),$9,$10)returning id value`,[orderId,amount,source==='TRANSPORT'?'TRANSPORT':'IN',status,source,actor.pin,actor.name,createdAt,randomUUID(),m2]));
}
async function bonus(actor,amount,{transport=false}={}) {
  const id=await one("insert into arka_pending_payments(amount,type,status,created_by_pin,created_by_name,created_at,updated_at,idempotency_key)values($1,'READY_48H_BONUS','PENDING',$2,$3,now(),now(),$4)returning id value",[amount,actor.pin,actor.name,randomUUID()]);
  return Number(await one(`insert into base_ready_bonuses(worker_pin,worker_name,amount,remaining_amount,reserved_amount,retained_amount,status,eligible,arka_payment_id,created_at,updated_at,ready_at,transport_control_id,qualification_source)
    values($1,$2,$3,$3,0,0,'AVAILABLE',true,$4,now(),now(),now(),$5,$6)returning id value`,[actor.pin,actor.name,amount,id,transport?randomUUID():null,transport?'TRANSPORT_CONTROL':'PAYMENT']));
}
async function expense(actor,amount,{approved=false,manager,createdAt=null,note='Fixture supplies'}={}) {
  const id=Number(await one("insert into arka_pending_payments(amount,type,status,created_by_pin,created_by_name,note,created_at,updated_at,idempotency_key)values($1,'EXPENSE','PENDING',$2,$3,$6,coalesce($5::timestamptz,now()),now(),$4)returning id value",[amount,actor.pin,actor.name,randomUUID(),createdAt,note]));
  if(approved) await one('select resolve_arka_expense_v2($1,$2,$3,$4,null,null,$5) value',[manager.pin,manager.name,id,'BUSINESS_EXPENSE','Verified fixture business expense']);
  return id;
}
const claim = (existingPaymentId,overrides={}) => ({clientKey:randomUUID(),existingPaymentId,amount:12,description:'Fixture supplies',spentOn:'2026-11-21',category:'SUPPLIES',recipient:'Fixture shop',fundingSource:'WORKER_COLLECTIONS',includesOwnMeal:false,...overrides});

for(const path of migrationPaths) await db.exec(fs.readFileSync(path,'utf8'));
assert.deepEqual(await one('select to_jsonb(h) value from cash_handoffs h where id=$1',[oldHandoff.id]),oldHandoff);
await assert.rejects(db.query("insert into cash_handoffs(worker_pin,worker_name,amount,status)values('7999','Historical fixture',1,'PENDING_DISPATCH_APPROVAL')"),/WHW_USE_WIZARD/);
pass('additive migration reapplies safely and preserves an existing pending handover exactly');

const manager=await worker('DISPATCH'),otherManager=await worker('ADMIN'),first=await worker();
const firstPayment=await payment(first,100);
await payment(otherManager,30);
const reassigned=await payment(first,20);
await db.query('update arka_pending_payments set handed_by_pin=$2 where id=$1',[reassigned,manager.pin]);
const excluded=await payment(first,8);
await db.query('insert into arka_payment_exclusions(payment_id,cancelled_at)values($1,null)',[excluded]);
await expense(first,7);
await one("insert into arka_pending_payments(amount,type,status,source_module,created_by_pin,created_by_name,created_at,updated_at,idempotency_key)values(99,'FIXTURE_NONCASH','PENDING','TRANSPORT',$1,$2,now(),now(),$3)returning id value",[first.pin,first.name,randomUUID()]);
await bonus(first,9.5); await bonus(first,0.5,{transport:true});
const firstOptions={mealChoice:'self',expenses:[]};
const beforeQuote=await financialState();
const q=await preview(first,firstOptions);
assert.equal(q.ok,true);assert.equal(q.canSubmit,true);assert.equal(q.actorId,first.id);
assert.equal(q.payments.length,1);assert.equal(Number(q.payments[0].id),firstPayment);
assert.equal(q.totals.grossCash,100);assert.equal(q.totals.bonusDeduction,10);assert.equal(q.totals.mealDeduction,3);assert.equal(q.totals.expectedCash,87);assert.equal(q.totals.projectedCash,87);
await assert.rejects(preview(first,{...firstOptions,paymentIds:[reassigned]}),/OPTIONS|INVALID/);
assert.deepEqual(await financialState(),beforeQuote);
const requestKey=randomUUID();
const firstSubmit=await submit(first,q,{options:firstOptions,physicalCash:25,differenceReason:'Only 25 counted; rest needs reconciliation',requestKey});
assert.equal(firstSubmit.ok,true);assert.equal(firstSubmit.submission.physicalCash,25);assert.equal(firstSubmit.submission.expectedCash,87);
assert.equal(Math.abs(firstSubmit.submission.differenceAmount),62);
assert.equal(await one('select amount::float8 value from cash_handoffs where id=$1',[firstSubmit.handoffId]),87);
assert.equal(await one('select amount::float8 value from arka_pending_payments where id=$1',[firstPayment]),100);
assert.deepEqual(await financialState(),beforeQuote);
assert.equal(await one("select count(*)::int value from cash_handoff_items where handoff_id=$1",[firstSubmit.handoffId]),1);
assert.equal(await one('select sum(reserved_amount)::float8 value from base_ready_bonuses where worker_pin=$1',[first.pin]),10);
assert.equal(await one('select sum(retained_amount)::float8 value from base_ready_bonuses where worker_pin=$1',[first.pin]),0);
await assert.rejects(one('select accept_cash_handoff_atomic($1,$2,$3) value',[firstSubmit.handoffId,manager.pin,manager.name]),/ACTUAL_RECEIPT|USE_ACTUAL|WIZARD/);
assert.deepEqual(await financialState(),beforeQuote);
pass('server preview itemizes cash, Base/Transport bonuses and meal; worker physical count is stored separately without receipt, ledger credit, debt rewrite or expectation change');

const replay=await submit(first,q,{options:firstOptions,physicalCash:25,differenceReason:'Only 25 counted; rest needs reconciliation',requestKey});
assert.equal(replay.replayed,true);assert.equal(replay.handoffId,firstSubmit.handoffId);
await assert.rejects(submit(first,q,{options:firstOptions,physicalCash:26,differenceReason:'Only 25 counted; rest needs reconciliation',requestKey}),/CONFLICT|MISMATCH/);
const beforeReceive=await balance();
await receive(manager,firstSubmit.handoffId,25,87);
assert.equal(await balance(),beforeReceive+25);
assert.equal(await one('select sum(retained_amount)::float8 value from base_ready_bonuses where worker_pin=$1',[first.pin]),10);
assert.equal(await one('select receipt_outstanding_amount::float8 value from cash_handoffs where id=$1',[firstSubmit.handoffId]),62);
assert.equal((await submit(first,q,{options:firstOptions,physicalCash:25,differenceReason:'Only 25 counted; rest needs reconciliation',requestKey})).replayed,true);
await assert.rejects(readSubmission(await worker(),firstSubmit.handoffId),/FORBIDDEN|SCOPE|NOT_FOUND/);
assert.equal((await readSubmission(manager,firstSubmit.handoffId)).submission.physicalCash,25);
pass('lost-response retries reuse one handover and snapshot before/after partial acceptance; changed payload and other-worker reads fail');

const fresh=await worker();await payment(fresh,40);
let stale=await preview(fresh);
await payment(fresh,10);
const stateBeforeStale=await financialState();
await assert.rejects(submit(fresh,stale),/CHANGED|STALE|QUOTE|SNAPSHOT/);
assert.deepEqual(await financialState(),stateBeforeStale);
stale=await preview(fresh);
await assert.rejects(submit(fresh,stale,{physicalCash:45,differenceReason:''}),/REASON|DIFFERENCE/);
for(const invalid of [-1,0.001,'NaN','Infinity',null,'']) await assert.rejects(submit(fresh,stale,{physicalCash:invalid,differenceReason:'Invalid physical amount fixture'}),/AMOUNT|CASH|INVALID|REQUIRED|invalid input syntax/i);
const again=await submit(fresh,stale);
const afterSecond=await preview(first);
assert.equal(afterSecond.payments.length,0);assert.equal(afterSecond.canSubmit,false);
assert.ok(afterSecond.pendingHandoffs.some(h=>Number(h.id)===Number(firstSubmit.handoffId)));
pass('stale quotes and invalid/blank physical counts fail atomically; pending earlier handovers never become new client cash');

const hybrid=await worker();
await db.query('update users set is_hybrid_transport=true,commission_rate_m2=0.1,pay_commission_enabled=true,pay_commission_rate_m2=0.1 where id=$1',[hybrid.id]);
await payment(hybrid,100,{source:'TRANSPORT',m2:20.05});
const hybridQuote=await preview(hybrid);
assert.equal(hybridQuote.totals.commission,2);assert.equal(hybridQuote.totals.expectedCash,98);
const hybridSubmit=await submit(hybrid,hybridQuote);
assert.equal(hybridSubmit.submission.expectedCash,98);assert.equal(await one('select amount::float8 value from cash_handoffs where id=$1',[hybridSubmit.handoffId]),98);
pass('hybrid transport preview and atomic submit share per-payment rounding at a half-cent commission boundary');

const funded=await worker();await payment(funded,100);await bonus(funded,10);
const fundingStart=await balance();
const approvedExpense=await expense(funded,12,{approved:true,manager});
assert.equal(await balance(),fundingStart-12);
const fundedOptions={mealChoice:'self',expenses:[claim(approvedExpense)]};
const fundedQuote=await preview(funded,fundedOptions);
assert.equal(fundedQuote.totals.expectedCash,87);assert.equal(fundedQuote.totals.claimedCollectionExpenses,12);assert.equal(fundedQuote.totals.projectedCash,75);
const submittedFunding=await submit(funded,fundedQuote,{options:fundedOptions});
assert.equal(await balance(),fundingStart-12);
const expenseClaim=submittedFunding.claims[0];
await assert.rejects(decide(funded,expenseClaim.id),/FORBIDDEN|SELF_APPROVAL/);
const decisionKey=randomUUID();
const beforeUncountedApproval=await financialState();
await assert.rejects(decide(manager,expenseClaim.id,{requestKey:decisionKey}),/RECEIPT|COUNT|TRACK|PHYSICAL/);
assert.deepEqual(await financialState(),beforeUncountedApproval);
await receive(manager,submittedFunding.handoffId,75,87);
await decide(manager,expenseClaim.id,{requestKey:decisionKey});
assert.equal(await balance(),fundingStart+75);
assert.equal(await one('select receipt_resolved_amount::float8 value from cash_handoffs where id=$1',[submittedFunding.handoffId]),12);
assert.equal(await one('select receipt_received_amount::float8 value from cash_handoffs where id=$1',[submittedFunding.handoffId]),75);
const ledgerAfterDecision=await ledgerCount();
await decide(manager,expenseClaim.id,{requestKey:decisionKey});
assert.equal(await ledgerCount(),ledgerAfterDecision);
await assert.rejects(decide(manager,expenseClaim.id,{approve:false,requestKey:decisionKey}),/CONFLICT|MISMATCH/);
await assert.rejects(decide(otherManager,expenseClaim.id),/NOT_PENDING|ALREADY/);
assert.equal(await ledgerCount(),ledgerAfterDecision);
assert.equal(await balance(),fundingStart+75);
assert.equal(await one('select amount::float8 value from arka_pending_payments where id=$1',[approvedExpense]),12);
assert.equal(await one("select sum(amount)::float8 value from cash_handoff_receipt_events where handoff_id=$1 and event_kind='RECEIPT'",[submittedFunding.handoffId]),75);
await assert.rejects(db.query('update worker_handoff_submissions set physical_cash=99 where handoff_id=$1',[submittedFunding.handoffId]),/IMMUTABLE/);
await assert.rejects(db.query("update company_budget_ledger set description='Tampered fixture description' where id=(select expense_ledger_id from worker_handoff_expense_claims where id=$1)",[expenseClaim.id]),/IMMUTABLE/);
await assert.rejects(db.query("update arka_expense_decisions set note='Tampered decision' where expense_payment_id=$1",[approvedExpense]),/IMMUTABLE|EXPENSE_REVIEW/);
pass('client-funded approved expense is reclassified exactly once, resolves obligation without fake cash, and actual receipt yields the correct drawer balance');

await payment(funded,20);
await assert.rejects(preview(funded,{mealChoice:'existing',expenses:[claim(approvedExpense)]}),/EXPENSE|CLAIM|USED|ASSIGNED|AVAILABLE/);
const stranger=await worker();await payment(stranger,20);
await assert.rejects(preview(stranger,{mealChoice:'none',expenses:[claim(approvedExpense)]}),/EXPENSE|FORBIDDEN|OWNER|AVAILABLE/);
const drawer=await worker();await payment(drawer,100);await bonus(drawer,10);
const drawerStart=await balance();
const drawerExpense=await expense(drawer,12,{approved:true,manager});
const drawerOptions={mealChoice:'self',expenses:[claim(drawerExpense,{fundingSource:'DISPATCH_DRAWER'})]};
const drawerQuote=await preview(drawer,drawerOptions);
assert.equal(drawerQuote.totals.claimedCollectionExpenses,0);assert.equal(drawerQuote.totals.projectedCash,87);
const drawerSubmit=await submit(drawer,drawerQuote,{options:drawerOptions});
await decide(manager,drawerSubmit.claims[0].id);
assert.equal(await balance(),drawerStart-12);
assert.equal(await one('select coalesce(receipt_resolved_amount,0)::float8 value from cash_handoffs where id=$1',[drawerSubmit.handoffId]),0);
await receive(manager,drawerSubmit.handoffId,87,87);
assert.equal(await balance(),drawerStart+75);
pass('used/foreign expenses cannot be reused; drawer-funded expense stays separate and produces the same correct final drawer balance');

const newExpenseWorker=await worker();await payment(newExpenseWorker,60);
const pendingOptions={mealChoice:'none',expenses:[claim(null,{amount:12})]};
const pendingQuote=await preview(newExpenseWorker,pendingOptions);
const pendingStart=await financialState();
const pendingSubmission=await submit(newExpenseWorker,pendingQuote,{options:pendingOptions});
assert.deepEqual(await financialState(),pendingStart);
assert.equal(pendingSubmission.submission.expectedCash,60);assert.equal(pendingSubmission.submission.projectedCash,48);
await decide(manager,pendingSubmission.claims[0].id,{approve:false,note:'Receipt does not support this business expense'});
assert.deepEqual(await financialState(),pendingStart);
assert.equal(await one('select coalesce(receipt_resolved_amount,0)::float8 value from cash_handoffs where id=$1',[pendingSubmission.handoffId]),0);
pass('unapproved new expenses are claims only; rejection never lowers obligation or changes company cash');

const newApprovedWorker=await worker();await payment(newApprovedWorker,60);
const newApprovedOptions={mealChoice:'none',expenses:[claim(null)]};
const newApprovedQuote=await preview(newApprovedWorker,newApprovedOptions);
const newApprovedStart=await balance();
const newApprovedSubmit=await submit(newApprovedWorker,newApprovedQuote,{options:newApprovedOptions});
await assert.rejects(one('select resolve_arka_expense_v2($1,$2,$3,$4,null,null,$5) value',[manager.pin,manager.name,newApprovedSubmit.claims[0].paymentId,'BUSINESS_EXPENSE','Cached legacy approval attempt']),/EXPENSE_REVIEW|IMMUTABLE/);
assert.equal(await balance(),newApprovedStart);
await receive(manager,newApprovedSubmit.handoffId,48,60);
await decide(manager,newApprovedSubmit.claims[0].id);
assert.equal(await balance(),newApprovedStart+48);
assert.equal(await one('select receipt_received_amount::float8 value from cash_handoffs where id=$1',[newApprovedSubmit.handoffId]),48);
assert.equal(await one('select receipt_resolved_amount::float8 value from cash_handoffs where id=$1',[newApprovedSubmit.handoffId]),12);
pass('new collection-funded expense approval records the expense once and resolves its offset without inventing received cash');

const personal=await worker();await payment(personal,60);
const personalOptions={mealChoice:'none',expenses:[claim(null,{fundingSource:'OWN_MONEY'})]};
const personalQuote=await preview(personal,personalOptions);
assert.equal(personalQuote.totals.claimedCollectionExpenses,0);assert.equal(personalQuote.totals.projectedCash,60);
const personalStart=await financialState();
const personalSubmit=await submit(personal,personalQuote,{options:personalOptions});
await decide(manager,personalSubmit.claims[0].id);
assert.deepEqual(await financialState(),personalStart);
const personalRead=await readSubmission(manager,personalSubmit.handoffId);
assert.equal(personalRead.claims[0].status,'REIMBURSEMENT_PENDING');
assert.equal(await one('select coalesce(receipt_resolved_amount,0)::float8 value from cash_handoffs where id=$1',[personalSubmit.handoffId]),0);
const personalDay=await one('select get_arka_daily_close_preview_v4($1,$2) value',[manager.pin,'2026-11-21']);
assert.ok(!personalDay.pending_expenses.some(row=>Number(row.id)===Number(personalSubmit.claims[0].paymentId)),'Acknowledged personal-money reimbursement must not block day close as an undecided cash expense');
pass('expense paid from personal money keeps full collected cash due and waits for an explicit reimbursement');

const personalClaim=personalRead.claims[0];
assert.equal(personalClaim.canReimburse,true);
await assert.rejects(reimburse(personal,personalClaim.id),/FORBIDDEN|SELF_APPROVAL/);
await assert.rejects(reimburse(manager,personalClaim.id,{amount:11}),/AMOUNT|MISMATCH/);
assert.deepEqual(await financialState(),personalStart);
const reimbursementKey=randomUUID();
await reimburse(manager,personalClaim.id,{requestKey:reimbursementKey});
const personalPaid=await financialState();
assert.equal(personalPaid.balance,personalStart.balance-12);assert.equal(personalPaid.ledgerCount,personalStart.ledgerCount+1);assert.equal(personalPaid.receiptCount,personalStart.receiptCount);
const reimbursedClaim=(await readSubmission(manager,personalSubmit.handoffId)).claims[0];
assert.equal(reimbursedClaim.status,'REIMBURSED');assert.equal(reimbursedClaim.canReimburse,false);
assert.equal(reimbursedClaim.decidedByName,personalClaim.decidedByName);assert.equal(reimbursedClaim.decisionNote,personalClaim.decisionNote);
assert.equal(reimbursedClaim.reimbursedByName,manager.name);assert.equal(reimbursedClaim.reimbursementNote,'Handed exact reimbursement to fixture worker');assert.ok(reimbursedClaim.reimbursedAt);
assert.equal((await reimburse(manager,personalClaim.id,{requestKey:reimbursementKey})).replayed,true);
await assert.rejects(reimburse(manager,personalClaim.id,{requestKey:reimbursementKey,note:'Changed payout retry'}),/CONFLICT|MISMATCH/);
await assert.rejects(reimburse(otherManager,personalClaim.id),/NOT_PENDING|ALREADY|STATE/);
assert.deepEqual(await financialState(),personalPaid);
assert.equal(await one('select coalesce(receipt_resolved_amount,0)::float8 value from cash_handoffs where id=$1',[personalSubmit.handoffId]),0);
const managerPersonalOptions={mealChoice:'none',expenses:[claim(null,{fundingSource:'OWN_MONEY'})]};
const managerPersonalQuote=await preview(otherManager,managerPersonalOptions);
const managerPersonalSubmit=await submit(otherManager,managerPersonalQuote,{options:managerPersonalOptions});
await decide(manager,managerPersonalSubmit.claims[0].id);
await assert.rejects(reimburse(otherManager,managerPersonalSubmit.claims[0].id),/SELF_APPROVAL/);
pass('explicit reimbursement creates one real company outflow; wrong amount, worker/self payment and changed or repeated payout cannot duplicate it');

const foodWorker=await worker();await payment(foodWorker,100);await bonus(foodWorker,10);
const foodStart=await balance();
const foodPayment=await expense(foodWorker,12,{approved:true,manager});
const foodOptions={mealChoice:'self',expenses:[claim(foodPayment,{category:'FOOD',includesOwnMeal:true})]};
const foodQuote=await preview(foodWorker,foodOptions);
assert.equal(foodQuote.totals.mealDeduction,3);assert.equal(foodQuote.totals.expectedCash,87);
assert.equal(foodQuote.expenses[0].mealAlreadyDeducted,3);assert.equal(foodQuote.expenses[0].deductionAmount,9);
assert.equal(foodQuote.totals.claimedCollectionExpenses,9);assert.equal(foodQuote.totals.projectedCash,78);
await assert.rejects(preview(foodWorker,{mealChoice:'none',expenses:foodOptions.expenses}),/MEAL|OVERLAP/);
await assert.rejects(preview(foodWorker,{mealChoice:'self',expenses:[...foodOptions.expenses,claim(null,{category:'FOOD',includesOwnMeal:true})]}),/MEAL|OVERLAP/);
await assert.rejects(preview(foodWorker,{mealChoice:'self',expenses:[foodOptions.expenses[0],{...foodOptions.expenses[0],clientKey:randomUUID()}]}),/CLAIM|DUPLICATE/);
const foodSubmit=await submit(foodWorker,foodQuote,{options:foodOptions});
await receive(manager,foodSubmit.handoffId,78,87);
await decide(manager,foodSubmit.claims[0].id);
assert.equal(await balance(),foodStart+78);
assert.equal(await one('select receipt_resolved_amount::float8 value from cash_handoffs where id=$1',[foodSubmit.handoffId]),9);
assert.equal(await one('select receipt_received_amount::float8 value from cash_handoffs where id=$1',[foodSubmit.handoffId]),78);
assert.equal(await one('select amount::float8 value from arka_pending_payments where id=$1',[foodPayment]),12);
pass('team food including the worker’s already deducted daily meal credits exactly €3 once; total €12 food creates only €9 extra offset, with €78 physical received');

async function recordedMeal(payer,targets) {
  return one('select create_meal_distribution_atomic($1,$2,$3,$1,$2,$3,$4,3,$5::jsonb,$6,null) value',[payer.pin,payer.name,payer.role,'2026-11-21',JSON.stringify(targets.map(actor=>({pin:actor.pin,name:actor.name,role:actor.role}))),'Synthetic recorded team food']);
}
const groupPayer=await worker();await payment(groupPayer,100);
await recordedMeal(groupPayer,[groupPayer,await worker(),await worker(),await worker()]);
assert.equal((await preview(groupPayer,{mealChoice:'existing',expenses:[]})).totals.mealDeduction,12);
await assert.rejects(preview(groupPayer,{mealChoice:'existing',expenses:[claim(null,{category:'FOOD',includesOwnMeal:true})]}),/MEAL_EXPENSE_OVERLAP/);
const priorSelfPayer=await worker();await payment(priorSelfPayer,100);
await recordedMeal(priorSelfPayer,[priorSelfPayer]);
const priorSelfQuote=await preview(priorSelfPayer,{mealChoice:'existing',expenses:[claim(null,{category:'FOOD',includesOwnMeal:true})]});
assert.equal(priorSelfQuote.totals.mealDeduction,3);assert.equal(priorSelfQuote.totals.claimedCollectionExpenses,9);assert.equal(priorSelfQuote.totals.projectedCash,88);
pass('grouped team meal already deducted cannot silently receive a second food deduction; exact earlier €3 self coverage remains creditable');

const datedFoodWorker=await worker();await payment(datedFoodWorker,100);
const previousDayFood=await expense(datedFoodWorker,12,{createdAt:'2026-11-20T12:00:00Z'});
const currentDayFood=await expense(datedFoodWorker,12);
const datedFoodClaim=id=>claim(id,{category:'FOOD',includesOwnMeal:true,spentOn:'2026-11-21'});
await assert.rejects(preview(datedFoodWorker,{mealChoice:'self',expenses:[datedFoodClaim(previousDayFood)]}),/WHW_MEAL_EXPENSE_OVERLAP/);
const currentDayQuote=await preview(datedFoodWorker,{mealChoice:'self',expenses:[datedFoodClaim(currentDayFood)]});
assert.equal(currentDayQuote.totals.mealDeduction,3);assert.equal(currentDayQuote.expenses[0].mealAlreadyDeducted,3);
assert.equal(currentDayQuote.totals.claimedCollectionExpenses,9);assert.equal(currentDayQuote.totals.projectedCash,88);
pass('changing claimed spentOn cannot give an older food expense today’s meal credit; the same current-day expense retains its exact €3 credit');

const policyWorker=await worker();policyWorker.name='Tapin Lepaja';
await db.query('update users set name=$2 where id=$1',[policyWorker.id,policyWorker.name]);
await payment(policyWorker,20);
const policyExpense=await expense(policyWorker,12);
await db.query("update arka_pending_payments set note='Buk' where id=$1",[policyExpense]);
await assert.rejects(preview(policyWorker,{mealChoice:'none',expenses:[claim(policyExpense,{category:'OTHER',description:'Fuel'})]}),/WHW_FOOD_POLICY_REVIEW_REQUIRED/);
await db.query("update arka_pending_payments set note='Fuel station' where id=$1",[policyExpense]);
const allowedFuel=await preview(policyWorker,{mealChoice:'none',expenses:[claim(policyExpense,{category:'FUEL',description:'Fuel station'})]});
assert.equal(allowedFuel.totals.claimedCollectionExpenses,12);assert.equal(allowedFuel.totals.projectedCash,8);
pass('food policy checks canonical existing expense text despite browser category/description changes, while legitimate fuel remains allowed');

const legacyExpenseActor={id:oldActorId,pin:'7999',name:'Historical fixture',role:'PUNTOR'};
await payment(legacyExpenseActor,100);
const acceptedHistory=await expense(legacyExpenseActor,12,{createdAt:'2026-04-10T12:00:00Z'});
const acceptedUnposted=await expense(legacyExpenseActor,12);
await db.query("update arka_pending_payments set status='ACCEPTED_BY_DISPATCH' where id=any($1::bigint[])",[[acceptedHistory,acceptedUnposted]]);
const settledMarker=await expense(legacyExpenseActor,12);
await db.query("update arka_pending_payments set handoff_note='Legacy note | SETTLED_IN_HANDOFF:777 | already accounted' where id=$1",[settledMarker]);
const handedExpense=await expense(legacyExpenseActor,12);
await db.query('update arka_pending_payments set handed_at=now() where id=$1',[handedExpense]);
const handoffReference=await expense(legacyExpenseActor,12);
await db.query("update arka_pending_payments set handoff_note='Expense settled in HANDOFF #777' where id=$1",[handoffReference]);
const activeItem=await expense(legacyExpenseActor,12);
await db.query('insert into cash_handoff_items(handoff_id,pending_payment_id,amount)values($1,$2,12)',[oldHandoff.id,activeItem]);
const activeDecision=await expense(legacyExpenseActor,12);
await db.query("insert into cash_handoff_expense_decisions(expense_payment_id,decision_status)values($1,'ACTIVE')",[activeDecision]);
const excludedExpense=await expense(legacyExpenseActor,12);
await db.query('insert into arka_payment_exclusions(payment_id,cancelled_at)values($1,null)',[excludedExpense]);
const appliedExpense=await expense(legacyExpenseActor,12);
const oldCycle=await one("insert into arka_cycles(cycle_date,is_closed)values('2026-04-10',true)returning id value");
await db.query('update arka_pending_payments set applied_cycle_id=$2 where id=$1',[appliedExpense,oldCycle]);
const cancelledProof=await expense(legacyExpenseActor,12,{approved:true,manager});
await db.query("update arka_expense_decisions set decision_status='CANCELLED' where expense_payment_id=$1",[cancelledProof]);
const finalizedPending=await expense(legacyExpenseActor,12,{approved:true,manager});
await db.query("update arka_pending_payments set status='PENDING' where id=$1",[finalizedPending]);
const genuinePending=await expense(legacyExpenseActor,12);
const confirmedBuk=await expense(legacyExpenseActor,12,{approved:true,manager,note:'Buk'});
const blockedLegacy=[acceptedHistory,acceptedUnposted,settledMarker,handedExpense,handoffReference,activeItem,activeDecision,excludedExpense,appliedExpense,cancelledProof,finalizedPending];
const beforeEligibility=await financialState();
const eligibleExpenses=await preview(legacyExpenseActor);
const eligibleIds=eligibleExpenses.existingExpenses.map(row=>Number(row.paymentId));
for(const id of blockedLegacy) {
  assert.ok(!eligibleIds.includes(id),`Historical or already accounted expense ${id} must not appear as a fresh request`);
  await assert.rejects(preview(legacyExpenseActor,{mealChoice:'none',expenses:[claim(id)]}),/WHW_EXPENSE_(CHANGED|ALREADY_CLAIMED|NOT_ELIGIBLE)/);
}
assert.ok(eligibleIds.includes(genuinePending));assert.ok(eligibleIds.includes(confirmedBuk));
assert.equal(eligibleExpenses.existingExpenses.find(row=>Number(row.paymentId)===confirmedBuk).ledgerPosted,true);
for(const id of [genuinePending,confirmedBuk]) {
  const validExisting=await preview(legacyExpenseActor,{mealChoice:'none',expenses:[claim(id)]});
  assert.equal(validExisting.totals.claimedCollectionExpenses,12);assert.equal(validExisting.totals.projectedCash,88);
}
assert.deepEqual(await financialState(),beforeEligibility);
pass('historical accepted/unposted, settled, linked, excluded, applied and stale-decision expenses are hidden and reject explicit IDs; genuine pending and verified posted Buk remain usable');

const december=await worker();await payment(december,100);await bonus(december,10);
await db.query("insert into meal_policy_members(policy_key,worker_id)values('meal_monthly_2026_12',$1)",[december.id]);
await clock('2026-11-30T12:00:00Z');
await one("insert into arka_pending_payments(amount,type,status,created_by_pin,created_by_name,note,handoff_note,created_at,updated_at,idempotency_key)values(3,'MEAL_PAYMENT','PENDING',$1,$2,'Fixture earlier meal','MEAL_DAY:2026-11-30','2026-11-30T12:00:00Z',now(),$3)returning id value",[december.pin,december.name,randomUUID()]);
const novemberPendingFood=await expense(december,12,{note:'Buk'});
const novemberPostedFood=await expense(december,12,{note:'Buk',approved:true,manager});
await clock('2026-11-30T23:00:00Z');
const decemberOptions={mealChoice:'monthly',expenses:[]};
const decemberQuote=await preview(december,decemberOptions);
assert.equal(decemberQuote.businessDate,'2026-12-01');assert.equal(decemberQuote.mealPolicy.dailyAllowed,false);
assert.equal(decemberQuote.totals.mealDeduction,3);assert.equal(decemberQuote.totals.expectedCash,87);
await assert.rejects(preview(december,{mealChoice:'self',expenses:[]}),/MEAL|MONTHLY|POLICY|DAILY/);
const beforeFoodBypass=await financialState();
for(const fundingSource of ['WORKER_COLLECTIONS','DISPATCH_DRAWER','OWN_MONEY']) {
  for(const [category,description] of [['FOOD','Team lunch'],['OTHER','Buk']]) {
    for(const spentOn of ['2026-12-01','2026-11-30']) {
      await assert.rejects(preview(december,{mealChoice:'monthly',expenses:[claim(null,{category,description,fundingSource,spentOn})]}),/WHW_DAILY_FOOD_CLOSED/);
    }
  }
}
for(const id of [novemberPendingFood,novemberPostedFood]) {
  assert.ok(decemberQuote.existingExpenses.some(row=>Number(row.paymentId)===id));
  const oldFoodQuote=await preview(december,{mealChoice:'monthly',expenses:[claim(id,{category:'FOOD',description:'November team food',spentOn:'2026-11-30'})]});
  assert.equal(oldFoodQuote.totals.claimedCollectionExpenses,12);assert.equal(oldFoodQuote.totals.projectedCash,75);
}
const oldActorDecember=await preview(legacyExpenseActor,{mealChoice:'monthly',expenses:[]});
assert.ok(!oldActorDecember.existingExpenses.some(row=>Number(row.paymentId)===postCutoffLegacyFood));
await assert.rejects(preview(legacyExpenseActor,{mealChoice:'monthly',expenses:[claim(postCutoffLegacyFood,{category:'OTHER',description:'Fuel',spentOn:'2026-11-30'})]}),/WHW_DAILY_FOOD_CLOSED/);
assert.deepEqual(await financialState(),beforeFoodBypass);
pass('December food cutoff blocks FOOD and disguised Buk in every funding source, including new backdated claims and crafted legacy IDs; real November pending/posted food remains verifiable');
const mealRowsBefore=await one("select count(*)::int value from arka_pending_payments where type='MEAL_PAYMENT' and created_by_pin=$1",[december.pin]);
await submit(december,decemberQuote,{options:decemberOptions});
assert.equal(await one("select count(*)::int value from arka_pending_payments where type='MEAL_PAYMENT' and created_by_pin=$1",[december.pin]),mealRowsBefore);
await clock('2026-11-21T12:00:00Z');
pass('December boundary disables fresh daily food while settling an earlier November meal once');

const unrelated=await worker();const unrelatedCash=await payment(unrelated,17);const unrelatedExpense=await expense(unrelated,4);
await db.exec('grant select,update on arka_pending_payments to anon; grant select(pin,name,is_active) on users to anon;');
await db.exec('set role anon');
await db.query('update arka_pending_payments set handed_by_pin=$2,handed_by_name=$3,updated_at=now() where id=$1',[unrelatedCash,unrelated.pin,unrelated.name]);
await db.query("update arka_pending_payments set note='Unclaimed fixture correction' where id=$1",[unrelatedExpense]);
await assert.rejects(preview(first),/permission denied/);
await assert.rejects(db.query('select * from worker_handoff_submissions'),/permission denied/);
await db.exec('reset role');
assert.equal(await one('select handed_by_pin value from arka_pending_payments where id=$1',[unrelatedCash]),unrelated.pin);
assert.equal(await one('select note value from arka_pending_payments where id=$1',[unrelatedExpense]),'Unclaimed fixture correction');
pass('raw wizard RPCs and snapshots remain private while unrelated legacy payment claims and unclaimed expense edits remain usable');

// Exercise the real HTTP handler and approved-device authentication with the
// same SQL functions; no mocked financial implementation crosses this boundary.
const {createWorkerHandoffHandler}=await import('../api/worker-handoff.js');
const apiWorker=await worker();await payment(apiWorker,30);
for(const [device,actor,approved] of [['manager',manager,true],['worker',apiWorker,true],['unapproved',apiWorker,false]]) await db.query('insert into tepiha_user_devices values($1,$2,$3)',['fixture-'+device,actor.id,approved]);
function identityQuery(table) {
  assert.ok(['users','tepiha_user_devices'].includes(table));let fields='*';const filters=[];
  const q={select(value){assert.match(value,/^[a-z_,*]+$/);fields=value;return q;},eq(field,value){assert.match(field,/^[a-z_]+$/);filters.push([field,value]);return q;},maybeSingle(){return q;},then(resolve,reject){return db.query('select '+fields+' from '+table+' where '+filters.map(([field],i)=>field+'=$'+(i+1)).join(' and '),filters.map(([,value])=>value)).then(result=>resolve({data:result.rows[0]||null,error:null}),reject);}};return q;
}
const rpcFields={preview_worker_handoff_v1:['p_actor_id','p_options'],submit_worker_handoff_v1:['p_actor_id','p_snapshot_hash','p_request_key','p_options','p_physical_cash','p_difference_reason'],read_worker_handoff_submission_v1:['p_actor_id','p_handoff_id'],decide_worker_handoff_expense_v1:['p_actor_id','p_claim_id','p_approve','p_note','p_request_key'],reimburse_worker_handoff_expense_v1:['p_actor_id','p_claim_id','p_amount','p_note','p_request_key']};
const connection={from:identityQuery,async rpc(name,args){const fields=rpcFields[name];assert.ok(fields);assert.deepEqual(Object.keys(args).sort(),[...fields].sort());try{return {data:await one('select '+name+'('+fields.map((_,i)=>'$'+(i+1)).join(',')+') value',fields.map(field=>['p_options'].includes(field)?JSON.stringify(args[field]):args[field])),error:null};}catch(error){return {data:null,error:{message:error.message}};}}};
const handler=createWorkerHandoffHandler({createClient:()=>connection});
async function api(body={},overrides={}) {
  let output;const res={statusCode:200,headers:{},setHeader(key,value){this.headers[key]=value;},end(value){output=value;}};
  const req={method:overrides.method||'POST',headers:{host:'fixture.test',origin:'https://fixture.test','content-type':'application/json',cookie:'tepiha_device_id=fixture-worker',...overrides.headers},body:{expectedActorId:apiWorker.id,...body}};
  await handler(req,res);return {status:res.statusCode,data:JSON.parse(output),headers:res.headers};
}
await db.exec('set role service_role');
for(const [overrides,status] of [[{headers:{cookie:''}},401],[{headers:{cookie:'tepiha_device_id=fixture-unapproved'}},403],[{headers:{origin:'https://elsewhere.test'}},403],[{headers:{'content-type':'text/plain'}},415],[{method:'GET'},405]]) assert.equal((await api({action:'preview',options:emptyOptions()},overrides)).status,status);
assert.equal((await api({action:'preview',options:emptyOptions(),expectedActorId:manager.id})).status,403);
assert.equal((await api({action:'preview',options:emptyOptions(),actorId:manager.id})).status,400);
const httpQuote=await api({action:'preview',options:emptyOptions()});assert.equal(httpQuote.status,200,JSON.stringify(httpQuote.data));assert.match(httpQuote.headers['cache-control'],/no-store/);
const httpPayload={action:'submit',snapshotHash:httpQuote.data.snapshotHash,requestKey:randomUUID(),options:emptyOptions(),physicalCash:30,differenceReason:''};
const httpBefore=await financialState();const httpSubmit=await api(httpPayload);assert.equal(httpSubmit.status,200,JSON.stringify(httpSubmit.data));assert.deepEqual(await financialState(),httpBefore);
assert.equal((await api(httpPayload)).data.replayed,true);
assert.equal((await api({...httpPayload,physicalCash:29,differenceReason:'Changed retry'})).status,409);
assert.equal((await api({action:'read',handoffId:firstSubmit.handoffId})).status,403);
assert.equal((await api({action:'decide-expense',claimId:expenseClaim.id,approve:true,note:'Worker must not approve',requestKey:randomUUID()})).status,403);
const payBody={action:'reimburse-expense',claimId:managerPersonalSubmit.claims[0].id,amount:12,note:'Manager counted and paid exact reimbursement',requestKey:randomUUID(),confirmPaid:true};
assert.equal((await api(payBody)).status,403);
const managerHttp={headers:{cookie:'tepiha_device_id=fixture-manager'}};
assert.equal((await api({...payBody,expectedActorId:manager.id,confirmPaid:false},managerHttp)).status,400);
const apiBeforeReimbursement=await financialState();
const paidViaApi=await api({...payBody,expectedActorId:manager.id},managerHttp);
assert.equal(paidViaApi.status,200,JSON.stringify(paidViaApi.data));
assert.equal(await balance(),apiBeforeReimbursement.balance-12);assert.equal(await ledgerCount(),apiBeforeReimbursement.ledgerCount+1);assert.equal(await receiptCount(),apiBeforeReimbursement.receiptCount);
assert.equal((await api({...payBody,expectedActorId:manager.id},managerHttp)).data.replayed,true);
assert.equal(await balance(),apiBeforeReimbursement.balance-12);
await db.exec('reset role');
assert.deepEqual(await one('select to_jsonb(h) value from cash_handoffs h where id=$1',[oldHandoff.id]),oldHandoff);
pass('approved-device API verifies actor, origin, exact body, role and scope; server submission/retry does not create company cash');
await db.close();
console.log('PASS all worker handover wizard financial/API checks');
