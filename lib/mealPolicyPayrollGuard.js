const cents = value => Math.round(Number(value) * 100);

// Runs before any budget movement. A stale client must refresh its visible quote;
// the server never silently changes the amount the operator approved.
export async function validateMealPolicySalaryBasis(supabase, { workerPin, workerId, monthKey, baseSalary, amount, advanceAmount } = {}) {
  const { data, error } = await supabase.rpc('get_meal_policy_salary_basis_v1', { p_worker_pin:workerPin, p_month_key:monthKey });
  if (error || typeof data?.scheduled !== 'boolean') throw new Error('MEAL_POLICY_PAYROLL_CHECK_FAILED');
  if (!data.scheduled) return data;
  const gross = cents(data.grossFixed);
  const advances = cents(advanceAmount);
  if (!data.workerId || (workerId && data.workerId !== workerId) || !Number.isFinite(gross) || !Number.isFinite(advances) || advances < 0 || cents(baseSalary) !== gross || cents(amount) !== Math.max(0,gross-advances)) {
    throw new Error('MEAL_POLICY_PAYROLL_QUOTE_CHANGED');
  }
  return data;
}
