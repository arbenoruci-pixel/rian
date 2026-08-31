function getErrorText(error) {
  try {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return JSON.stringify({
      name: error?.name || '',
      message: error?.message || '',
      code: error?.code || '',
      status: error?.status || error?.statusCode || error?.httpStatus || '',
      details: error?.details || '',
      hint: error?.hint || '',
    });
  } catch {
    return String(error || '');
  }
}

function numericHttpStatus(error) {
  for (const candidate of [error?.status, error?.statusCode, error?.httpStatus]) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return 0;
}

export function isTransportSyncNetworkError(error) {
  const text = getErrorText(error).toLowerCase();
  return (
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('timeout') ||
    text.includes('aborted') ||
    text.includes('load failed')
  );
}

export function classifyTransportSyncError(error) {
  const text = getErrorText(error).toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const status = numericHttpStatus(error);

  if (
    code === 'TRANSPORT_ORDER_PATCH_TARGET_NOT_FOUND' ||
    code === 'TRANSPORT_CLIENT_PATCH_TARGET_NOT_FOUND' ||
    code === 'PGRST116' ||
    status === 404
  ) {
    return { permanent: true, category: 'target_missing', reason: 'patch_target_not_found' };
  }

  if (
    code === '428C9' ||
    text.includes('generated column') ||
    text.includes('cannot insert a non-default value into column')
  ) {
    return { permanent: true, category: 'schema_mismatch', reason: 'generated_column_write' };
  }

  if (
    code === 'PGRST204' ||
    text.includes('pgrst204') ||
    text.includes('schema cache') ||
    text.includes('could not find') ||
    (text.includes('column') && text.includes('transport_orders'))
  ) {
    return { permanent: true, category: 'schema_mismatch', reason: 'unknown_column' };
  }

  if (
    code === '22P02' ||
    text.includes('invalid input syntax for type bigint') ||
    text.includes('invalid input syntax')
  ) {
    return { permanent: true, category: 'payload_invalid', reason: 'invalid_numeric_mapping' };
  }

  if (
    code === '23502' ||
    text.includes('null value in column') ||
    text.includes('violates not-null constraint')
  ) {
    return { permanent: true, category: 'payload_invalid', reason: 'not_null_violation' };
  }

  // 401 normally means the approved-device session must be refreshed. Keep the
  // operation retryable so re-login can resume it; true permission denials stay
  // paused and cannot starve unrelated queue entries.
  if (code === '42501' || status === 403) {
    return { permanent: true, category: 'authorization_denied', reason: 'write_not_authorized' };
  }

  if (['23503', '23505', '23514'].includes(code) || status === 409) {
    return { permanent: true, category: 'write_conflict', reason: 'constraint_or_conflict' };
  }

  // Retry throttling/timeouts after the server asks us to wait. Other 4xx
  // responses describe this operation, so retain it as paused and continue the
  // queue instead of starving unrelated work behind it.
  if (status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status)) {
    return { permanent: true, category: 'request_rejected', reason: `http_${status}` };
  }

  return { permanent: false, category: '', reason: '' };
}

export function makeTransportSyncError(message, { code = '', status = 0, details = '' } = {}) {
  const error = new Error(String(message || code || 'TRANSPORT_SYNC_FAILED'));
  if (code) error.code = String(code);
  if (Number(status) > 0) error.status = Number(status);
  if (details) error.details = String(details);
  return error;
}

const TRANSPORT_PATCH_COLUMNS = [
  'status',
  'created_at',
  'updated_at',
  'ready_at',
  'picked_up_at',
  'delivered_at',
  'reschedule_at',
  'reschedule_note',
  'client_id',
  'client_name',
  'client_phone',
];

function isPlainObject(value) {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
}

function hasAnyOwn(object, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(object || {}, key));
}

// Current outbox entries store the DB patch at payload's top level. A few old
// app versions wrapped it once in payload.data. Prefer the top-level form when
// it has any real patch column so status/timestamps are never discarded.
export function selectTransportOrderPatchSource(payload = {}) {
  const outer = isPlainObject(payload) ? payload : {};
  const nested = isPlainObject(outer.data) ? outer.data : {};
  if (hasAnyOwn(outer, TRANSPORT_PATCH_COLUMNS)) return outer;

  const nestedLooksLikeLegacyPatch =
    hasAnyOwn(nested, TRANSPORT_PATCH_COLUMNS) &&
    (isPlainObject(nested.data) || hasAnyOwn(nested, TRANSPORT_PATCH_COLUMNS.filter((key) => key !== 'status')));

  if (!nestedLooksLikeLegacyPatch) return outer;
  return {
    ...nested,
    id: nested.id || outer.id || outer.order_id || outer.local_oid,
  };
}
