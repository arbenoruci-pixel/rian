// Canonical worker PIN helpers.
// A worker PIN is always numeric. UUID/user IDs must never be used as a PIN.

const DIRECT_PIN_KEYS = Object.freeze([
  'pin',
  'pinCode',
  'pin_code',
  'transport_pin',
  'worker_pin',
  'created_by_pin',
  'actor_pin',
  'user_pin',
]);

const LEGACY_NUMERIC_ID_KEYS = Object.freeze(['user_id', 'id']);

export function normalizeRealPin(value, { min = 3, max = 12 } = {}) {
  if (value == null) return '';
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return '';
  if (raw.length < min || raw.length > max) return '';
  return raw;
}

export function resolveActorPin(input, { allowNumericIdFallback = true } = {}) {
  if (!input || typeof input !== 'object') return '';

  for (const key of DIRECT_PIN_KEYS) {
    const pin = normalizeRealPin(input[key]);
    if (pin) return pin;
  }

  // Some very old sessions stored the PIN in `id`. Accept only a short numeric
  // value. UUIDs and database user IDs are deliberately rejected.
  if (allowNumericIdFallback) {
    for (const key of LEGACY_NUMERIC_ID_KEYS) {
      const pin = normalizeRealPin(input[key]);
      if (pin) return pin;
    }
  }

  return '';
}

export function hasRealActorPin(input) {
  return !!resolveActorPin(input);
}
