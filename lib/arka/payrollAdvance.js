const PAYROLL_ADMIN_ROLES = new Set([
  'ADMIN', 'ADMIN_MASTER', 'ADMINMASTER', 'ADMINISTRATOR', 'DISPATCH',
  'MASTER', 'MASTER_USER', 'MASTERUSER', 'OWNER', 'PRONAR',
  'SUPERADMIN', 'SUPER_ADMIN',
]);

function clean(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function normalizePin(value) {
  return clean(value).replace(/\D/g, '');
}

function normalizeRole(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function normalizeMoney(value) {
  const result = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(result)
    ? Math.round((result + Number.EPSILON) * 100) / 100
    : 0;
}

function isSchemaCompatibilityError(error) {
  const code = clean(error?.code).toUpperCase();
  const message = clean(error?.message || error?.details || error?.hint || error).toLowerCase();
  return ['42703', 'PGRST202', 'PGRST204'].includes(code) ||
    message.includes('schema cache') ||
    (message.includes('column') && message.includes('does not exist'));
}

function createActionId(workerPin) {
  try {
    if (globalThis.crypto?.randomUUID) {
      return `payroll-advance:${workerPin}:${globalThis.crypto.randomUUID()}`;
    }
  } catch {}
  return `payroll-advance:${workerPin}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
}

async function verifyPayrollActor(supabase, actor = {}) {
  const actorPin = normalizePin(actor.pin);
  if (!actorPin) throw new Error('ACTOR_PIN_REQUIRED');

  let result = await supabase
    .from('users')
    .select('id,pin,name,role,is_active')
    .eq('pin', actorPin)
    .maybeSingle();

  if (result?.error && isSchemaCompatibilityError(result.error)) {
    result = await supabase
      .from('users')
      .select('id,pin,name,role')
      .eq('pin', actorPin)
      .maybeSingle();
  }

  if (result?.error) throw result.error;
  const row = result?.data;
  if (!row?.pin) throw new Error('ACTOR_NOT_FOUND');
  if (Object.prototype.hasOwnProperty.call(row, 'is_active') && row.is_active === false) {
    throw new Error('ACTOR_DISABLED');
  }

  const actorRole = normalizeRole(row.role || actor.role);
  const compactRole = actorRole.replace(/_/g, '');
  if (!PAYROLL_ADMIN_ROLES.has(actorRole) && !PAYROLL_ADMIN_ROLES.has(compactRole)) {
    throw new Error('ACTOR_ROLE_NOT_ALLOWED');
  }

  return {
    pin: normalizePin(row.pin),
    name: clean(row.name, clean(actor.name, actorPin)),
    role: actorRole,
  };
}

/**
 * Records a payroll advance without any daily arka cycle.
 * No open-day lookup, close-day lookup, cycle_id, or applied_cycle_id is used.
 */
export async function createPayrollAdvanceCycleFree({
  supabase,
  actor,
  worker,
  amount,
  note = 'AVANS',
} = {}) {
  if (!supabase?.from) throw new Error('SUPABASE_CLIENT_REQUIRED');

  const verifiedActor = await verifyPayrollActor(supabase, actor);
  const workerPin = normalizePin(worker?.pin);
  const workerName = clean(worker?.name, workerPin);
  const cleanAmount = normalizeMoney(amount);
  if (!workerPin || !workerName) throw new Error('WORKER_REQUIRED');
  if (!(cleanAmount > 0)) throw new Error('ADVANCE_AMOUNT_REQUIRED');

  const createdAt = new Date().toISOString();
  const idempotencyKey = createActionId(workerPin);
  const cleanNote = clean(note, 'AVANS');
  const variants = [
    {
      amount: cleanAmount,
      type: 'ADVANCE',
      status: 'ADVANCE',
      method: 'CASH',
      note: cleanNote,
      created_by_pin: workerPin,
      created_by_name: workerName,
      created_by_role: 'WORKER',
      actor_pin: verifiedActor.pin,
      actor_name: verifiedActor.name,
      source: 'PAYROLL',
      source_module: 'ARKA',
      source_ref: idempotencyKey,
      idempotency_key: idempotencyKey,
      client_name: workerName,
      created_at: createdAt,
      updated_at: createdAt,
    },
    {
      amount: cleanAmount,
      type: 'ADVANCE',
      status: 'ADVANCE',
      note: cleanNote,
      created_by_pin: workerPin,
      created_by_name: workerName,
      actor_pin: verifiedActor.pin,
      actor_name: verifiedActor.name,
      source_module: 'ARKA',
      idempotency_key: idempotencyKey,
      client_name: workerName,
      created_at: createdAt,
    },
    {
      amount: cleanAmount,
      type: 'ADVANCE',
      status: 'ADVANCE',
      note: cleanNote,
      created_by_pin: workerPin,
      created_by_name: workerName,
      client_name: workerName,
      created_at: createdAt,
    },
  ];

  let lastError = null;
  for (const row of variants) {
    const result = await supabase.from('arka_pending_payments').insert(row);
    if (!result?.error) {
      return {
        ok: true,
        amount: cleanAmount,
        workerPin,
        workerName,
        actorPin: verifiedActor.pin,
        actorName: verifiedActor.name,
        idempotencyKey,
      };
    }
    lastError = result.error;
    if (isSchemaCompatibilityError(result.error)) continue;
    throw result.error;
  }

  throw lastError || new Error('PAYROLL_ADVANCE_INSERT_FAILED');
}
