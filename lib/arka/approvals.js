// Approval skeleton (localStorage based). Not wired into UI yet.

export const APPROVAL_KEYS = {
  PENDING: 'ARKA_APPROVALS_PENDING',
  HISTORY: 'ARKA_APPROVALS_HISTORY',
};

function safeParse(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}

function getLS(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  return safeParse(raw, fallback);
}

function setLS(key, val) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(val));
}

export function listPendingApprovals() {
  const arr = getLS(APPROVAL_KEYS.PENDING, []);
  return Array.isArray(arr) ? arr : [];
}

export function requestApproval({ type, amountCent, note, requestedBy }) {
  const pending = listPendingApprovals();
  const item = {
    id: `ap_${Date.now()}`,
    ts: Date.now(),
    type: String(type || 'expense'),
    amountCent: Number(amountCent || 0),
    note: String(note || ''),
    requestedBy: requestedBy || null,
    status: 'PENDING',
  };
  pending.push(item);
  setLS(APPROVAL_KEYS.PENDING, pending);
  return item;
}

export function resolveApproval(id, { decision, decidedBy }) {
  const pending = listPendingApprovals();
  const idx = pending.findIndex((x) => x?.id === id);
  if (idx === -1) return null;
  const item = pending[idx];
  pending.splice(idx, 1);
  setLS(APPROVAL_KEYS.PENDING, pending);

  const hist = getLS(APPROVAL_KEYS.HISTORY, []);
  const resolved = {
    ...item,
    status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    decidedBy: decidedBy || null,
    decidedAt: Date.now(),
  };
  hist.push(resolved);
  setLS(APPROVAL_KEYS.HISTORY, hist);
  return resolved;
}
