function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function countTransportMeasurementGroups(data = {}) {
  const source = asObject(data);
  const tepiha = Math.max(arrayLength(source.tepiha), arrayLength(source.tepihaRows));
  const staza = Math.max(arrayLength(source.staza), arrayLength(source.stazaRows));
  const stairs = Number(asObject(source.shkallore).qty || 0) > 0 ? 1 : 0;
  return tepiha + staza + stairs;
}

export function preserveTransportMeasurements(currentData = {}, incomingData = {}) {
  const current = asObject(currentData);
  const incoming = asObject(incomingData);
  const oldGroups = countTransportMeasurementGroups(current);
  const incomingGroups = countTransportMeasurementGroups(incoming);
  const allowClear = String(incoming.measurement_clear_intent || '').toLowerCase() === 'true';

  if (oldGroups <= 0 || incomingGroups > 0 || allowClear) {
    return { data: incoming, protected: false, oldGroups, incomingGroups };
  }

  const next = { ...incoming };
  for (const key of ['tepiha', 'tepihaRows', 'staza', 'stazaRows', 'shkallore']) {
    if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
  }

  if (Object.prototype.hasOwnProperty.call(current, 'pay')) {
    next.pay = { ...asObject(current.pay), ...asObject(incoming.pay) };
  }

  for (const key of ['totalM2', 'total_m2', 'm2', 'totalEuro', 'total_eur', 'price_total']) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key) && Object.prototype.hasOwnProperty.call(current, key)) {
      next[key] = current[key];
    }
  }

  next.measurement_loss_guard_v1 = {
    protected_at: new Date().toISOString(),
    reason: 'STALE_FULL_DATA_OVERWRITE_BLOCKED_CLIENT',
    old_groups: oldGroups,
    attempted_groups: incomingGroups,
  };

  return { data: next, protected: true, oldGroups, incomingGroups };
}
