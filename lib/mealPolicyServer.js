import { ADMIN_ROLES } from './roles.js';
import { cleanStaffPin } from './staffIdentityServer.js';

const MANAGERS = new Set([...ADMIN_ROLES, 'MASTER', 'MASTER_USER', 'MASTERUSER']);
const upper = value => String(value || '').trim().toUpperCase();
export class MealPolicyError extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code=code; this.httpStatus=httpStatus; }
}
const fail = (code, status) => { throw new MealPolicyError(code, status); };

export async function handleMealPolicy(body, { supabase, actor } = {}) {
  if (!actor?.id || actor.is_active !== true) fail('MEAL_POLICY_FORBIDDEN',403);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('MEAL_POLICY_BODY_INVALID',400);
  if (body.expectedActorId != null && body.expectedActorId !== actor.id) fail('MEAL_POLICY_SESSION_CHANGED',403);
  const action = body.action || 'read';
  if (!['read','acknowledge'].includes(action)) fail('MEAL_POLICY_ACTION_INVALID',400);
  if (action === 'acknowledge') {
    if (body.targetPin != null || body.scope != null) fail('MEAL_POLICY_FORBIDDEN',403);
    if (!/^[a-zA-Z0-9_-]{4,80}$/.test(String(body.policyKey || ''))) fail('MEAL_POLICY_KEY_INVALID',400);
    const { data, error } = await supabase.rpc('acknowledge_meal_policy_v1', { p_actor_id:actor.id, p_policy_key:body.policyKey });
    if (error) fail(/NOT_ELIGIBLE|NOT_ACTIVE|ACTOR/.test(error.message || '') ? 'MEAL_POLICY_NOT_AVAILABLE' : 'MEAL_POLICY_WRITE_FAILED', /NOT_ELIGIBLE|NOT_ACTIVE|ACTOR/.test(error.message || '') ? 403 : 503);
    return data;
  }
  const scope = body.scope || 'own';
  if (!['own','team'].includes(scope)) fail('MEAL_POLICY_SCOPE_INVALID',400);
  if (scope === 'team' && !MANAGERS.has(upper(actor.role))) fail('MEAL_POLICY_FORBIDDEN',403);
  let targetId = actor.id;
  if (body.targetPin != null) {
    const pin = String(body.targetPin).trim();
    try { cleanStaffPin(pin); } catch { fail('MEAL_POLICY_WORKER_INVALID',400); }
    if (pin !== String(actor.pin)) {
      if (!MANAGERS.has(upper(actor.role))) fail('MEAL_POLICY_FORBIDDEN',403);
      const { data, error } = await supabase.from('users').select('id,is_active').eq('pin',pin).maybeSingle();
      if (error) fail('MEAL_POLICY_READ_FAILED',503);
      if (!data?.id || data.is_active !== true) fail('MEAL_POLICY_WORKER_NOT_FOUND',404);
      targetId = data.id;
    }
  }
  const { data, error } = await supabase.rpc('get_meal_policy_state_v1', { p_actor_id:actor.id, p_scope:scope, p_target_id:targetId });
  if (error || !data || !Array.isArray(data.settings) || !Array.isArray(data.policies)) fail('MEAL_POLICY_READ_FAILED',503);
  return data;
}
