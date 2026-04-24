function isPlainObject(value) {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
}

function asObject(value) {
  return isPlainObject(value) ? value : {};
}

function stripUndefinedShallow(obj) {
  const out = { ...(obj || {}) };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) delete out[key];
  }
  return out;
}

function normalizeTCodeLoose(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '').replace(/^0+/, '');
  return digits ? `T${digits}` : raw.toUpperCase();
}

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function hasLetters(value) {
  return /[a-z]/i.test(String(value || ''));
}

function digitsFromNumericLikeText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (hasLetters(raw)) return '';
  return onlyDigits(raw);
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function toFiniteNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toSafeIntegerOrNull(value, { maxDigits = 15 } = {}) {
  const digits = onlyDigits(value).replace(/^0+/, '');
  if (!digits) return null;
  const trimmed = digits.slice(0, maxDigits);
  const num = Number(trimmed);
  return Number.isSafeInteger(num) ? num : null;
}

function stripLocalFieldsDeep(value) {
  if (Array.isArray(value)) return value.map(stripLocalFieldsDeep);
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const k = String(key || '');
    if (!k) continue;
    if (k.startsWith('_')) continue;
    if (
      k === 'table' ||
      k === '_table' ||
      k === 'source' ||
      k === '__src' ||
      k === 'order_table' ||
      k === 'localOnly' ||
      k === 'kind' ||
      k === 'op' ||
      k === 'op_id' ||
      k === 'attempts' ||
      k === 'lastError' ||
      k === 'nextRetryAt' ||
      k === 'server_id' ||
      k === 'sync_state' ||
      k === 'local_oid' ||
      k === 'oid' ||
      k === 'data_patch'
    ) {
      continue;
    }
    out[k] = stripLocalFieldsDeep(rawValue);
  }
  return out;
}

export function buildTransportClientSearchCode({ tcode = '', name = '', phoneDigits = '' } = {}) {
  const tDigits = onlyDigits(tcode).replace(/^0+/, '');
  const pDigits = onlyDigits(phoneDigits);
  const mergedDigits = `${tDigits}${pDigits}`.replace(/^0+/, '');
  if (mergedDigits) return mergedDigits.slice(0, 15);

  const nameSeed = normalizeSearchText(name)
    .replace(/[^a-z0-9]/g, '')
    .split('')
    .map((ch) => String(ch.charCodeAt(0)).padStart(3, '0'))
    .join('')
    .replace(/^0+/, '');

  return (nameSeed || String(Date.now())).replace(/\D+/g, '').slice(0, 15);
}

export function sanitizeTransportClientPayload(input = {}, opts = {}) {
  const mode = String(opts?.mode || 'upsert').trim().toLowerCase();
  const raw = stripUndefinedShallow(asObject(input));
  const next = { ...raw };

  const coords = isPlainObject(next.coords) ? next.coords : null;
  if (coords) {
    if (next.gps_lat === undefined && coords.lat !== undefined) next.gps_lat = coords.lat;
    if (next.gps_lng === undefined && coords.lng !== undefined) next.gps_lng = coords.lng;
    delete next.coords;
  }

  delete next.table;
  delete next._table;
  delete next.source;
  delete next.__src;
  delete next.order_table;
  delete next.localOnly;
  delete next.kind;
  delete next.op;
  delete next.op_id;
  delete next.attempts;
  delete next.lastError;
  delete next.nextRetryAt;
  delete next.server_id;
  delete next.created_at;
  delete next.local_oid;
  delete next.oid;
  delete next.sync_state;
  delete next.data_patch;
  Object.keys(next).forEach((key) => {
    if (String(key || '').startsWith('_')) delete next[key];
  });

  const normalizedTcode = normalizeTCodeLoose(opts?.tcode || next.tcode || next.client_tcode || '');
  const name = Object.prototype.hasOwnProperty.call(next, 'name') || mode === 'upsert'
    ? String(next.name || '').trim()
    : undefined;
  const phone = Object.prototype.hasOwnProperty.call(next, 'phone') || mode === 'upsert'
    ? String(next.phone || '').trim()
    : undefined;
  const explicitPhoneDigits = digitsFromNumericLikeText(opts?.phoneDigits || '');
  const inputPhoneDigits = digitsFromNumericLikeText(next.phone_digits || '');
  const phoneDigitsRaw = explicitPhoneDigits || inputPhoneDigits || onlyDigits(phone || '');
  const phoneDigits = phoneDigitsRaw ? toSafeIntegerOrNull(phoneDigitsRaw, { maxDigits: 15 }) : null;

  const out = {};
  if (mode === 'upsert' && next.id != null && String(next.id || '').trim()) {
    out.id = String(next.id).trim();
  }
  if (normalizedTcode) out.tcode = normalizedTcode;
  if (name !== undefined) out.name = name;
  if (phone !== undefined) out.phone = phone;
  if (phoneDigits !== null) out.phone_digits = phoneDigits;
  else if (mode === 'upsert') out.phone_digits = null;

  if (Object.prototype.hasOwnProperty.call(next, 'address') || mode === 'upsert') {
    const address = next.address == null ? null : String(next.address).trim();
    out.address = address || null;
  }

  if (Object.prototype.hasOwnProperty.call(next, 'gps_lat') || mode === 'upsert') {
    out.gps_lat = toFiniteNumberOrNull(next.gps_lat);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'gps_lng') || mode === 'upsert') {
    out.gps_lng = toFiniteNumberOrNull(next.gps_lng);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'notes') || mode === 'upsert') {
    const notes = next.notes == null ? null : String(next.notes).trim();
    out.notes = notes || null;
  }

  const searchCodeSeed = digitsFromNumericLikeText(next.search_code || '').slice(0, 15);
  const generatedSearchCode = buildTransportClientSearchCode({
    tcode: normalizedTcode,
    name: name || '',
    phoneDigits: phoneDigitsRaw,
  });
  const searchCode = toSafeIntegerOrNull(searchCodeSeed || generatedSearchCode, { maxDigits: 15 });
  if (searchCode !== null) out.search_code = searchCode;
  else if (mode === 'upsert') out.search_code = toSafeIntegerOrNull(String(Date.now()).slice(-13), { maxDigits: 13 });

  out.updated_at = String(next.updated_at || new Date().toISOString()).trim();
  return stripUndefinedShallow(out);
}

