const prefix = 'tepiha_daily_expense_intent_v1:';
function key(actorId) {
  if (!actorId) throw new Error('Hyr përsëri për të regjistruar shpenzimin.');
  return prefix + String(actorId);
}
export function readDailyExpenseIntent(actorId) {
  const raw = localStorage.getItem(key(actorId));
  if (!raw) return null;
  const intent = JSON.parse(raw);
  if (!intent?.p_idempotency_key || !(Number(intent.p_amount) > 0) || !intent.p_actor_pin || !intent.p_note) {
    throw new Error('Shpenzimi në pritje nuk lexohet. Kërko kontroll nga administratori.');
  }
  return intent;
}
export function prepareDailyExpenseIntent(actorId, payload) {
  const existing = readDailyExpenseIntent(actorId);
  if (existing) return existing;
  const intent = { ...payload, p_idempotency_key: `ARKA_DAILY_EXPENSE_V2:${crypto.randomUUID()}` };
  // Persist before the first request; a reload or lost response reuses this key.
  localStorage.setItem(key(actorId), JSON.stringify(intent));
  return intent;
}
export function acknowledgeDailyExpenseIntent(actorId, idempotencyKey) {
  const existing = readDailyExpenseIntent(actorId);
  if (existing?.p_idempotency_key === idempotencyKey) localStorage.removeItem(key(actorId));
}
