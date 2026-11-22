export const handoffActorKey = actor => `${actor?.id || actor?.user_id || ''}:${String(actor?.pin || '').trim()}:${String(actor?.role || '').trim().toUpperCase()}`;

const fail = (message, code = 'HANDOFF_PREVIEW_INCOMPLETE') => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function cents(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0) fail('Shumat e dorëzimit nuk u ngarkuan plotësisht. Provo përsëri.');
  return Math.round((Number(value) + Number.EPSILON) * 100);
}

// Read-only orchestration. Use the same bonus and outstanding-meal readers as
// submission, so a disabled Base profile flag cannot hide Transport credit.
export async function loadWorkerHandoffPreview({ actor, date, getCurrentActor, online = true, readFinance, readBonuses, readMeals, readMealCoverage }) {
  const actorKey = handoffActorKey(actor);
  const pin = String(actor?.pin || '').trim();
  const assertSession = () => {
    const currentActor = getCurrentActor?.();
    if (!pin || actor?.is_active === false || currentActor?.is_active === false || actorKey !== handoffActorKey(currentActor)) fail('Llogaria ka ndryshuar. Hape përsëri arkën.', 'HANDOFF_SESSION_CHANGED');
  };
  assertSession();
  if (!online) fail('Lidhu me internet që të kontrollohen bonusat dhe shuma për Dispatch.', 'HANDOFF_PREVIEW_OFFLINE');
  const [finance, bonuses, meals, mealCoverage] = await Promise.all([
    readFinance({ pin, date }),
    readBonuses(pin, { allowNonWorker: true, requireOnline: true }),
    readMeals(pin, { limit: 100 }),
    readMealCoverage(pin),
  ]);
  assertSession();
  if (String(finance?.worker?.pin || '').trim() !== pin || !finance?.profile || !Array.isArray(finance?.cash?.rows)
    || !Array.isArray(bonuses) || !Array.isArray(meals) || !Array.isArray(mealCoverage)) {
    fail('Llogaria e dorëzimit nuk u ngarkua plotësisht. Provo përsëri.');
  }
  const profile = finance.profile;
  const gross = cents(finance.cash.open_gross);
  const base = cents(finance.cash.open_due_to_base);
  const commission = cents(finance.cash.open_commission);
  const bonus = bonuses.reduce((sum, row) => sum + cents(row.remaining_amount), 0);
  const meal = meals.reduce((sum, row) => sum + cents(row.amount), 0);
  if (base <= 0 || finance.cash.rows.length === 0) fail('Nuk ke klientë me cash të hapur për dorëzim.', 'HANDOFF_CASH_EMPTY');
  const straightSalaryOnly = profile.salary_enabled === true
    && profile.meal_enabled === false && profile.commission_enabled === false
    && profile.transport_bonus_enabled === false && profile.ready_bonus_enabled === false
    && String(profile.cash_mode || '').toUpperCase() === 'FULL_CASH'
    && bonus === 0 && meal === 0;
  return {
    actorKey, finance, straightSalaryOnly,
    grossTotal: gross / 100, baseTotal: base / 100, commissionTotal: commission / 100,
    clientCount: finance.cash.rows.length,
    hybridEnabled: profile.commission_enabled === true && String(profile.cash_mode || '').toUpperCase() === 'HYBRID_COMMISSION',
    bonusAvailable: bonus / 100, unsettledMealDeduct: meal / 100,
    existingMealCovered: mealCoverage.length > 0,
  };
}
