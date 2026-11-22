// Dated meal allowance. Financial history keeps its original profile values;
// a configured policy replaces that component only for its payroll period.
export const MEAL_POLICY_TIME_ZONE = 'Europe/Belgrade';
const clean = value => String(value ?? '').trim();
const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(clean(value));

export function mealBusinessDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('MEAL_POLICY_DATE_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: MEAL_POLICY_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function effectiveMealSchedule(settings = [], businessDate = '') {
  if (!validDay(businessDate)) return null;
  return (Array.isArray(settings) ? settings : [])
    .filter(row => row?.enabled !== false && validDay(row?.effectiveFrom) && row.effectiveFrom <= businessDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || null;
}

export function mealPolicyForWorker({ workerId, policies = [], settings = [], month } = {}) {
  const id = clean(workerId);
  const period = clean(month);
  if (!id || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return null;
  const schedule = effectiveMealSchedule(settings, `${period}-01`);
  if (!schedule) return null;
  const member = policies.find(row => clean(row?.workerId) === id && row?.policyKey === schedule.policyKey && row?.enabled !== false);
  return member ? { ...schedule, workerId:id } : null;
}

export function resolveMonthlyMealAllowance(worker = {}, month, envelope = {}) {
  const schedule = effectiveMealSchedule(envelope.settings, `${clean(month)}-01`);
  if (schedule) {
    const policy = mealPolicyForWorker({ workerId: worker.id || worker.user_id, month, policies: envelope.policies, settings: envelope.settings });
    return { enabled: Boolean(policy), amount: policy ? money(policy.monthlyAmount) : 0, policy, scheduled: true };
  }
  const enabled = worker.pay_meal_enabled === true;
  return { enabled, amount: enabled ? money(worker.pay_meal_amount ?? worker.bonus_ushqim) : 0, policy:null, scheduled:false };
}

export function activeOwnMealPolicy(envelope = {}) {
  return mealPolicyForWorker({ workerId:envelope.actorId, month:clean(envelope.businessDate).slice(0,7), policies:envelope.policies, settings:envelope.settings });
}

export function dailyMealsAllowed(envelope) {
  if (!envelope || !validDay(envelope.businessDate) || !Array.isArray(envelope.settings)) throw new Error('MEAL_POLICY_NOT_LOADED');
  return !effectiveMealSchedule(envelope.settings, envelope.businessDate);
}

export function mealPolicyNoticeText(policy) {
  if (!policy) return '';
  const date = new Intl.DateTimeFormat('sq-AL', { timeZone:'UTC', day:'numeric', month:'long', year:'numeric' }).format(new Date(`${policy.effectiveFrom}T12:00:00Z`));
  return `Nga ${date}, ushqimi paguhet bashkë me rrogën mujore. Shtesa është ${money(policy.monthlyAmount).toFixed(2)} € në muaj (${money(policy.dailyRate).toFixed(2)} € × ${Number(policy.workDays)} ditë pune) dhe shfaqet veçmas si “Ushqimi”. Nga kjo datë ushqimi ditor nuk merret më nga arka dhe nuk zbritet gjatë dorëzimit. Regjistrimet e mëparshme mbeten në historik; shumat e pashlyera nga periudha e mëparshme mbyllen vetëm një herë sipas regjistrimit.`;
}
