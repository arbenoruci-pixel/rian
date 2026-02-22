// FILE: rian-main/lib/codeLease.js
// Compatibility shim.
//
// Rule: ONE source of truth per subsystem.
// - BASE codes live in:   /lib/baseCodes.js
// - TRANSPORT codes live in: /lib/transportCodes.js
//
// Some older pages referenced /lib/codeLease. We keep it as a thin wrapper to avoid
// duplicate logic and "mixed" code systems.

export * from './baseCodes';

// Small shared helpers kept here for convenience (pure functions).

// Accepts formats like: "7", "#007", "X7", "T7", "t007".
// Returns "7" for base codes, and "T<n>" for transport.
export function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

export function codeToNumber(raw) {
  const n = Number(String(raw ?? '').replace(/\D+/g, '') || '0');
  return Number.isFinite(n) ? n : 0;
}

export function computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer) {
  const t = (tepihaRows || []).reduce(
    (sum, r) => sum + (Number(r?.m2) || 0) * (Number(r?.qty) || 0),
    0
  );
  const s = (stazaRows || []).reduce(
    (sum, r) => sum + (Number(r?.m2) || 0) * (Number(r?.qty) || 0),
    0
  );
  const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
  return Number((t + s + sh).toFixed(2));
}
