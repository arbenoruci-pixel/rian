// lib/transportArkaStore.js
// Cash-only Transport ARKA: open day, collect, expenses, close -> deliver net to base.

import { addArkaRecordFromOrder } from '@/lib/arkaStore';

function keyFor(transportId) {
  return `arka_transport_v1_${transportId || 'unknown'}`;
}

export function readTransportArka(transportId) {
  if (typeof window === 'undefined') return { day: null, open_cash: 0, items: [], expenses: [] };
  try {
    const raw = localStorage.getItem(keyFor(transportId));
    if (!raw) return { day: null, open_cash: 0, items: [], expenses: [] };
    const v = JSON.parse(raw);
    return {
      day: v.day || null,
      open_cash: Number(v.open_cash || 0),
      items: Array.isArray(v.items) ? v.items : [],
      expenses: Array.isArray(v.expenses) ? v.expenses : [],
      delivered: Array.isArray(v.delivered) ? v.delivered : [],
    };
  } catch {
    return { day: null, open_cash: 0, items: [], expenses: [], delivered: [] };
  }
}

export function writeTransportArka(transportId, state) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(keyFor(transportId), JSON.stringify(state || {}));
}

export function openTransportDay(transportId, dayStr, openCash = 0) {
  const st = readTransportArka(transportId);
  const next = {
    day: dayStr,
    open_cash: Number(openCash || 0),
    items: [],
    expenses: [],
    delivered: [],
  };
  writeTransportArka(transportId, next);
  return next;
}

export function addTransportCollect(transportId, rec) {
  const st = readTransportArka(transportId);
  const next = {
    ...st,
    items: [{ id: `c_${Date.now()}`, ts: Date.now(), ...rec }, ...(st.items || [])],
  };
  writeTransportArka(transportId, next);
  return next;
}

export function addTransportExpense(transportId, rec) {
  const st = readTransportArka(transportId);
  const next = {
    ...st,
    expenses: [{ id: `e_${Date.now()}`, ts: Date.now(), ...rec }, ...(st.expenses || [])],
  };
  writeTransportArka(transportId, next);
  return next;
}

export async function closeTransportDayAndDeliverToBase({ transportId, transporterName = '' }) {
  const st = readTransportArka(transportId);
  const totalCollected = (st.items || []).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const totalExpenses = (st.expenses || []).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const net = Number((totalCollected - totalExpenses).toFixed(2));

  // log into BASE ARKA as a single record (cash-only)
  const pseudoOrder = {
    id: `transport_${transportId}_${st.day || 'day'}`,
    code: `TRANSPORT-${transportId}`,
    name: transporterName || `TRANSPORTER ${transportId}`,
    phone: '',
    pay: { euro: net, paid: net },
    status: 'arka_transport_delivery',
    note: `Transporter ${transportId} delivered ${net}€, expenses ${totalExpenses}€`,
  };

  await addArkaRecordFromOrder(pseudoOrder, {
    paid: net,
    worker: transporterName || `TRANSPORTER ${transportId}`,
    source: 'TRANSPORT',
    extra: { transportId, day: st.day, totalCollected, totalExpenses, net },
  });

  const next = {
    ...st,
    delivered: [{ id: `d_${Date.now()}`, ts: Date.now(), day: st.day, totalCollected, totalExpenses, net }],
  };
  writeTransportArka(transportId, next);
  return { totalCollected, totalExpenses, net };
}
