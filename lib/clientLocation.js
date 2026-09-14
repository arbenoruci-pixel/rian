export function cleanClientLocation(value = {}) {
  const address = typeof value.address === 'string' ? value.address.trim() : '';
  const lat = value.latitude, lng = value.longitude;
  const hasCoords = lat != null || lng != null;
  if (address.length > 300 || (hasCoords && (
    typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < -90 || lat > 90 || lng < -180 || lng > 180
  )) || (!hasCoords && !address)) throw new Error('FAMILY_LOCATION_INVALID');
  return { address, latitude: hasCoords ? lat : null, longitude: hasCoords ? lng : null };
}

export function clientLocationMapUrl(value) {
  try {
    const location = cleanClientLocation(value);
    const query = location.latitude != null ? `${location.latitude},${location.longitude}` : location.address;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  } catch { return ''; }
}

// Older tracking links saved GPS on the visit. Never coerce empty values to 0.
export function orderClientLocation(order) {
  const data = order?.data;
  const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;
  try {
    const location = cleanClientLocation({ latitude: number(data?.gps_lat), longitude: number(data?.gps_lng) });
    return { ...location, order_id: String(order.id), created_at: null };
  } catch { return null; }
}
