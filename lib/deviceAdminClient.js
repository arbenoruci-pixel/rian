import { approvedApiRequest } from './approvedApiRequest.js';

export class DeviceAdminApiError extends Error {
  constructor(code, status = 400) {
    super(String(code || 'DEVICE_ADMIN_REQUEST_FAILED'));
    this.name = 'DeviceAdminApiError';
    this.code = String(code || 'DEVICE_ADMIN_REQUEST_FAILED');
    this.status = Number(status) || 400;
  }
}

function cleanDeviceId(value) {
  return String(value || '').trim().slice(0, 120);
}

async function deviceAdminRequest(action, { deviceId = '', timeoutMs = 7000 } = {}) {
  try {
    return await approvedApiRequest('/api/admin/devices', {
      action: String(action || '').trim().toUpperCase(),
      ...(deviceId ? { deviceId: cleanDeviceId(deviceId) } : {}),
    }, { timeoutMs });
  } catch (error) {
    if (error?.httpStatus || error?.status) throw new DeviceAdminApiError(error.code || error.message, error.httpStatus || error.status);
    if (error?.name === 'AbortError') throw new DeviceAdminApiError('DEVICE_ADMIN_TIMEOUT', 504);
    throw new DeviceAdminApiError(error?.code || 'DEVICE_ADMIN_NETWORK_FAILED', 503);
  }
}

export async function listPendingDevices() {
  const payload = await deviceAdminRequest('LIST_PENDING');
  if (!Array.isArray(payload?.devices)) throw new DeviceAdminApiError('DEVICE_PENDING_LIST_INVALID_RESPONSE', 502);
  return payload.devices;
}

export async function approvePendingDevice(deviceId) {
  return deviceAdminRequest('APPROVE', { deviceId });
}

export async function rejectPendingDevice(deviceId) {
  return deviceAdminRequest('REJECT', { deviceId });
}

export async function revokeApprovedDevice(deviceId) {
  return deviceAdminRequest('REVOKE', { deviceId });
}
