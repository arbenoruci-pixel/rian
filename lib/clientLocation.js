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
