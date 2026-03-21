import { supabase } from '@/lib/supabaseClient';

const SUMMARY_ID = 1;

const n = (v) => Number(v || 0) || 0;

async function getSummary() {
  const { data, error } = await supabase
    .from('company_budget_summary')
    .select('*')
    .eq('id', SUMMARY_ID)
    .single();
  if (error) throw error;
  return data;
}

export async function listWorkerReadyCash(actorPin) {
  const pin = String(actorPin || '').trim();
  if (!pin) return [];
  const { data, error } = await supabase
    .from('arka_pending_payments')
    .select('*')
    .eq('created_by_pin', pin)
    .in('status', ['PENDING', 'COLLECTED', 'ACCEPTED_BY_DISPATCH'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).filter((x) => ['PENDING', 'COLLECTED'].includes(String(x?.status || '').toUpperCase()));
}

export async function submitWorkerCashToDispatch({ actor, note = '' }) {
  const pin = String(actor?.pin || '').trim();
  if (!pin) throw new Error('MUNGON PIN-I I PUNËTORIT.');
  const items = await listWorkerReadyCash(pin);
  if (!items.length) throw new Error('NUK KA LEKË PËR DORËZIM.');

  const amount = items.reduce((s, x) => s + n(x.amount), 0);
  const { data: handoff, error: handoffErr } = await supabase
    .from('cash_handoffs')
    .insert({
      worker_pin: pin,
      worker_name: actor?.name || null,
      amount,
      status: 'PENDING_DISPATCH_APPROVAL',
      note: note || null,
    })
    .select('*')
    .single();
  if (handoffErr) throw handoffErr;

  const payload = items.map((x) => ({
    handoff_id: handoff.id,
    pending_payment_id: x.id,
    order_id: x.order_id || null,
    order_code: x.order_code || null,
    amount: n(x.amount),
  }));

  const { error: itemsErr } = await supabase.from('cash_handoff_items').insert(payload);
  if (itemsErr) throw itemsErr;

  const ids = items.map((x) => x.id);
  const { error: updErr } = await supabase
    .from('arka_pending_payments')
    .update({
      status: 'PENDING_DISPATCH_APPROVAL',
      handoff_note: `Handoff #${handoff.id}`,
    })
    .in('id', ids);
  if (updErr) throw updErr;

  return handoff;
}

export async function listPendingDispatchHandoffs() {
  const { data, error } = await supabase
    .from('cash_handoffs')
    .select('*, cash_handoff_items(id,order_code,amount,pending_payment_id)')
    .eq('status', 'PENDING_DISPATCH_APPROVAL')
    .order('submitted_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function acceptDispatchHandoff({ handoffId, actor }) {
  const { data: handoff, error: handoffErr } = await supabase
    .from('cash_handoffs')
    .select('*, cash_handoff_items(id,pending_payment_id,amount)')
    .eq('id', handoffId)
    .single();
  if (handoffErr) throw handoffErr;
  if (!handoff) throw new Error('DORËZIMI NUK U GJET.');
  if (handoff.status !== 'PENDING_DISPATCH_APPROVAL') throw new Error('KY DORËZIM NUK ËSHTË NË PRITJE.');

  const { data: ledger, error: ledgerErr } = await supabase
    .from('company_budget_ledger')
    .insert({
      direction: 'IN',
      amount: n(handoff.amount),
      category: 'WORKER_TO_DISPATCH',
      description: `PRANIM NGA DISPATCH — ${handoff.worker_name || handoff.worker_pin}`,
      source_type: 'cash_handoff',
      source_id: handoff.id,
      related_handoff_id: handoff.id,
      created_by_pin: actor?.pin || null,
      created_by_name: actor?.name || null,
      approved_by_pin: actor?.pin || null,
      approved_by_name: actor?.name || null,
    })
    .select('*')
    .single();
  if (ledgerErr) throw ledgerErr;

  const summary = await getSummary();
  const { error: sumErr } = await supabase
    .from('company_budget_summary')
    .update({
      current_balance: n(summary.current_balance) + n(handoff.amount),
      total_in: n(summary.total_in) + n(handoff.amount),
    })
    .eq('id', SUMMARY_ID);
  if (sumErr) throw sumErr;

  const { error: handoffUpdateErr } = await supabase
    .from('cash_handoffs')
    .update({
      status: 'ACCEPTED',
      decided_at: new Date().toISOString(),
      dispatch_pin: actor?.pin || null,
      dispatch_name: actor?.name || null,
      dispatch_note: 'PRANUAR NGA DISPATCH',
      company_ledger_entry_id: ledger.id,
    })
    .eq('id', handoff.id);
  if (handoffUpdateErr) throw handoffUpdateErr;

  const payIds = (handoff.cash_handoff_items || []).map((x) => x.pending_payment_id).filter(Boolean);
  if (payIds.length) {
    const { error: payErr } = await supabase
      .from('arka_pending_payments')
      .update({
        status: 'ACCEPTED_BY_DISPATCH',
        handed_at: new Date().toISOString(),
        handed_by_pin: actor?.pin || null,
        handed_by_name: actor?.name || null,
        handed_by_role: 'DISPATCH',
        handoff_note: `PRANUAR NGA DISPATCH / HANDOFF #${handoff.id}`,
      })
      .in('id', payIds);
    if (payErr) throw payErr;
  }

  return { ok: true, ledger };
}

export async function rejectDispatchHandoff({ handoffId, actor, note = '' }) {
  const { data: handoff, error } = await supabase
    .from('cash_handoffs')
    .select('*, cash_handoff_items(id,pending_payment_id)')
    .eq('id', handoffId)
    .single();
  if (error) throw error;
  if (!handoff) throw new Error('DORËZIMI NUK U GJET.');

  const { error: upErr } = await supabase
    .from('cash_handoffs')
    .update({
      status: 'REJECTED',
      decided_at: new Date().toISOString(),
      dispatch_pin: actor?.pin || null,
      dispatch_name: actor?.name || null,
      dispatch_note: note || 'REFUZUAR NGA DISPATCH',
    })
    .eq('id', handoff.id);
  if (upErr) throw upErr;

  const payIds = (handoff.cash_handoff_items || []).map((x) => x.pending_payment_id).filter(Boolean);
  if (payIds.length) {
    const { error: payErr } = await supabase
      .from('arka_pending_payments')
      .update({ status: 'COLLECTED', handoff_note: note || 'KTHYER NGA DISPATCH' })
      .in('id', payIds);
    if (payErr) throw payErr;
  }

  return { ok: true };
}

export async function listWorkerDebtRows(actorPin, limit = 200) {
  const pin = String(actorPin || '').trim();
  if (!pin) return [];

  const { data, error } = await supabase
    .from('arka_pending_payments')
    .select('*')
    .eq('created_by_pin', pin)
    .in('status', ['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function listCompanyLedger(limit = 100) {
  const { data, error } = await supabase
    .from('company_budget_ledger')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function spendFromCompanyBudget({ actor, amount, category, description }) {
  const amt = n(amount);
  if (!(amt > 0)) throw new Error('SHUMA DUHET TË JETË > 0');
  if (!String(description || '').trim()) throw new Error('PËRSHKRIMI ËSHTË I DETYRUESHËM.');
  const summary = await getSummary();
  if (n(summary.current_balance) < amt) throw new Error('BUXHETI NUK KA MJETE TË MJAFTUESHME.');

  const { error: ledgerErr } = await supabase
    .from('company_budget_ledger')
    .insert({
      direction: 'OUT',
      amount: amt,
      category: category || 'EXPENSE',
      description,
      created_by_pin: actor?.pin || null,
      created_by_name: actor?.name || null,
      approved_by_pin: actor?.pin || null,
      approved_by_name: actor?.name || null,
    });
  if (ledgerErr) throw ledgerErr;

  const { error: sumErr } = await supabase
    .from('company_budget_summary')
    .update({
      current_balance: n(summary.current_balance) - amt,
      total_out: n(summary.total_out) + amt,
    })
    .eq('id', SUMMARY_ID);
  if (sumErr) throw sumErr;

  return { ok: true };
}

export async function listOwners() {
  const { data, error } = await supabase
    .from('owner_finance_summary')
    .select('*')
    .order('owner_name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addOwnerInvestment({ actor, ownerId, amount, description, investmentType = 'ADDITIONAL' }) {
  const amt = n(amount);
  if (!(amt > 0)) throw new Error('SHUMA DUHET TË JETË > 0');
  if (!String(description || '').trim()) throw new Error('PËRSHKRIMI ËSHTË I DETYRUESHËM.');
  const { error } = await supabase.from('owner_investments').insert({
    owner_id: ownerId,
    investment_type: investmentType,
    amount: amt,
    description,
    created_by_pin: actor?.pin || null,
    created_by_name: actor?.name || null,
  });
  if (error) throw error;
  return { ok: true };
}

export async function repayOwnerInvestment({ actor, ownerId, amount, description }) {
  const amt = n(amount);
  if (!(amt > 0)) throw new Error('SHUMA DUHET TË JETË > 0');
  if (!String(description || '').trim()) throw new Error('PËRSHKRIMI ËSHTË I DETYRUESHËM.');
  const summary = await getSummary();
  if (n(summary.current_balance) < amt) throw new Error('BUXHETI NUK KA MJETE TË MJAFTUESHME.');

  const { data: ledger, error: ledgerErr } = await supabase
    .from('company_budget_ledger')
    .insert({
      direction: 'OUT',
      amount: amt,
      category: 'OWNER_INVESTMENT_REPAYMENT',
      description,
      created_by_pin: actor?.pin || null,
      created_by_name: actor?.name || null,
      approved_by_pin: actor?.pin || null,
      approved_by_name: actor?.name || null,
    })
    .select('*')
    .single();
  if (ledgerErr) throw ledgerErr;

  const { error: repErr } = await supabase.from('owner_investment_repayments').insert({
    owner_id: ownerId,
    amount: amt,
    description,
    company_ledger_entry_id: ledger.id,
    created_by_pin: actor?.pin || null,
    created_by_name: actor?.name || null,
  });
  if (repErr) throw repErr;

  const { error: sumErr } = await supabase
    .from('company_budget_summary')
    .update({
      current_balance: n(summary.current_balance) - amt,
      total_out: n(summary.total_out) + amt,
    })
    .eq('id', SUMMARY_ID);
  if (sumErr) throw sumErr;

  return { ok: true };
}

export async function splitProfitToOwners({ actor, totalProfit, description }) {
  const amt = n(totalProfit);
  if (!(amt > 0)) throw new Error('SHUMA DUHET TË JETË > 0');
  if (!String(description || '').trim()) throw new Error('PËRSHKRIMI ËSHTË I DETYRUESHËM.');
  const summary = await getSummary();
  if (n(summary.current_balance) < amt) throw new Error('BUXHETI NUK KA MJETE TË MJAFTUESHME.');

  const { data: owners, error: ownersErr } = await supabase.from('owners').select('*').eq('is_active', true);
  if (ownersErr) throw ownersErr;
  const active = owners || [];
  if (!active.length) throw new Error('NUK KA PRONARË AKTIVË.');
  const pct = active.reduce((s, x) => s + n(x.share_percent), 0);
  if (Math.abs(pct - 100) > 0.01) throw new Error('PËRQINDJET E PRONARËVE DUHET TË BËJNË 100%.');

  for (const owner of active) {
    const ownerAmount = (amt * n(owner.share_percent)) / 100;
    const { data: ledger, error: ledgerErr } = await supabase
      .from('company_budget_ledger')
      .insert({
        direction: 'OUT',
        amount: ownerAmount,
        category: 'OWNER_PROFIT_SPLIT',
        description: `${description} — ${owner.owner_name}`,
        created_by_pin: actor?.pin || null,
        created_by_name: actor?.name || null,
        approved_by_pin: actor?.pin || null,
        approved_by_name: actor?.name || null,
      })
      .select('*')
      .single();
    if (ledgerErr) throw ledgerErr;

    const { error: trErr } = await supabase.from('owner_profit_transfers').insert({
      owner_id: owner.id,
      amount: ownerAmount,
      description: `${description} — ${owner.owner_name}`,
      company_ledger_entry_id: ledger.id,
      created_by_pin: actor?.pin || null,
      created_by_name: actor?.name || null,
    });
    if (trErr) throw trErr;
  }

  const { error: sumErr } = await supabase
    .from('company_budget_summary')
    .update({
      current_balance: n(summary.current_balance) - amt,
      total_out: n(summary.total_out) + amt,
    })
    .eq('id', SUMMARY_ID);
  if (sumErr) throw sumErr;

  return { ok: true };
}
