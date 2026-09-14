import { familyRequest } from '../clientFamilyClient.js';
import { clientLocationMapUrl } from '../clientLocation.js';

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const coordinate = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;

export function legacyTransportLocation(row) {
  const d = row?.data || {};
  for (const [lat, lng] of [
    [d.gps_lat, d.gps_lng], [row?.gps_lat, row?.gps_lng],
    [d.client?.gps_lat, d.client?.gps_lng], [d.client?.gps?.lat, d.client?.gps?.lng],
    [d.lat, d.lng ?? d.lon], [row?.lat, row?.lng ?? row?.lon],
  ]) {
    const location = { latitude: coordinate(lat), longitude: coordinate(lng) };
    if (clientLocationMapUrl(location)) return location;
  }
  return legacyTransportAddress(row);
}

function legacyTransportAddress(row) {
  const d = row?.data || {};
  const address = String(d.client?.address || row?.pickup_address || row?.address || d.address || d.pickup_address || '').trim();
  return address && !/^pa adres[ëe]$/i.test(address) ? { address } : null;
}

export async function resolveTransportClientMap(row, request = familyRequest) {
  // The same authenticated exact-visit read used by Dispatch; never expose public coordinates.
  if (uuid(row?.id) && uuid(row?.client_id)) {
    const result = await request({ action: 'GET_LOCATION', source: 'TRANSPORT', orderId: String(row.id) });
    if (result.location) {
      const url = clientLocationMapUrl(result.location);
      if (!url) throw new Error('Lokacioni i klientit nuk është i vlefshëm.');
      return url;
    }
    // A successful server read with no GPS must not revive a removed point from a stale board row.
    const addressUrl = clientLocationMapUrl(legacyTransportAddress(row));
    if (!addressUrl) throw new Error('Klienti ende s’ka dërguar lokacion ose adresë.');
    return addressUrl;
  }
  const url = clientLocationMapUrl(legacyTransportLocation(row));
  if (!url) throw new Error('Klienti ende s’ka dërguar lokacion ose adresë.');
  return url;
}

const pending = new Set();
export async function openTransportClientMap(row) {
  const key = String(row?.id || '');
  if (pending.has(key)) return;
  pending.add(key);
  try {
    const url = await resolveTransportClientMap(row);
    // Same-tab navigation works after an async read on iPhone without popup permission.
    window.location.assign(url);
  } catch (error) {
    window.alert(error?.code || error?.name === 'AbortError' || error?.message === 'Failed to fetch'
      ? 'Lokacioni nuk u ngarkua. Kontrollo lidhjen dhe provo përsëri.'
      : error?.message || 'Lokacioni nuk u ngarkua. Provo përsëri.');
  } finally { pending.delete(key); }
}
