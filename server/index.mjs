import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { APP_VERSION, APP_DATA_EPOCH } from '../lib/appEpoch.js';
import { sanitizeTransportOrderPayload } from '../lib/transport/sanitize.js';
import backupLatestHandler from '../api/backup/latest.js';
import backupRunHandler from '../api/backup/run.js';
import backupDatesHandler from '../api/backup/dates.js';
import backupRestoreHandler from '../api/backup/restore.js';
import cronBackupHandler from '../api/cron/backup.js';
import { canAutoApproveDevice, rolesCompatible } from '../lib/roles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const upload = multer();
const DEV_MODE = process.argv.includes('--dev');
const PORT = Number(process.env.PORT || (DEV_MODE ? 8787 : 3000));

// DEV source of truth: this Express server behind Vite /api proxy.
// DEPLOY source of truth: root api/** handlers. Keep active endpoint behavior aligned.
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

function pickEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

function createAdminClientOrThrow() {
  const url = pickEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = pickEnv('SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE');
  if (!url || !serviceKey) throw new Error('SERVER_NOT_CONFIGURED');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function apiOk(res, payload = {}, status = 200) {
  return res.status(status).json({ ok: true, ...payload });
}

function apiFail(res, error, status = 400, extra = {}) {
  const message = typeof error === 'string' ? error : String(error?.message || error || 'UNKNOWN_ERROR');
  return res.status(status).json({ ok: false, error: message, ...extra });
}

function normalizePin(value, { min = 3, max = 12 } = {}) {
  const clean = String(value || '').replace(/\D/g, '').trim();
  if (!clean || clean.length < min || clean.length > max) return '';
  return clean;
}

function normalizeRole(value) {
  const clean = String(value || '').trim().toUpperCase();
  if (!clean) return '';
  return clean;
}

function normalizeDeviceId(value) {
  return String(value || '').trim().slice(0, 120);
}

function cleanText(value) {
  return String(value || '').trim();
}

function safeNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function jparse(value, fallback = {}) {
  try {
    if (value && typeof value === 'object') return value;
    if (value == null || value === '') return fallback;
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normPhone(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizeName(value) {
  return String(value || '').trim();
}

function orderData(row) {
  return asObject(jparse(row?.data, {}));
}

function pickClientCode(row, data) {
  const client = asObject(data?.client);
  return String(row?.client_tcode || row?.code_str || client?.tcode || client?.code || row?.code || '').trim();
}

function pickClientName(row, data, clientRow) {
  const client = asObject(data?.client);
  return normalizeName(row?.client_name || clientRow?.name || clientRow?.full_name || client?.name || client?.full_name || row?.name || '-');
}

function pickClientPhone(row, data, clientRow) {
  const client = asObject(data?.client);
  return String(row?.client_phone || clientRow?.phone || client?.phone || '').trim();
}

function extractClientKeys(row, data) {
  const client = asObject(data?.client);
  const keys = new Set();
  const tcode = String(row?.client_tcode || client?.tcode || client?.code || '').trim();
  const id = String(row?.client_id || client?.id || '').trim();
  const phone = normPhone(row?.client_phone || client?.phone || '');
  if (tcode) keys.add(`tcode:${tcode.toUpperCase()}`);
  if (id) keys.add(`id:${id}`);
  if (phone) keys.add(`phone:${phone}`);
  return Array.from(keys);
}

async function readUsers(sb) {
  const attempts = [
    () => sb.from('users').select('id,name,pin,role').order('name', { ascending: true }).limit(5000),
    () => sb.from('tepiha_users').select('id,name,pin,role').order('name', { ascending: true }).limit(5000),
  ];
  for (const run of attempts) {
    try {
      const res = await run();
      if (!res?.error) return Array.isArray(res?.data) ? res.data : [];
    } catch {}
  }
  return [];
}

app.get('/api/version', (_req, res) => {
  apiOk(res, { v: APP_VERSION, epoch: APP_DATA_EPOCH });
});



app.post('/api/auth/validate-pin', async (req, res) => {
  try {
    const pin = normalizePin(req.body?.pin, { min: 3, max: 12 });
    if (!pin) return apiFail(res, 'PIN_REQUIRED', 400);
    const supabase = createAdminClientOrThrow();
    const { data, error } = await supabase
      .from('users')
      .select('pin,name,role,is_active')
      .eq('pin', pin)
      .limit(1)
      .maybeSingle();
    if (error) return apiFail(res, error.message, 500);
    if (!data) return apiFail(res, 'PIN_NOT_FOUND', 404);
    if (data.is_active === false) return apiFail(res, 'PIN_DISABLED', 403);
    return apiOk(res, { user: { pin: String(data.pin), name: data.name || null, role: String(data.role || '').toUpperCase() || null } });
  } catch (error) {
    return apiFail(res, error, 500);
  }
});

app.post('/api/auth/login', async (req, res) => {
  let device_id = '';
  try {
    const pin = normalizePin(req.body?.pin, { min: 3, max: 12 });
    const requested_role = normalizeRole(req.body?.role);
    device_id = normalizeDeviceId(req.body?.deviceId || req.body?.device_id);
    if (!pin || !device_id) return apiFail(res, 'MISSING_FIELDS', 400);

    const supabase = createAdminClientOrThrow();
    const { data: user, error: uerr } = await supabase
      .from('users')
      .select('id, pin, role, name, is_active, is_hybrid_transport')
      .eq('pin', pin)
      .maybeSingle();
    if (uerr) return apiFail(res, uerr.message, 500);
    if (!user) return apiFail(res, 'PIN GABIM OSE NUK EKZISTON', 401);
    if (user.is_active === false) return apiFail(res, 'USER_DISABLED', 403);

    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, is_approved, user_id')
      .eq('device_id', device_id)
      .maybeSingle();
    if (derr) return apiFail(res, derr.message, 500);

    const userRole = String(user.role || '').toUpperCase();
    const isAdmin = canAutoApproveDevice(userRole);
    if (requested_role && !rolesCompatible(requested_role, userRole)) return apiFail(res, 'ROLE_MISMATCH', 403);

    const requestedRoleForRow = requested_role || userRole;
    const isCurrentlyApproved = dev && dev.user_id === user.id ? !!dev.is_approved : !!isAdmin;

    const devicePayload = {
      user_id: user.id,
      device_id,
      is_approved: isCurrentlyApproved,
      requested_pin: user.pin,
      requested_role: requestedRoleForRow,
      approved_at: isCurrentlyApproved ? new Date().toISOString() : null,
      approved_by: isCurrentlyApproved ? 'SYSTEM' : null,
    };

    if (dev?.id) {
      const { error: upErr } = await supabase.from('tepiha_user_devices').update(devicePayload).eq('id', dev.id);
      if (upErr) return apiFail(res, upErr.message, 500);
    } else {
      const { error: insErr } = await supabase.from('tepiha_user_devices').insert(devicePayload);
      if (insErr) return apiFail(res, insErr.message, 500);
    }

    if (!isCurrentlyApproved) return apiFail(res, 'DEVICE_NOT_APPROVED', 403, { deviceId: device_id });

    res.cookie('tepiha_device_id', String(device_id || ''), {
      path: '/',
      maxAge: 1000 * 60 * 60 * 24 * 365,
      sameSite: 'lax',
      httpOnly: false,
    });

    return apiOk(res, {
      actor: {
        pin: user.pin,
        role: userRole,
        name: user.name || '',
        user_id: user.id,
        device_id,
        is_hybrid_transport: user.is_hybrid_transport === true,
      },
    });
  } catch (error) {
    return apiFail(res, error, 500);
  }
});

app.post('/api/runtime-incident', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    if (!body) return apiFail(res, 'INVALID_JSON', 400);
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
});

app.post('/api/public-booking', upload.none(), async (req, res) => {
  const SLOT_WINDOWS = { morning: '09:00 – 13:00', evening: '18:00 – 21:00' };
  try {
    const form = req.body || {};
    const name = cleanText(form.name);
    const phone = cleanText(form.phone);
    const address = cleanText(form.address);
    const pieces = safeNumberOrNull(form.pieces);
    const note = cleanText(form.note);
    const pickupDate = cleanText(form.pickupDate);
    const pickupSlot = cleanText(form.pickupSlot).toLowerCase();
    const pickupWindow = cleanText(form.pickupWindow) || SLOT_WINDOWS[pickupSlot] || '';
    const lat = safeNumberOrNull(form.lat);
    const lng = safeNumberOrNull(form.lng);

    if (!name || !phone || !address || !pickupDate || !pickupSlot) {
      return res.redirect(303, `/porosit?err=${encodeURIComponent('Ju lutem plotësoni fushat e detyrueshme dhe zgjidhni orarin.')}`);
    }
    if (!SLOT_WINDOWS[pickupSlot]) {
      return res.redirect(303, `/porosit?err=${encodeURIComponent('Orari i zgjedhur nuk është valid.')}`);
    }

    const admin = createAdminClientOrThrow();
    const submittedAt = new Date().toISOString();
    const rawPayload = {
      client_name: name,
      client_phone: phone,
      status: 'inbox',
      data: {
        client: {
          name,
          phone,
          address,
          gps_lat: lat,
          gps_lng: lng,
          gps: lat != null && lng != null ? { lat, lng } : null,
        },
        pieces: pieces || 0,
        note,
        source: 'facebook_web',
        created_by: 'ONLINE',
        order_origin: 'ONLINE_WEB',
        submitted_at: submittedAt,
        gps_lat: lat,
        gps_lng: lng,
        defer_dispatch_code: true,
        pickup_date: pickupDate,
        pickup_slot: pickupSlot,
        pickup_window: pickupWindow,
      },
    };
    const payload = sanitizeTransportOrderPayload(rawPayload);
    const { error } = await admin.from('transport_orders').insert(payload).select('id').maybeSingle();
    if (error) throw error;

    const nextUrl = new URL('/porosit', 'http://local');
    nextUrl.searchParams.set('ok', '1');
    nextUrl.searchParams.set('name', name);
    nextUrl.searchParams.set('phone', phone);
    nextUrl.searchParams.set('pickupDate', pickupDate);
    nextUrl.searchParams.set('pickupSlot', pickupSlot);
    nextUrl.searchParams.set('pickupWindow', pickupWindow);
    return res.redirect(303, `${nextUrl.pathname}${nextUrl.search}`);
  } catch (error) {
    console.error('public-booking failed', error);
    return res.redirect(303, `/porosit?err=${encodeURIComponent('Ndodhi një problem me serverin. Ju lutem provoni përsëri.')}`);
  }
});

app.get('/api/transport/fletore', async (req, res) => {
  try {
    const sb = createAdminClientOrThrow();
    const transportId = String(req.query.transport_id || '').trim();
    const includeAll = String(req.query.all || '').trim() === '1';

    let ordersQ = sb
      .from('transport_orders')
      .select('id,created_at,updated_at,code_str,client_id,client_tcode,client_name,client_phone,status,data,transport_id,visit_nr,ready_at')
      .order('created_at', { ascending: false })
      .limit(5000);

    if (transportId && !includeAll) ordersQ = ordersQ.eq('transport_id', transportId);

    const [ordersRes, clientsRes, users] = await Promise.all([
      ordersQ,
      sb.from('transport_clients').select('*').order('created_at', { ascending: true }).limit(5000),
      readUsers(sb),
    ]);

    if (ordersRes?.error) throw ordersRes.error;

    const rawOrders = Array.isArray(ordersRes?.data) ? ordersRes.data : [];
    const rawClients = clientsRes?.error ? [] : (Array.isArray(clientsRes?.data) ? clientsRes.data : []);
    const usersById = new Map((users || []).map((u) => [String(u?.id || '').trim(), u]));

    const clientLookup = new Map();
    for (const row of rawClients) {
      const keys = new Set();
      const tcode = String(row?.tcode || row?.code || '').trim();
      const id = String(row?.id || '').trim();
      const phone = normPhone(row?.phone);
      if (tcode) keys.add(`tcode:${tcode.toUpperCase()}`);
      if (id) keys.add(`id:${id}`);
      if (phone) keys.add(`phone:${phone}`);
      for (const key of keys) clientLookup.set(key, row);
    }

    const normalizedOrders = rawOrders.map((row) => {
      const data = orderData(row);
      const keys = extractClientKeys(row, data);
      const clientRow = keys.map((key) => clientLookup.get(key)).find(Boolean) || null;
      const transportKey = String(row?.transport_id || '').trim();
      const transportUser = usersById.get(transportKey) || null;
      const code = pickClientCode(row, data);
      return {
        ...row,
        code,
        client_name: pickClientName(row, data, clientRow),
        client_phone: pickClientPhone(row, data, clientRow),
        transport_name: normalizeName(transportUser?.name || data?.transport_name || row?.transport_name || transportKey || 'PA CAKTUAR'),
        data,
      };
    });

    const transportMap = new Map();
    for (const order of normalizedOrders) {
      const tid = String(order?.transport_id || '').trim() || 'unassigned';
      const current = transportMap.get(tid) || {
        id: tid,
        name: normalizeName(order?.transport_name || usersById.get(tid)?.name || (tid === 'unassigned' ? 'PA CAKTUAR' : tid)),
        orders: [],
      };
      current.orders.push(order);
      transportMap.set(tid, current);
    }

    const transports = Array.from(transportMap.values()).map((group) => {
      const seen = new Set();
      const clients = [];
      for (const order of group.orders) {
        const key = `${String(order?.code || '').trim()}|${normPhone(order?.client_phone)}`;
        if (!String(order?.code || '').trim() && !normPhone(order?.client_phone)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        clients.push({
          code: String(order?.code || '').trim(),
          full_name: normalizeName(order?.client_name || '-'),
          phone: String(order?.client_phone || '-').trim() || '-',
        });
      }
      group.orders.sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
      clients.sort((a, b) => String(a?.code || '').localeCompare(String(b?.code || ''), undefined, { numeric: true, sensitivity: 'base' }));
      return { ...group, clients };
    }).sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }));

    const selected = transportId && !includeAll ? transports.filter((t) => String(t?.id || '') === transportId) : transports;
    return apiOk(res, {
      generated_at: new Date().toISOString(),
      clients_warning: !!clientsRes?.error,
      clients_warning_message: clientsRes?.error ? String(clientsRes.error.message || clientsRes.error) : '',
      transports: selected,
    });
  } catch (error) {
    return apiFail(res, 'TRANSPORT_FLETORE_FAILED', 500, { detail: String(error?.message || error) });
  }
});

app.get('/api/backup/latest', (req, res) => backupLatestHandler(req, res));
app.post('/api/backup/run', (req, res) => backupRunHandler(req, res));
app.get('/api/backup/dates', (req, res) => backupDatesHandler(req, res));
app.post('/api/backup/restore', (req, res) => backupRestoreHandler(req, res));
app.get('/api/cron/backup', (req, res) => cronBackupHandler(req, res));

if (!DEV_MODE) {
  app.use(express.static(distDir, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`TEPIHA Vite server listening on :${PORT}${DEV_MODE ? ' (API DEV)' : ''}`);
});
