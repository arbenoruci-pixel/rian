// lib/transportArkaStore.js
// Transport ARKA (CASH ONLY) — always open.
// - COLLECTED: pagesat qe i merr transportusi (cash ne dore)
// - EXPENSES: nafte/toll/parking/tjera + pershkrim
// - TRANSFERS: kur i dorzon te dispatch/baza (zbret nga transportusi, hyn ne ARKA e bazes)
// Storage: localStorage per transport_id.

import { addArkaRecordFromOrder } from '@/lib/arkaStore';

function keyFor(transportId) {
  return `arka_transport_wallet_v1_${transportId || 'unknown'}`;
}

function emptyState() {
  return { items: [], expenses: [], transfers: [] };
}

export function readTransportArka(transportId) {
  if (typeof window === 'undefined') return emptyState();
  try {
    const raw = localStorage.getItem(keyFor(transportId));
    if (!raw) return emptyState();
    const v = JSON.parse(raw || '{}');
    return {
      items: Array.isArray(v.items) ? v.items : [],
      expenses: Array.isArray(v.expenses) ? v.expenses : [],
      transfers: Array.isArray(v.transfers) ? v.transfers : [],
    };
  } catch {
    return emptyState();
  }
}

export function writeTransportArka(transportId, state) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(keyFor(transportId), JSON.stringify(state || emptyState()));
  } catch {}
}

// --- COLLECT ---
export function addTransportCollected(transportId, rec) {
  const st = readTransportArka(transportId);
  const next = {
    ...st,
    items: [{ id: `c_${Date.now()}`, ts: Date.now(), ...rec }, ...(st.items || [])],
  };
  writeTransportArka(transportId, next);
  return next;
}
// Back-compat name used elsewhere
export function addTransportCollect(transportId, rec) {
  return addTransportCollected(transportId, rec);
}

// --- EXPENSE ---
export function addTransportExpense(transportId, rec) {
  const st = readTransportArka(transportId);
  const next = {
    ...st,
    expenses: [{ id: `e_${Date.now()}`, ts: Date.now(), ...rec }, ...(st.expenses || [])],
  };
  writeTransportArka(transportId, next);
  return next;
}

// --- TRANSFER TO BASE (DISPATCH) ---
export async function addTransportTransferToBase({ transportId, transporterName = '', amount = 0, note = '' }) {
  const st = readTransportArka(transportId);
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Invalid amount' };

  // log into BASE ARKA as a single record (cash-only)
  const pseudoOrder = {
    id: `transport_transfer_${transportId}_${Date.now()}`,
    code: `TRANSPORT-${transportId}`,
    name: transporterName || `TRANSPORTER ${transportId}`,
    phone: '',
    pay: { euro: n, paid: n },
    status: 'arka_transport_transfer',
    note: note || `Transporter ${transportId} delivered ${n}€`,
  };

  // Best-effort: this should only affect BASE ARKA, not daily cycle auto-apply if you gate it elsewhere.
  await addArkaRecordFromOrder(pseudoOrder, {
    paid: n,
    worker: transporterName || `TRANSPORTER ${transportId}`,
    source: 'TRANSPORT',
    extra: { transportId, amount: n },
  });

  const next = {
    ...st,
    transfers: [{ id: `t_${Date.now()}`, ts: Date.now(), amount: n, note: note || '', by: transporterName || '' }, ...(st.transfers || [])],
  };
  writeTransportArka(transportId, next);
  return { ok: true };
}

// --- HELPERS ---
export function computeTransportBalance(state) {
  const st = state || emptyState();
  const collected = (st.items || []).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const expenses = (st.expenses || []).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const transfers = (st.transfers || []).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const balance = Number((collected - expenses - transfers).toFixed(2));
  return { collected, expenses, transfers, balance };
}

// --- Legacy no-ops / compat ---
export function openTransportDay() {
  // no-op: arka always open
  return null;
}
export function closeTransportDay() {
  // no-op: replaced by transfers
  return null;
}
export async function closeTransportDayAndDeliverToBase({ transportId, transporterName = '' }) {
  // legacy: transfer ALL balance
  const st = readTransportArka(transportId);
  const { balance } = computeTransportBalance(st);
  if (balance <= 0) return { totalCollected: 0, totalExpenses: 0, net: 0 };
  await addTransportTransferToBase({ transportId, transporterName, amount: balance, note: 'AUTO TRANSFER (CLOSE DAY)' });
  const { collected, expenses } = computeTransportBalance(readTransportArka(transportId));
  return { totalCollected: collected, totalExpenses: expenses, net: balance };
}
