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
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  try {
    if (controller) timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 7000));
    const response = await fetch('/api/admin/devices', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: String(action || '').trim().toUpperCase(),
        ...(deviceId ? { deviceId: cleanDeviceId(deviceId) } : {}),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) {
      throw new DeviceAdminApiError(payload?.error || `DEVICE_ADMIN_HTTP_${response.status}`, response.status);
    }
    return payload;
  } catch (error) {
    if (error instanceof DeviceAdminApiError) throw error;
    if (error?.name === 'AbortError') throw new DeviceAdminApiError('DEVICE_ADMIN_TIMEOUT', 504);
    throw new DeviceAdminApiError('DEVICE_ADMIN_NETWORK_FAILED', 503);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listPendingDevices() {
  const payload = await deviceAdminRequest('LIST_PENDING');
  return Array.isArray(payload?.devices) ? payload.devices : [];
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
