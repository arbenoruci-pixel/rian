import { approvedApiRequest } from './approvedApiRequest.js';
import { getDeviceId } from './deviceId.js';

export async function fetchBaseCodeStatuses(codes, options = {}) {
  if (!Array.isArray(codes) || codes.length > 160 || codes.some((value) => {
    if (typeof value !== 'number' && typeof value !== 'string') return true;
    const raw = String(value).trim();
    return !/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0;
  })) {
    throw Object.assign(new Error('BASE_CODE_STATUS_CODES_INVALID'), { code: 'BASE_CODE_STATUS_CODES_INVALID' });
  }
  const uniqueCodes = [...new Set(codes.map(Number))];
  if (!uniqueCodes.length) return [];

  // Restore a missing cookie from the existing stable device id before the
  // request. This needs no login call; approvedApiRequest retains its normal
  // one-time repair for a genuine AUTH_REQUIRED response.
  getDeviceId();
  const { draft, ...requestOptions } = options || {};
  const result = await approvedApiRequest('/api/base-codes/status', {
    codes: uniqueCodes,
    ...(draft === undefined ? {} : { draft }),
  }, {
    timeoutMs: 7000,
    ...requestOptions,
  });
  if (!Array.isArray(result?.items)) {
    throw Object.assign(new Error('BASE_CODE_STATUS_INVALID_RESPONSE'), { code: 'BASE_CODE_STATUS_INVALID_RESPONSE' });
  }
  return result.items;
}
