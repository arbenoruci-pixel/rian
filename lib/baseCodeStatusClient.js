import { getActor } from './actorSession.js';

export async function fetchBaseCodeStatuses(codes, { fetchImpl = globalThis.fetch, actor = getActor() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetchImpl('/api/base-code-status', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes, expectedActorId: actor?.id || actor?.user_id || '' }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok || !Array.isArray(result.rows)) throw new Error(result.error || 'BASE_CODE_STATUS_READ_FAILED');
    return result.rows;
  } finally { clearTimeout(timer); }
}
