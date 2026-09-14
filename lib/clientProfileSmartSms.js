import { buildSmartSmsText } from './smartSms.js';

const STATUS_LABELS = Object.freeze({
  draft: 'DRAFT',
  pranim: 'PRANIM',
  pranimi: 'PRANIM',
  pending: 'NË PRITJE',
  pickup: 'PËR MARRJE',
  marrje: 'PËR MARRJE',
  assigned: 'CAKTUAR',
  caktuar: 'CAKTUAR',
  at_base: 'NË BAZË',
  in_base: 'NË BAZË',
  base: 'NË BAZË',
  ne_baze: 'NË BAZË',
  pastrim: 'NË PASTRIM',
  pastrimi: 'NË PASTRIM',
  gati: 'GATI',
  ready: 'GATI',
  dorzim: 'NË DORËZIM',
  dorezim: 'NË DORËZIM',
  delivered: 'DORËZUAR',
  done: 'PËRFUNDUAR',
  completed: 'PËRFUNDUAR',
  complete: 'PËRFUNDUAR',
  cancelled: 'ANULUAR',
  canceled: 'ANULUAR',
  anuluar: 'ANULUAR',
  archived: 'ARKIVUAR',
});

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeStatus(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_');
}

function normalizeSource(value) {
  const source = clean(value).toUpperCase();
  return source.includes('TRANSPORT') ? 'TRANSPORT' : (source.includes('BASE') || source === 'ORDERS' ? 'BASE' : '');
}

function money(value) {
  return Math.max(0, Number(value || 0)).toFixed(2);
}

export function findExactClientProfileMessageVisit(profile, anchor) {
  const orderId = clean(anchor?.orderId);
  const source = normalizeSource(anchor?.source);
  if (!orderId || !source) return null;

  const visits = Array.isArray(profile?.visits) ? profile.visits : [];
  return visits.find((visit) => (
    visit?.current === true
    && visit?.active === true
    && clean(visit?.id) === orderId
    && normalizeSource(visit?.source) === source
  )) || null;
}

export function resolveClientProfileSmartSmsAction(visit) {
  const source = normalizeSource(visit?.source);
  const status = normalizeStatus(visit?.status);

  if (source === 'BASE') {
    if (['pranim', 'pranimi', 'at_base', 'in_base', 'base', 'ne_baze', 'pastrim', 'pastrimi'].includes(status)) return 'pranimi_baze';
    if (status === 'gati' || status === 'ready') return 'gati_baze';
  }

  if (source === 'TRANSPORT') {
    if (['at_base', 'in_base', 'base', 'ne_baze', 'pastrim', 'pastrimi'].includes(status)) return 'transport_pranimi';
  }

  return '';
}

export function buildClientProfileSmartSmsOrder(profile, visit) {
  const client = profile?.client || {};
  const source = normalizeSource(visit?.source);
  const isTransport = source === 'TRANSPORT';
  const exactId = clean(visit?.id);
  const code = clean(visit?.code);

  return {
    id: exactId,
    order_id: exactId,
    ...(isTransport ? { transport_order_id: exactId } : {}),
    _table: isTransport ? 'transport_orders' : 'orders',
    status: clean(visit?.status),
    code,
    ...(isTransport ? { client_tcode: code, code_str: code } : {}),
    client_name: clean(client?.name) || 'klient',
    client_phone: clean(client?.phone),
    pieces: Math.max(0, Number(visit?.pieces || 0)),
    m2_total: Math.max(0, Number(visit?.m2 || 0)),
    price_total: Math.max(0, Number(visit?.total || 0)),
    total_euro: Math.max(0, Number(visit?.total || 0)),
    client: {
      name: clean(client?.name) || 'klient',
      phone: clean(client?.phone),
      ...(isTransport ? { tcode: code } : { code }),
    },
  };
}

function buildNeutralStatusText(profile, visit) {
  const clientName = clean(profile?.client?.name) || 'klient';
  const status = normalizeStatus(visit?.status);
  const label = STATUS_LABELS[status] || clean(visit?.status).replaceAll('_', ' ').toUpperCase() || 'I PËRDITËSUAR';
  const lines = [
    `Përshëndetje ${clientName},`,
    `Statusi aktual i tepihave të juaj është: ${label}.`,
    '',
    `KODI: ${clean(visit?.code) || '—'}`,
    `COPË: ${Math.max(0, Number(visit?.pieces || 0))}`,
    `TOTALI: ${money(visit?.total)} €`,
  ];
  if (Number(visit?.debt || 0) > 0) lines.push(`BORXHI I HAPUR: ${money(visit.debt)} €`);
  return lines.join('\n');
}

export function buildClientProfileSmartSms(profile, anchor) {
  const visit = findExactClientProfileMessageVisit(profile, anchor);
  if (!visit) {
    return Object.freeze({ ready: false, reason: 'EXACT_ACTIVE_VISIT_REQUIRED', action: '', visit: null, messageText: '' });
  }

  const order = buildClientProfileSmartSmsOrder(profile, visit);
  const action = resolveClientProfileSmartSmsAction(visit);
  if (action) {
    return Object.freeze({ ready: true, reason: '', action, visit, messageText: buildSmartSmsText(order, action) });
  }

  return Object.freeze({
    ready: true,
    reason: '',
    action: 'status_neutral',
    visit,
    messageText: buildSmartSmsText({ ...order, messageText: buildNeutralStatusText(profile, visit) }, ''),
  });
}
