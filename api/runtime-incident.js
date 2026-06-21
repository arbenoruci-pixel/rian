import { apiFail, apiOk, createAdminClientOrThrow, readBody } from './_helpers.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return apiFail(res, 'INVALID_JSON', 400);
    if (!body.bootId && !body.boot_id) return apiFail(res, 'MISSING_BOOT_ID', 400);

    let stored = false;
    try {
      const supabase = createAdminClientOrThrow();
      const row = {
        boot_id: String(body.bootId || body.boot_id || ''),
        incident_type: String(body.incidentType || body.incident_type || body.reason || 'unknown').slice(0, 120),
        boot_root_path: String(body.bootRootPath || body.boot_root_path || body.currentPath || body.current_path || '/').slice(0, 240),
        current_path: String(body.currentPath || body.current_path || '/').slice(0, 240),
        search: String(body.currentSearch || body.current_search || '').slice(0, 400),
        phase: String(body.phase || '').slice(0, 120),
        started_at_client: body.startedAt || body.started_at || null,
        ready_at_client: body.readyAt || body.ready_at || null,
        last_event_at_client: body.lastEventAt || body.last_event_at || new Date().toISOString(),
        last_event_type: String(body.lastEventType || body.last_event_type || body.reason || '').slice(0, 120),
        ended_cleanly: !!body.endedCleanly,
        ui_ready: !!body.uiReady,
        overlay_shown: !!body.overlayShown,
        online: typeof body.online === 'boolean' ? body.online : null,
        visibility_state: body.visibilityState == null ? null : String(body.visibilityState),
        sw_epoch: body.swEpoch == null ? null : String(body.swEpoch),
        user_agent: body.userAgent == null ? null : String(body.userAgent).slice(0, 500),
        event_count: Array.isArray(body.events) ? body.events.length : null,
        events_json: Array.isArray(body.events) ? body.events : null,
        meta_json: body.meta && typeof body.meta === 'object' ? body.meta : null,
      };
      await supabase.from('runtime_incidents').insert(row);
      stored = true;
    } catch {}

    return apiOk(res, { stored });
  } catch (error) {
    return apiFail(res, error, 500);
  }
}
