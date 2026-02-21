// lib/arkaV2Store.js
// ARKA v2 — clean, modular store.
// localStorage-first (offline + speed). Can be swapped to Supabase later.

export const ARKA_V2_KEYS = {
  STATE: 'ARKA_V2_STATE',
  TX: 'ARKA_V2_TX',
  WORKERS: 'ARKA_V2_WORKERS',
  DEBTS: 'ARKA_V2_DEBTS',
  INVEST: 'ARKA_V2_INVEST',
  MONTHS: 'ARKA_V2_MONTHS'
};

function safeParse(json, fallback) {
  try {
    if (!json) return fallback;
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function safeStringify(obj) {
  return JSON.stringify(obj, null, 2);
}

export function toCents(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(',', '.').replace(/[^0-9.-]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function centsToEuro(cents) {
  const n = (Number(cents) || 0) / 100;
  return n.toFixed(2);
}

export function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function read(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  return safeParse(window.localStorage.getItem(key), fallback);
}

function write(key, value) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, safeStringify(value));
}

export function getState() {
  return read(ARKA_V2_KEYS.STATE, {
    dayOpen: false,
    openingCashCents: 0,
    openedAt: null,
    openedBy: null,
    owners: [
      { id: 'OWNER_1', name: 'OWNER 1', pct: 50 },
      { id: 'OWNER_2', name: 'OWNER 2', pct: 50 }
    ],
    settings: {
      requireAdminForMonthClose: true
    }
  });
}

export function setState(patch) {
  const next = { ...getState(), ...patch };
  write(ARKA_V2_KEYS.STATE, next);
  return next;
}

export function getWorkers() {
  return read(ARKA_V2_KEYS.WORKERS, [
    { id: 'ADMIN', name: 'ADMIN', role: 'ADMIN', active: true }
  ]);
}

export function setWorkers(list) {
  write(ARKA_V2_KEYS.WORKERS, list);
  return list;
}

export function upsertWorker(worker) {
  const list = getWorkers();
  const idx = list.findIndex(w => w.id === worker.id);
  const next = idx >= 0
    ? list.map(w => (w.id === worker.id ? { ...w, ...worker } : w))
    : [...list, worker];
  setWorkers(next);
  return next;
}

export function getTx() {
  return read(ARKA_V2_KEYS.TX, []);
}

export function setTx(list) {
  write(ARKA_V2_KEYS.TX, list);
  return list;
}

export function addTx(tx) {
  const list = getTx();
  const next = [...list, tx];
  setTx(next);
  return next;
}

export function getDebts() {
  return read(ARKA_V2_KEYS.DEBTS, []);
}

export function setDebts(list) {
  write(ARKA_V2_KEYS.DEBTS, list);
  return list;
}

export function addDebt(debt) {
  const list = getDebts();
  const next = [...list, debt];
  setDebts(next);
  return next;
}

export function updateDebt(id, patch) {
  const list = getDebts();
  const next = list.map(d => (d.id === id ? { ...d, ...patch, updatedAt: new Date().toISOString() } : d));
  setDebts(next);
  return next;
}

export function getInvestments() {
  return read(ARKA_V2_KEYS.INVEST, []);
}

export function setInvestments(list) {
  write(ARKA_V2_KEYS.INVEST, list);
  return list;
}

export function addInvestment(inv) {
  const list = getInvestments();
  const next = [...list, inv];
  setInvestments(next);
  return next;
}

export function getMonthRecords() {
  return read(ARKA_V2_KEYS.MONTHS, []);
}

export function setMonthRecords(list) {
  write(ARKA_V2_KEYS.MONTHS, list);
  return list;
}

export function computeTotalsForMonth(month = monthKey()) {
  const tx = getTx().filter(t => (t.month || monthKey(new Date(t.at))) === month);
  const opening = getState().openingCashCents || 0;
  const income = tx.filter(t => t.type === 'IN').reduce((a, t) => a + (t.amountCents || 0), 0);
  const expenses = tx.filter(t => t.type === 'OUT').reduce((a, t) => a + (t.amountCents || 0), 0);
  return {
    month,
    openingCashCents: opening,
    incomeCents: income,
    expenseCents: expenses,
    netCents: opening + income - expenses
  };
}

export function saveMonthClose(record) {
  const list = getMonthRecords();
  const next = [...list.filter(r => r.month !== record.month), record];
  setMonthRecords(next);
  return next;
}

export function resetArkaV2(scope = 'ALL') {
  if (typeof window === 'undefined') return;
  const ls = window.localStorage;
  if (scope === 'ALL') {
    Object.values(ARKA_V2_KEYS).forEach(k => ls.removeItem(k));
    return;
  }
  if (scope === 'TX') ls.removeItem(ARKA_V2_KEYS.TX);
  if (scope === 'DEBTS') ls.removeItem(ARKA_V2_KEYS.DEBTS);
  if (scope === 'INVEST') ls.removeItem(ARKA_V2_KEYS.INVEST);
  if (scope === 'MONTHS') ls.removeItem(ARKA_V2_KEYS.MONTHS);
}
