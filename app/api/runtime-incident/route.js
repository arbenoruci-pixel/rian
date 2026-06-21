import { NextResponse } from 'next/server';
import { createAdminClientOrNull } from '@/lib/supabaseAdminClient';

export const dynamic = 'force-dynamic';

function cleanText(value, max = 1000) {
  const text = String(value || '').trim();
  return text.slice(0, max);
}

function cleanBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeJson(value, fallback = null) {
  try {
    if (value == null) return fallback;
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function buildRow(body = {}) {
  const incidentType = cleanText(body.incidentType || body.reason || body.lastEventType || 'runtime_incident', 80);
  const bootId = cleanText(body.bootId, 80);
  return {
    boot_id: bootId,
    incident_type: incidentType,
    boot_root_path: cleanText(body.bootRootPath || body.currentPath || '/', 240),
    current_path: cleanText(body.currentPath || body.bootRootPath || '/', 240),
    search: cleanText(body.currentSearch || body.search, 1000),
    phase: cleanText(body.phase || 'incident_only', 80),
    started_at_client: cleanText(body.startedAt, 64) || null,
    ready_at_client: cleanText(body.readyAt, 64) || null,
    last_event_at_client: cleanText(body.lastEventAt, 64) || null,
    last_event_type: cleanText(body.lastEventType || incidentType, 120),
    last_heartbeat_at_client: cleanText(body.lastEventAt || body.readyAt || body.startedAt, 64) || null,
    backgrounded_at_client: null,
    resumed_at_client: null,
    ended_cleanly: cleanBoolean(body.endedCleanly),
    ui_ready: cleanBoolean(body.uiReady),
    overlay_shown: cleanBoolean(body.overlayShown),
    online: cleanBoolean(body.online),
    visibility_state: cleanText(body.visibilityState, 40),
    actor_role: cleanText(body.actorRole, 80),
    actor_has_actor: typeof body.actorHasActor === 'boolean' ? body.actorHasActor : null,
    sw_controlled: cleanBoolean(body.swControlled),
    sw_epoch: cleanText(body.swEpoch, 120),
    user_agent: cleanText(body.userAgent, 1000),
    event_count: 0,
    events_json: [],
    meta_json: {
      source: 'simple_incident_route_v2',
      sessionId: cleanText(body.sessionId, 80) || null,
      reason: cleanText(body.reason || body.incidentType || body.lastEventType, 120) || null,
      message: cleanText(body?.meta?.message || body.message, 2000) || null,
      stack: cleanText(body?.meta?.stack || body.stack, 4000) || null,
      name: cleanText(body?.meta?.name || body.name, 200) || null,
      meta: safeJson(body.meta, {}),
    },
  };
}

function buildDuplicateKey(row) {
  return [
    String(row.boot_id || ''),
    String(row.incident_type || ''),
    String(row.current_path || ''),
    String(row.last_event_type || ''),
  ].join('|');
}

async function readExistingIncident(supabase, row) {
  const res = await supabase
    .from('runtime_incidents')
    .select('id')
    .eq('boot_id', row.boot_id)
    .eq('incident_type', row.incident_type)
    .eq('current_path', row.current_path)
    .eq('last_event_type', row.last_event_type)
    .limit(1);
  if (res.error) throw new Error(String(res.error.message || res.error));
  const item = Array.isArray(res.data) ? res.data[0] : null;
  return item?.id || null;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ ok: false, error: 'INVALID_JSON' }, { status: 400 });
    }

    const row = buildRow(body);
    if (!row.boot_id) {
      return NextResponse.json({ ok: false, error: 'MISSING_BOOT_ID' }, { status: 400 });
    }

    const supabase = createAdminClientOrNull();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' }, { status: 503 });
    }

    const duplicateKey = buildDuplicateKey(row);
    row.meta_json = { ...(row.meta_json || {}), duplicateKey };

    let existingId = await readExistingIncident(supabase, row);
    const duplicate = !!existingId;
    if (!existingId) {
      const inserted = await supabase.from('runtime_incidents').insert(row).select('id').limit(1);
      if (inserted.error) {
        return NextResponse.json({ ok: false, error: String(inserted.error.message || inserted.error) }, { status: 500 });
      }
      existingId = Array.isArray(inserted.data) ? (inserted.data[0]?.id || null) : null;
    }

    return NextResponse.json({ ok: !!existingId, stored: !duplicate, duplicate, id: existingId });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error || 'RUNTIME_INCIDENT_ROUTE_FAILED') }, { status: 500 });
  }
}