export function sanitizeTransportOrderPayload(input = {}, opts = {}) {
  const raw = stripUndefinedShallow(asObject(input));
  const base = { ...raw };
  const nextData = stripLocalFieldsDeep(asObject(base.data));

  delete base.table;
  delete base._table;
  delete base.source;
  delete base.__src;
  delete base.order_table;
  delete base.localOnly;
  delete base.kind;
  delete base.op;
  delete base.op_id;
  delete base.attempts;
  delete base.lastError;
  delete base.nextRetryAt;
  delete base.server_id;
  delete base.code_n;
  delete base.data_patch;
  delete base.sync_state;
  delete base.local_oid;
  delete base.oid;
  Object.keys(base).forEach((key) => {
    if (String(key || '').startsWith('_')) delete base[key];
  });

  const moveToData = [
    'transport_id',
    'transport_user_id',
    'transport_pin',
    'transport_name',
    'driver_name',
    'driver_pin',
    'actor',
    'assigned_driver_id',
    'client',
    'tepiha',
    'staza',
    'shkallore',
    'pay',
    'notes',
    'totals',
    'gps_lat',
    'gps_lng',
    'created_by_pin',
    'created_by_role',
    'created_by_name',
    'created_by',
    'base_note',
    'base_location',
    'brought_by',
    'rack_slots',
    'ready_note_text',
  ];
  for (const key of moveToData) {
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      nextData[key] = stripLocalFieldsDeep(base[key]);
      delete base[key];
    }
  }

  const clientObj = asObject(nextData.client);
  const out = {};
  const id = String(base.id || '').trim();
  if (id) out.id = id;

  const codeStr = normalizeTCodeLoose(base.code_str || base.client_tcode || clientObj.tcode || clientObj.code || '');
  if (codeStr) out.code_str = codeStr;

  const clientTcode = normalizeTCodeLoose(base.client_tcode || clientObj.tcode || clientObj.code || codeStr || '');
  if (clientTcode) out.client_tcode = clientTcode;

  // IMPORTANT:
  // `transport_orders.transport_id` is a GENERATED column in production.
  // We must NEVER write it from app payloads. Keep it only inside `data.transport_id`.
  const transportId = String(base.transport_id || nextData.transport_id || '').trim();
  if (transportId && !String(nextData.transport_id || '').trim()) nextData.transport_id = transportId;

  if (base.client_id !== undefined && base.client_id !== null && String(base.client_id).trim()) {
    out.client_id = base.client_id;
  }

  const clientName = String(base.client_name || clientObj.name || '').trim();
  if (clientName) out.client_name = clientName;

  const clientPhone = String(base.client_phone || clientObj.phone || '').trim();
  if (clientPhone) out.client_phone = clientPhone;

  const visitNr = Number(base.visit_nr);
  if (Number.isFinite(visitNr) && visitNr > 0) out.visit_nr = visitNr;

  const status = String(base.status || '').trim();
  if (status) out.status = status;

  const createdAt = String(base.created_at || '').trim();
  if (createdAt) out.created_at = createdAt;

  const updatedAt = String(base.updated_at || opts.updated_at || new Date().toISOString()).trim();
  if (updatedAt) out.updated_at = updatedAt;

  const readyAt = String(base.ready_at || '').trim();
  if (readyAt) out.ready_at = readyAt;

  const pickedUpAt = String(base.picked_up_at || '').trim();
  if (pickedUpAt) out.picked_up_at = pickedUpAt;

  const deliveredAt = String(base.delivered_at || '').trim();
  if (deliveredAt) out.delivered_at = deliveredAt;

  const rescheduleAt = String(base.reschedule_at || '').trim();
  if (rescheduleAt) out.reschedule_at = rescheduleAt;

  const rescheduleNote = String(base.reschedule_note || '').trim();
  if (rescheduleNote) out.reschedule_note = rescheduleNote;

  if (Object.keys(nextData).length) out.data = stripUndefinedShallow(stripLocalFieldsDeep(nextData));
  if (opts.includeTable) out.table = 'transport_orders';
  return stripUndefinedShallow(out);
}
