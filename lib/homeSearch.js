const HOME_SEARCH_MAX_RESULTS = 24;
const HOME_SEARCH_DIAG_KEY = 'tepiha_home_search_last_v1';

function safeString(value) {
  return String(value ?? '').trim();
}

export function normalizeText(value) {
  return safeString(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePhone(value) {
  return safeString(value).replace(/[\s\-()./]/g, '').replace(/(?!^)\+/g, '');
}

export function onlyDigits(value) {
  return safeString(value).replace(/\D+/g, '');
}

export function looksUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(safeString(value));
}

export function normalizeCode(value) {
  const raw = safeString(value).replace(/^#+/, '').replace(/[\s\-_/]+/g, '').toUpperCase();
  const transportDigits = raw.replace(/^T+/, '').replace(/\D+/g, '');
  if (/^T/i.test(raw) && transportDigits) return `T${transportDigits}`;
  return raw.replace(/^#+/, '');
}

function normalizeNumericCode(value) {
  const digits = onlyDigits(value);
  if (!digits) return '';
  return digits.replace(/^0+/, '') || '0';
}

function normalizeTransportCodeStrict(value) {
  const raw = normalizeCode(value);
  const match = raw.match(/^T0*(\d+)$/i);
  if (!match) return '';
  return `T${String(match[1] || '0').replace(/^0+/, '') || '0'}`;
}

export function getHomeSearchQueryMode(query) {
  const raw = safeString(query).replace(/\s+/g, '');
  if (/^t\d+$/i.test(raw)) return 'TRANSPORT_ONLY';
  if (/^\d+$/.test(raw)) return 'BASE_ONLY';
  return 'GENERAL';
}

export function isOpaquePersonRef(value) {
  const raw = safeString(value);
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, '');

  if (looksUuid(compact)) return true;
  if (/^\d+$/.test(compact)) return true;
  if (/^(ADMIN|USER|MAIN)_[A-Z0-9_-]+$/i.test(compact)) return true;
  if (/^TRANSPORT_[0-9A-Z_-]+$/i.test(compact)) return true;
  if (/^(TRANSPORT|ADMIN|USER|PUNTOR|WORKER|STAFF|STAF)$/i.test(compact)) return true;

  return false;
}

export function cleanVisiblePersonName(value) {
  const raw = safeString(value);
  if (!raw || isOpaquePersonRef(raw)) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

function safeObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

function unwrapData(row) {
  try {
    const root = safeObject(row);
    const data = safeObject(root?.data);
    const order = safeObject(root?.order || data?.order);
    const orderData = safeObject(order?.data);
    const fullOrder = safeObject(root?.fullOrder || data?.fullOrder);
    const fullOrderData = safeObject(fullOrder?.data);
    return {
      ...root,
      ...fullOrderData,
      ...orderData,
      ...fullOrder,
      ...order,
      ...data,
      client: data?.client || order?.client || fullOrder?.client || orderData?.client || fullOrderData?.client || root?.client,
      pay: data?.pay || order?.pay || fullOrder?.pay || orderData?.pay || fullOrderData?.pay || root?.pay,
      transport: data?.transport || order?.transport || fullOrder?.transport || orderData?.transport || fullOrderData?.transport || root?.transport,
      _audit: data?._audit || order?._audit || fullOrder?._audit || orderData?._audit || fullOrderData?._audit || root?._audit,
    };
  } catch {
    return {};
  }
}

function pickFirst(...values) {
  for (const value of values) {
    const raw = safeString(value);
    if (raw) return raw;
  }
  return '';
}

function pickFirstVisiblePerson(...values) {
  for (const value of values) {
    const raw = cleanVisiblePersonName(value);
    if (raw) return raw;
  }
  return '';
}

function pickCode(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_tcode,
    row?.transport_code,
    row?.t_code,
    row?.code_str,
    row?.code,
    row?.code_n,
    row?.client_code,
    data?.client_tcode,
    data?.transport_code,
    data?.t_code,
    data?.code_str,
    data?.code,
    data?.code_n,
    data?.client_code
  );
}

function pickOrderId(row) {
  const data = unwrapData(row);
  const numericRowId = /^\d+$/.test(safeString(row?.id)) ? row?.id : '';
  const numericDataId = /^\d+$/.test(safeString(data?.id)) ? data?.id : '';
  return pickFirst(
    row?.db_id,
    data?.db_id,
    row?.order_id,
    row?.orderId,
    numericRowId,
    data?.order_id,
    data?.orderId,
    numericDataId,
    row?.id,
    data?.id
  );
}

function normalizeBaseCode(value) {
  const raw = safeString(value).replace(/^#+/, '').replace(/[\s-_/]+/g, '').toUpperCase();
  const transportAlias = raw.match(/^T0*(\d+)$/i);
  if (transportAlias) return String(transportAlias[1] || '0').replace(/^0+/, '') || '0';
  if (/^\d+$/.test(raw)) return raw.replace(/^0+/, '') || '0';
  return raw;
}

function pickBaseCode(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.code,
    row?.client_code,
    row?.saved_order_code,
    row?.final_code_lifecycle,
    data?.saved_order_code,
    data?.final_code_lifecycle,
    data?.pranimi_code_lifecycle?.final_code,
    data?.pranimi_code_lifecycle?.saved_order_code,
    data?.code,
    data?.client_code,
    row?.code_n,
    data?.code_n,
    pickCode(row)
  );
}

function pickTransportCode(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_tcode,
    row?.code_str,
    row?.transport_code,
    row?.t_code,
    data?.client_tcode,
    data?.code_str,
    data?.transport_code,
    data?.t_code,
    row?.code,
    row?.code_n,
    data?.code,
    data?.code_n
  );
}

function hasStrongBaseIdentity(row) {
  const data = unwrapData(row);
  const table = safeString(row?._table || row?.table || row?.source_table).toLowerCase();
  if (table === 'orders') return true;
  if (/^\d+$/.test(safeString(row?.id))) return true;
  if (/^\d+$/.test(safeString(row?.db_id || data?.db_id))) return true;
  if (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') return true;
  if (data?.draft_lifecycle && typeof data.draft_lifecycle === 'object') return true;
  if (data?.base_ready_bonus_v2 && typeof data.base_ready_bonus_v2 === 'object') return true;
  if (safeString(data?.saved_order_code) && safeString(data?.local_oid)) return true;
  return false;
}

function hasStrongTransportIdentity(row) {
  const data = unwrapData(row);
  const id = pickFirst(row?.id, data?.public_order_id, data?.order_id);
  const strictCode = normalizeTransportCodeStrict(pickTransportCode(row));
  const explicitTransportRef = pickFirst(
    row?.transport_id,
    row?.transport_pin,
    row?.driver_pin,
    data?.transport_id,
    data?.transport_pin,
    data?.driver_pin,
    data?.transport_user_id,
    data?.assigned_driver_id
  );
  return !!strictCode && (!!explicitTransportRef || looksUuid(id));
}

function getKind(row) {
  // HOME_SEARCH_BASE_ROLE_BOUNDARY_V1: DB/source identity and BASE lifecycle win over stale T-prefix cache aliases.
  const table = safeString(row?._table || row?.table || row?.source_table).toLowerCase();
  if (hasStrongBaseIdentity(row)) return 'BASE';
  if (table === 'transport_orders' || table === 'transport') return 'TRANSPORT';
  if (hasStrongTransportIdentity(row)) return 'TRANSPORT';
  const code = normalizeTransportCodeStrict(pickTransportCode(row));
  if (code) return 'TRANSPORT';
  return 'BASE';
}



function pickName(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_name,
    row?.customer_name,
    row?.name,
    row?.client?.name,
    data?.client?.name,
    data?.client_name,
    data?.customer_name,
    data?.name,
    'Pa emër'
  );
}

function pickPhone(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_phone,
    row?.customer_phone,
    row?.phone,
    row?.tel,
    row?.client?.phone,
    data?.client?.phone,
    data?.client_phone,
    data?.customer_phone,
    data?.phone,
    data?.tel
  );
}

function pickAddress(row) {
  const data = unwrapData(row);
  return pickFirst(row?.address, row?.pickup_address, data?.address, data?.pickup_address);
}

function pickStatus(row) {
  const data = unwrapData(row);
  return pickFirst(row?.status, data?.status, row?.state, data?.state);
}

// PAYMENT_RECEIPT_SMS_SEARCH_V2
function pickPaymentNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const parsed = Number(String(value).replace(',', '.').replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(parsed)) return Math.max(0, +parsed.toFixed(2));
  }
  return 0;
}

function pickPaymentReceipt(row) {
  const data = unwrapData(row);
  const pay = safeObject(data?.pay || row?.pay);
  const total = pickPaymentNumber(row?.total, row?.total_amount, row?.amount, data?.total, data?.total_amount, data?.amount, pay?.total, pay?.total_amount);
  const paid = pickPaymentNumber(row?.last_payment_amount, data?.last_payment_amount, pay?.last_payment_amount, row?.paid_amount, row?.amount_paid, row?.paid_total, row?.paid, data?.paid_amount, data?.amount_paid, data?.paid_total, data?.paid, pay?.paid_amount, pay?.amount_paid, pay?.paid_total, pay?.paid);
  const explicitDebt = pickPaymentNumber(row?.balance, row?.remaining, row?.debt, row?.borxh, data?.balance, data?.remaining, data?.debt, data?.borxh, pay?.balance, pay?.remaining, pay?.debt, pay?.borxh);
  const balance = explicitDebt > 0 ? explicitDebt : Math.max(0, +(total - paid).toFixed(2));
  const date = pickFirst(row?.last_payment_at, data?.last_payment_at, pay?.last_payment_at, row?.paid_at, data?.paid_at, pay?.paid_at, row?.delivered_at, data?.delivered_at, row?.updated_at, data?.updated_at);
  return { total, paid, balance, date };
}

function pickCreatedBy(row) {
  const data = unwrapData(row);
  return pickFirstVisiblePerson(
    row?.created_by_name,
    row?.createdBy,
    data?._audit?.created_by_name,
    data?.created_by_name,
    data?.createdBy
  );
}

function pickTransporter(row) {
  const data = unwrapData(row);
  return pickFirstVisiblePerson(
    row?.brought_by_name,
    row?.transport_name,
    row?.driver_name,
    row?.transporter_name,
    row?.brought_by,
    row?.created_by_name,
    row?.actor,
    data?.brought_by_name,
    data?.transport_name,
    data?.driver_name,
    data?.transporter_name,
    data?.brought_by,
    data?.created_by_name,
    data?.actor,
    data?._audit?.created_by_name,
    data?.transport?.brought_by_name,
    data?.transport?.name,
    data?.transport?.driver_name,
    data?.transport?.driverName,
    data?.transport?.assigned_driver_name,
    data?.transport?.brought_by
  );
}

function pickExplicitBaseTransporter(row) {
  const data = unwrapData(row);
  const role = safeString(pickFirst(
    row?.transport_role,
    row?.driver_role,
    data?.transport_role,
    data?.driver_role,
    data?.created_by_role
  )).toUpperCase();
  const explicitRef = pickFirst(
    row?.transport_pin,
    row?.driver_pin,
    row?.transport_id,
    data?.transport_pin,
    data?.driver_pin,
    data?.transport_id,
    data?.transport_user_id,
    data?.assigned_driver_id
  );
  const explicitName = pickFirstVisiblePerson(
    row?.brought_by_name,
    row?.transport_name,
    row?.driver_name,
    row?.transporter_name,
    data?.brought_by_name,
    data?.transport_name,
    data?.driver_name,
    data?.transporter_name,
    data?.transport?.brought_by_name,
    data?.transport?.name,
    data?.transport?.driver_name
  );
  if (!explicitName) return '';
  if (explicitRef || ['TRANSPORT', 'DRIVER', 'SHOFER'].includes(role)) return explicitName;
  return '';
}

function collectTransportPersonRefs(row) {
  const data = unwrapData(row);
  const transport = safeObject(data?.transport);
  const refs = [
    row?.transport_id,
    data?.transport_id,
    data?.transportId,
    transport?.transport_id,
    transport?.transportId,
    row?.user_id,
    data?.user_id,
    transport?.user_id,
    row?.driver_id,
    data?.driver_id,
    transport?.driver_id,
    row?.assigned_driver_id,
    data?.assigned_driver_id,
    transport?.assigned_driver_id,
    row?.created_by,
    data?.created_by,
    row?.created_by_pin,
    data?.created_by_pin,
    row?.transport_pin,
    data?.transport_pin,
    transport?.pin,
    transport?.transport_pin,
    row?.driver_pin,
    data?.driver_pin,
    transport?.driver_pin,
  ];

  const out = [];
  const seen = new Set();
  for (const value of refs) {
    const raw = safeString(value);
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function addUserResolverEntry(map, user) {
  if (!map || !user || typeof user !== 'object') return;
  const name = cleanVisiblePersonName(user?.name || user?.transport_name || user?.display || user?.username);
  if (!name) return;
  const keys = [
    user?.id,
    user?.user_id,
    user?.transport_id,
    user?.pin,
    user?.transport_pin,
    user?.driver_pin,
  ];
  for (const key of keys) {
    const raw = safeString(key);
    if (raw) map.set(raw, name);
  }
}

function readCachedUserResolver() {
  const map = new Map();
  if (typeof window === 'undefined') return map;

  const parse = (key) => {
    try {
      const raw = window.localStorage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const pushActorLike = (value) => {
    if (!value || typeof value !== 'object') return;
    addUserResolverEntry(map, value);
    addUserResolverEntry(map, value?.actor);
    addUserResolverEntry(map, value?.user);
    addUserResolverEntry(map, value?.transport);
  };

  pushActorLike(parse('CURRENT_USER_DATA'));
  pushActorLike(parse('tepiha_session_v1'));
  pushActorLike(parse('tepiha_transport_session_v1'));
  pushActorLike(parse('tepiha_user'));
  pushActorLike(parse('user'));
  pushActorLike(parse('tepiha_actor'));
  pushActorLike(parse('actor'));
  pushActorLike(parse('transport_actor'));

  const approvals = parse('tepiha_device_approvals_v1');
  try {
    const byPin = approvals?.byPin && typeof approvals.byPin === 'object' ? approvals.byPin : {};
    for (const [pin, roles] of Object.entries(byPin)) {
      if (!roles || typeof roles !== 'object') continue;
      for (const rec of Object.values(roles)) {
        const actor = rec?.actor;
        if (actor && typeof actor === 'object') {
          addUserResolverEntry(map, { ...actor, pin: actor?.pin || pin });
        }
      }
    }
  } catch {}

  return map;
}

function resolverHasMissingRefs(rows, resolver) {
  for (const row of rows) {
    if (getKind(row) !== 'TRANSPORT') continue;
    if (pickTransporter(row)) continue;
    const refs = collectTransportPersonRefs(row);
    if (refs.some((ref) => !resolver.get(ref))) return true;
  }
  return false;
}

async function buildHomeUserResolver(rows) {
  const resolver = readCachedUserResolver();
  const transportRows = (Array.isArray(rows) ? rows : []).filter((row) => getKind(row) === 'TRANSPORT');
  if (!transportRows.length || !resolverHasMissingRefs(transportRows, resolver)) return resolver;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return resolver;

  try {
    const mod = await import('@/lib/usersDb');
    if (typeof mod?.listUsers !== 'function') return resolver;
    const res = await mod.listUsers({ includeInactive: true });
    const users = Array.isArray(res?.items) ? res.items : [];
    for (const user of users) addUserResolverEntry(resolver, user);
  } catch {}

  return resolver;
}

function resolveTransporterName(row, resolver) {
  const direct = pickTransporter(row);
  if (direct) return direct;
  for (const ref of collectTransportPersonRefs(row)) {
    const name = cleanVisiblePersonName(resolver?.get?.(ref));
    if (name) return name;
  }
  return '';
}

function computePieces(row) {
  const data = unwrapData(row);
  const direct = Number(
    row?.pieces
    || row?.cope
    || data?.pieces
    || data?.cope
    || data?.totals?.pieces
    || data?.pay?.pieces
    || 0
  ) || 0;
  if (direct > 0) return direct;
  const tepiha = Array.isArray(data?.tepiha) ? data.tepiha : (Array.isArray(data?.tepihaRows) ? data.tepihaRows : []);
  const staza = Array.isArray(data?.staza) ? data.staza : (Array.isArray(data?.stazaRows) ? data.stazaRows : []);
  const countRows = (rows) => rows.reduce((sum, item) => sum + (Number(item?.qty ?? item?.pieces ?? item?.cope ?? 1) || 0), 0);
  const stairsQty = Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0;
  return countRows(tepiha) + countRows(staza) + stairsQty;
}

function formatMeasureValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  return String(Math.round(num * 100) / 100).replace(/\.0+$/, '').trim();
}

function extractMeasurementChips(row) {
  const chips = [];
  const groupSignatures = new Set();
  const pushValue = (value, qty = 1) => {
    const label = formatMeasureValue(value);
    if (!label) return;
    const count = Math.max(1, Math.min(Number(qty) || 1, 80));
    for (let index = 0; index < count; index += 1) chips.push(label);
  };
  const pushRowsOnce = (rows) => {
    if (!Array.isArray(rows) || !rows.length) return;
    const signature = JSON.stringify(rows.map((item) => item && typeof item === 'object'
      ? [formatMeasureValue(item?.m2 ?? item?.meter ?? item?.measurement ?? item?.value), Number(item?.qty ?? item?.pieces ?? item?.cope ?? 1) || 1]
      : [formatMeasureValue(item), 1]));
    if (groupSignatures.has(signature)) return;
    groupSignatures.add(signature);
    for (const item of rows) {
      if (item && typeof item === 'object') {
        pushValue(item?.m2 ?? item?.meter ?? item?.measurement ?? item?.value, item?.qty ?? item?.pieces ?? item?.cope ?? 1);
      } else {
        pushValue(item, 1);
      }
    }
  };

  try {
    const data = unwrapData(row);
    pushRowsOnce(data?.tepiha);
    pushRowsOnce(data?.tepihaRows);
    pushRowsOnce(data?.staza);
    pushRowsOnce(data?.stazaRows);
    pushRowsOnce(data?.m2_list);
    pushRowsOnce(data?.m2s);
    pushRowsOnce(data?.measurements);
    const stairsQty = Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0;
    const stairsPer = Number(data?.shkallore?.per ?? data?.stairsPer ?? 0) || 0;
    if (stairsQty > 0 && stairsPer > 0) pushValue(stairsPer, stairsQty);
  } catch {}

  return chips.filter(Boolean);
}

function normalizeResult(row, options = {}) {
  const kind = getKind(row);
  const data = unwrapData(row);
  const rawCode = kind === 'TRANSPORT' ? pickTransportCode(row) : pickBaseCode(row);
  const code = kind === 'TRANSPORT'
    ? (normalizeTransportCodeStrict(rawCode) || normalizeCode(rawCode))
    : normalizeBaseCode(rawCode);
  const orderId = kind === 'BASE' ? pickOrderId(row) : '';
  const transporter = kind === 'TRANSPORT'
    ? resolveTransporterName(row, options?.userResolver)
    : pickExplicitBaseTransporter(row);
  const cleanTransporter = cleanVisiblePersonName(transporter);
  const paymentReceipt = pickPaymentReceipt(row);
  return {
    kind,
    id: row?.id ?? row?.local_oid ?? row?.transport_id ?? null,
    orderId: kind === 'BASE' ? (orderId || null) : null,
    localOid: pickFirst(row?.local_oid, data?.local_oid) || null,
    clientId: row?.client_id ?? row?.clientId ?? data?.client_id ?? data?.clientId ?? null,
    code,
    clientCode: kind === 'BASE' ? code : null,
    status: pickStatus(row),
    name: pickName(row),
    phone: pickPhone(row),
    paidAmount: paymentReceipt.paid,
    balanceAmount: paymentReceipt.balance,
    paymentDate: paymentReceipt.date,
    address: pickAddress(row),
    pieces: computePieces(row),
    createdBy: pickCreatedBy(row),
    transporter: cleanTransporter,
    broughtBy: kind === 'TRANSPORT' ? (cleanTransporter || 'PA EMËR NË CACHE') : '',
    measurements: extractMeasurementChips(row),
    updatedAt: pickFirst(row?.updated_at, data?.updated_at, row?.ready_at, data?.ready_at, row?.delivered_at, data?.delivered_at, row?.created_at, data?.created_at),
    createdAt: pickFirst(row?.created_at, data?.created_at),
    deliveredAt: pickFirst(row?.delivered_at, data?.delivered_at),
    pickedUpAt: pickFirst(row?.picked_up_at, data?.picked_up_at),
    homeSearchSource: pickFirst(row?._homeSearchSource, row?._snapshot ? 'snapshot:' + row._snapshot : '', row?._table),
    sourceRank: computeHomeSearchSourceRank(row),
    classificationVersion: 'HOME_SEARCH_BASE_ROLE_BOUNDARY_V1',
  };
}

export function classifyHomeSearchRow(row) {
  return getKind(row);
}

export function normalizeHomeSearchRow(row, options = {}) {
  return normalizeResult(row, options);
}

function rowMatches(row, query, mode = getHomeSearchQueryMode(query)) {
  const qText = normalizeText(query);
  const qDigits = normalizeNumericCode(query);
  const qCode = normalizeCode(query);
  if (!qText && !qDigits && !qCode) return false;

  const result = normalizeResult(row);
  const kind = safeString(result.kind).toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  const code = normalizeCode(result.code);
  const orderIdDigits = kind === 'BASE' ? normalizeNumericCode(result.orderId || result.id) : '';

  if (mode === 'BASE_ONLY') {
    if (kind !== 'BASE') return false;
    if (/^T\d+$/i.test(code)) return false;
    return !!qDigits && (normalizeNumericCode(code) === qDigits || orderIdDigits === qDigits);
  }

  if (mode === 'TRANSPORT_ONLY') {
    if (kind !== 'TRANSPORT') return false;
    const wanted = normalizeTransportCodeStrict(qCode);
    const actual = normalizeTransportCodeStrict(code);
    return !!wanted && !!actual && actual === wanted;
  }

  const name = normalizeText(result.name);
  const phone = normalizePhone(result.phone);
  const phoneDigits = onlyDigits(result.phone);
  const address = normalizeText(result.address);
  const rawCode = normalizeText(result.code);

  if (qCode && code && code === qCode) return true;
  if (qDigits && orderIdDigits && orderIdDigits === qDigits) return true;
  if (qCode && code && code.includes(qCode)) return true;
  if (qText && rawCode && rawCode.includes(qText)) return true;
  if (qText && name && name.includes(qText)) return true;
  if (qText && address && address.includes(qText)) return true;
  if (qDigits && phoneDigits && phoneDigits.includes(qDigits)) return true;
  if (qDigits && phoneDigits && qDigits.length >= 6 && phoneDigits.endsWith(qDigits.slice(-6))) return true;
  if (qText && phone && normalizeText(phone).includes(qText)) return true;
  return false;
}

function normalizeHomeStatus(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

function getHomeStatusRank(value) {
  const status = normalizeHomeStatus(value);
  if (status === 'pastrim' || status === 'pastrimi') return 50;
  if (status === 'gati') return 45;
  if (['marrje', 'transport', 'ngarkim', 'pickup', 'pickedup', 'neproces', 'inprocess'].includes(status)) return 40;
  if (status === 'pranim' || status === 'pranimi') return 30;
  if (['dorzim', 'dorezim', 'dorzuar', 'dorezuar', 'delivered', 'delivery', 'completed', 'kompletuar'].includes(status)) return 10;
  return 0;
}

function computeHomeSearchSourceRank(row) {
  const explicit = Number(row?._homeSearchSourceRank ?? row?._sourceRank ?? row?.sourceRank);
  if (Number.isFinite(explicit)) return explicit;

  const sourceText = normalizeText(pickFirst(
    row?._homeSearchSource,
    row?._snapshot ? `snapshot:${row._snapshot}` : '',
    row?.source_kind,
    row?.source?.kind,
    row?.source?.name,
    row?.source,
    row?._table,
    row?.table
  ));

  if (sourceText.includes('local delivered') || sourceText.includes('delivered shadow') || sourceText.includes('tepiha delivered')) return 60;
  if (sourceText.includes('base master')) return 55;
  if (sourceText.includes('indexeddb') || sourceText.includes('idb') || row?.source?.idb) return 50;
  if (row?.source?.cache && String(row?._table || row?.table || '').toLowerCase() === 'orders') return 55;
  if (sourceText.includes('localstorage') || sourceText.includes('local storage')) return 35;
  if (sourceText.includes('snapshot')) return 10;
  return 20;
}

function getHomeResultTimestamp(item) {
  const times = [
    item?.deliveredAt,
    item?.pickedUpAt,
    item?.updatedAt,
    item?.createdAt,
  ].map((value) => Date.parse(value || 0) || 0);
  return Math.max(...times, 0);
}

function getHomeDedupeKey(item) {
  const kind = String(item?.kind || '').toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  // HOME_SEARCH_LOCAL_OID_DEDUPE_V1: DB, IndexedDB, snapshots and localStorage can describe the same
  // BASE order with different row IDs. local_oid is the shared write identity and
  // must win before server id, otherwise one physical order appears twice.
  const localOid = kind === 'BASE'
    ? safeString(item?.localOid || item?.local_oid).toLowerCase()
    : '';
  if (localOid) return [kind, 'LOCAL_OID', localOid].join('|');
  const stableId = kind === 'BASE'
    ? safeString(item?.orderId || item?.id)
    : safeString(item?.id);
  if (stableId) return [kind, 'ID', stableId].join('|');
  const strictCode = kind === 'TRANSPORT'
    ? normalizeTransportCodeStrict(item?.code)
    : normalizeNumericCode(item?.code);
  return strictCode
    ? [kind, 'CODE', strictCode].join('|')
    : [kind, normalizePhone(item.phone || ''), normalizeText(item.name || '')].join('|');
}

function compareHomeSearchResultStrength(candidate, current) {
  const candidateSourceRank = Number(candidate?.sourceRank || 0) || 0;
  const currentSourceRank = Number(current?.sourceRank || 0) || 0;

  // DB exact matches are the source of truth. Without this, a stale local/cache
  // row marked PASTRIM can beat the fresh DB row marked GATI/DORZIM because the
  // old ranking preferred active cleaning statuses.
  if (Math.max(candidateSourceRank, currentSourceRank) >= 90 && candidateSourceRank !== currentSourceRank) {
    return candidateSourceRank - currentSourceRank;
  }

  const candidateTime = getHomeResultTimestamp(candidate);
  const currentTime = getHomeResultTimestamp(current);
  if (candidateTime !== currentTime) return candidateTime - currentTime;

  const candidateStatusRank = getHomeStatusRank(candidate?.status);
  const currentStatusRank = getHomeStatusRank(current?.status);
  if (candidateStatusRank !== currentStatusRank) return candidateStatusRank - currentStatusRank;

  if (candidateSourceRank !== currentSourceRank) return candidateSourceRank - currentSourceRank;

  return 0;
}

function dedupeResults(results) {
  const order = [];
  const bestByKey = new Map();

  for (const item of results) {
    const key = getHomeDedupeKey(item);
    if (!key) continue;

    const current = bestByKey.get(key);
    if (!current) {
      order.push(key);
      bestByKey.set(key, item);
      continue;
    }

    if (compareHomeSearchResultStrength(item, current) > 0) {
      bestByKey.set(key, item);
    }
  }

  return order
    .map((key) => bestByKey.get(key))
    .filter(Boolean)
    .sort((a, b) => compareHomeSearchResultStrength(b, a))
    .slice(0, HOME_SEARCH_MAX_RESULTS);
}

async function getRowsFromSnapshots() {
  try {
    const { readPageSnapshot } = await import('@/lib/pageSnapshotCache');
    const pages = ['marrje-sot', 'gati', 'pastrimi', 'pranimi'];
    return pages.flatMap((page) => {
      try {
        const snap = readPageSnapshot(page);
        return (Array.isArray(snap?.rows) ? snap.rows : []).map((row) => ({
          ...row,
          _snapshot: page,
          _table: row?._table || 'orders',
          _homeSearchSource: `snapshot:${page}`,
          _homeSearchSourceRank: 10,
        }));
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function getRowsFromIndexedDb() {
  try {
    const { getAllFromStore } = await import('@/lib/localDb');
    const [baseRows, transportRows] = await Promise.all([
      getAllFromStore('orders').catch(() => []),
      getAllFromStore('transport_orders').catch(() => []),
    ]);
    return [
      ...(Array.isArray(baseRows) ? baseRows.map((row) => ({ ...row, _table: 'orders', _homeSearchSource: 'indexeddb:orders', _homeSearchSourceRank: 50 })) : []),
      ...(Array.isArray(transportRows) ? transportRows.map((row) => ({ ...row, _table: 'transport_orders', _homeSearchSource: 'indexeddb:transport_orders', _homeSearchSourceRank: 50 })) : []),
    ];
  } catch {
    return [];
  }
}

function readLocalStorageRows() {
  if (typeof window === 'undefined') return [];
  const keys = [
    'tepiha_local_orders_v1',
    'orders_v1',
    'tepiha_orders_v1',
    'transport_orders_v1',
    'tepiha_transport_orders_v1',
  ];
  const rows = [];
  for (const key of keys) {
    try {
      const raw = window.localStorage?.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed?.rows) ? parsed.rows : []));
      const isTransport = key.toLowerCase().includes('transport');
      for (const row of arr) rows.push({
        ...row,
        _table: row?._table || (isTransport ? 'transport_orders' : 'orders'),
        _homeSearchSource: `localStorage:${key}`,
        _homeSearchSourceRank: 35,
      });
    } catch {}
  }

  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!String(key || '').startsWith('tepiha_delivered_')) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        rows.push({
          ...parsed,
          _table: 'orders',
          _homeSearchSource: `local-delivered-shadow:${key}`,
          _homeSearchSourceRank: 60,
        });
      }
    }
  } catch {}

  return rows;
}


async function getRowsFromBaseMasterCache() {
  try {
    const { readBaseMasterCache } = await import('@/lib/baseMasterCache');
    const cache = readBaseMasterCache();
    const rows = Array.isArray(cache?.rows) ? cache.rows : [];
    return rows.map((row) => ({
      ...row,
      _table: row?._table || row?.table || 'orders',
      _homeSearchSource: 'base-master-cache',
      _homeSearchSourceRank: 55,
    }));
  } catch {
    return [];
  }
}

// SEARCH_OPEN_DB_TRUTH_V2: every BASE route carries both DB id and client code fallback.
export function buildHomeSearchHref(result) {
  // HOME_SEARCH_BASE_TRANSPORT_BOUNDARY_V2
  // Plain numeric codes (e.g. 915) belong to BASE. Transport requires an
  // explicit T-code or UUID id. Numeric BASE ids must never reach UUID routes.
  const claimedKind = safeString(result?.kind).toUpperCase();
  const code = safeString(result?.code);
  const id = result?.orderId != null ? safeString(result.orderId) : (result?.id != null ? safeString(result.id) : '');
  const normalizedCode = normalizeCode(code);
  const strictTransportCode = normalizeTransportCodeStrict(normalizedCode);
  const transportId = looksUuid(id) ? id : '';
  const numericBaseCode = /^\d+$/.test(code.replace(/^#+/, '').trim());
  const kind = numericBaseCode
    ? 'BASE'
    : (claimedKind === 'TRANSPORT' && (transportId || strictTransportCode) ? 'TRANSPORT' : 'BASE');
  const status = normalizeText(result?.status);
  if (kind === 'TRANSPORT') {
    if (transportId) return `/transport/item?id=${encodeURIComponent(transportId)}&src=transport&from=home_inline_search`;
    if (strictTransportCode) return `/transport/item?code=${encodeURIComponent(strictTransportCode)}&from=home_inline_search`;
    return '/transport';
  }
  const route = status === 'gati'
    ? '/gati'
    : (['dorzim', 'dorezim', 'dorzuar', 'dorezuar', 'delivered', 'delivery', 'marrje', 'completed', 'kompletuar'].includes(status))
      ? '/marrje-sot'
      : '/pastrimi';
  const params = new URLSearchParams();
  if (code) params.set('q', code);
  if (code) params.set('openCode', code);
  if (id) params.set('openId', id);
  if (code || id) params.set('exact', '1');
  params.set('from', 'home_inline_search');
  return `${route}?${params.toString()}`;
}

async function runHomeExactDbQuery(factory, { attempts = 2, timeoutMs = 7000, label = 'HOME_SEARCH_EXACT_DB_TIMEOUT' } = {}) {
  // HOME_SEARCH_EXACT_DB_TRUTH_V3
  let lastError = null;
  const count = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= count; attempt += 1) {
    try {
      let request = factory();
      if (typeof request?.timeout === 'function') {
        request = request.timeout(attempt === 1 ? timeoutMs : Math.max(timeoutMs, 12000), label);
      }
      const response = await request;
      if (response?.error) throw response.error;
      return response?.data;
    } catch (error) {
      lastError = error;
      if (attempt < count) await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
    }
  }
  throw lastError || new Error(label);
}

async function getRowsFromDbExact(query, mode = getHomeSearchQueryMode(query)) {
  const qDigits = normalizeNumericCode(query);
  const qTransport = normalizeTransportCodeStrict(normalizeCode(query));
  if (!qDigits && !qTransport) return [];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return [];

  // HOME_SEARCH_BOUNDARY_COMPAT: if (id && (kind === 'BASE' || looksUuid(id)))
  try {
    const { supabase } = await import('@/lib/supabaseClient');
    const rows = [];

    if (mode !== 'TRANSPORT_ONLY' && qDigits) {
      const codeNumber = Number(qDigits);
      if (Number.isFinite(codeNumber)) {
        let data = null;
        let rpcError = null;
        try {
          data = await runHomeExactDbQuery(
            () => supabase.rpc('find_base_order_by_code_fast', { p_code: codeNumber }),
            { attempts: 2, timeoutMs: 6500, label: 'HOME_SEARCH_BASE_CODE_RPC_TIMEOUT' },
          );
        } catch (error) {
          rpcError = error;
        }

        // Compact indexed fallback keeps exact code search alive if an older client
        // hits a transient RPC/network edge. Do not fetch the large data JSON here.
        if (!Array.isArray(data)) {
          try {
            data = await runHomeExactDbQuery(
              () => supabase
                .from('orders')
                .select('id,local_oid,code,client_code,client_id,client_name,client_phone,status,pieces,m2_total,total,paid,ready_at,delivered_at,created_at,updated_at')
                .eq('code', codeNumber)
                .order('updated_at', { ascending: false })
                .limit(12),
              { attempts: 2, timeoutMs: 7500, label: 'HOME_SEARCH_BASE_CODE_FALLBACK_TIMEOUT' },
            );
          } catch (fallbackError) {
            try {
              console.warn('HOME_SEARCH_EXACT_BASE_DB_FAILED', {
                code: codeNumber,
                rpc: String(rpcError?.message || rpcError || ''),
                fallback: String(fallbackError?.message || fallbackError || ''),
              });
            } catch {}
            data = [];
          }
        }

        if (Array.isArray(data)) {
          rows.push(...data.map((row) => ({
            ...row,
            _table: 'orders',
            _homeSearchSource: 'db-exact-orders-fast',
            _homeSearchSourceRank: 120,
          })));
        }
      }
    }

    if (mode !== 'BASE_ONLY' && qTransport) {
      const codeNumber = Number(qTransport.replace(/\D+/g, ''));
      if (Number.isFinite(codeNumber)) {
        const { data, error } = await supabase
          .from('transport_orders')
          .select('id,code_n,code_str,client_name,client_phone,status,data,created_at,updated_at')
          .eq('code_n', codeNumber)
          .limit(10);

        if (!error && Array.isArray(data)) {
          rows.push(...data.map((row) => ({
            ...row,
            _table: 'transport_orders',
            _homeSearchSource: 'db-exact-transport-orders',
            _homeSearchSourceRank: 100,
          })));
        }
      }
    }

    return rows;
  } catch {
    return [];
  }
}


// HOME_SEARCH_SOLID_V1:SEARCH — online name/phone search must use shared DB truth, not device cache.
async function getRowsFromDbGeneral(query, mode = getHomeSearchQueryMode(query)) {
  if (mode !== 'GENERAL') return [];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return [];
  const raw = safeString(query);
  const text = normalizeText(raw);
  const digits = onlyDigits(raw);
  if (!text && !digits) return [];

  try {
    const { supabase } = await import('@/lib/supabaseClient');
    const rows = [];
    const clientIds = new Set();
    const clientCodes = new Set();

    const collectClients = (items = []) => {
      for (const client of Array.isArray(items) ? items : []) {
        if (client?.id) clientIds.add(String(client.id));
        const code = Number(client?.code);
        if (Number.isFinite(code) && code > 0) clientCodes.add(code);
      }
    };

    const clientQueries = [];
    if (digits.length >= 5) {
      const suffix = digits.slice(-8);
      clientQueries.push(
        supabase.from('clients').select('id,code,full_name,first_name,last_name,phone,updated_at').ilike('phone', '%' + suffix + '%').limit(30)
      );
    }
    if (text.length >= 2 && !/^\d+$/.test(raw.replace(/\s+/g, ''))) {
      clientQueries.push(
        supabase.from('clients').select('id,code,full_name,first_name,last_name,phone,updated_at').ilike('full_name', '%' + raw + '%').limit(30)
      );
    }
    const clientResponses = await Promise.all(clientQueries.map((promise) => promise.catch(() => ({ data: [], error: null }))));
    clientResponses.forEach((res) => { if (!res?.error) collectClients(res?.data); });

    const orderQueries = [];
    if (digits.length >= 5) {
      const suffix = digits.slice(-8);
      orderQueries.push(
        supabase.from('orders').select('id,local_oid,code,client_id,client_name,client_phone,status,data,created_at,updated_at').ilike('client_phone', '%' + suffix + '%').order('updated_at', { ascending: false }).limit(40)
      );
      orderQueries.push(
        supabase.from('transport_orders').select('id,code_n,code_str,client_tcode,client_name,client_phone,status,data,created_at,updated_at').ilike('client_phone', '%' + suffix + '%').order('updated_at', { ascending: false }).limit(40)
      );
    }
    if (text.length >= 2 && !/^\d+$/.test(raw.replace(/\s+/g, ''))) {
      orderQueries.push(
        supabase.from('orders').select('id,local_oid,code,client_id,client_name,client_phone,status,data,created_at,updated_at').ilike('client_name', '%' + raw + '%').order('updated_at', { ascending: false }).limit(40)
      );
      orderQueries.push(
        supabase.from('transport_orders').select('id,code_n,code_str,client_tcode,client_name,client_phone,status,data,created_at,updated_at').ilike('client_name', '%' + raw + '%').order('updated_at', { ascending: false }).limit(40)
      );
    }
    if (clientIds.size) {
      orderQueries.push(
        supabase.from('orders').select('id,local_oid,code,client_id,client_name,client_phone,status,data,created_at,updated_at').in('client_id', Array.from(clientIds)).order('updated_at', { ascending: false }).limit(60)
      );
    }
    if (clientCodes.size) {
      orderQueries.push(
        supabase.from('orders').select('id,local_oid,code,client_id,client_name,client_phone,status,data,created_at,updated_at').in('code', Array.from(clientCodes)).order('updated_at', { ascending: false }).limit(60)
      );
    }

    const responses = await Promise.all(orderQueries.map((promise) => promise.catch(() => ({ data: [], error: null }))));
    responses.forEach((res) => {
      if (res?.error || !Array.isArray(res?.data)) return;
      for (const row of res.data) {
        const transport = row?.code_str !== undefined || row?.client_tcode !== undefined || row?.code_n !== undefined;
        rows.push({
          ...row,
          _table: transport ? 'transport_orders' : 'orders',
          _homeSearchSource: transport ? 'db-general-transport-orders' : 'db-general-orders',
          _homeSearchSourceRank: 95,
        });
      }
    });
    return rows;
  } catch {
    return [];
  }
}

function normalizeResolvedDbRow(row, table) {
  if (!row || typeof row !== 'object') return null;
  return normalizeResult({
    ...row,
    _table: table,
    _homeSearchSource: 'db-click-resolve:' + table,
    _homeSearchSourceRank: 110,
  });
}

export async function resolveHomeSearchTarget(result, options = {}) {
  // HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4
  // The exact text typed by the worker is the identity boundary. Plain digits
  // always mean BASE; only an explicit T-code means Transport. Result/cache
  // metadata cannot override that boundary.
  const searchQuery = safeString(options?.query || '');
  const queryMode = getHomeSearchQueryMode(searchQuery);
  const queryBaseCode = queryMode === 'BASE_ONLY' ? normalizeNumericCode(searchQuery) : '';
  const queryTransportCode = queryMode === 'TRANSPORT_ONLY'
    ? normalizeTransportCodeStrict(searchQuery)
    : '';

  const authoritativeResult = queryBaseCode
    ? { ...(result || {}), kind: 'BASE', code: queryBaseCode, clientCode: queryBaseCode }
    : queryTransportCode
      ? { ...(result || {}), kind: 'TRANSPORT', code: queryTransportCode }
      : (result || {});

  const fallbackHref = buildHomeSearchHref(authoritativeResult);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  if (!online) return { href: fallbackHref, result: authoritativeResult, resolved: false, source: 'offline-fallback' };

  const claimedKind = safeString(authoritativeResult?.kind).toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  const id = safeString(authoritativeResult?.orderId || authoritativeResult?.id);
  const localOid = safeString(authoritativeResult?.localOid || authoritativeResult?.local_oid);
  const resultCode = safeString(authoritativeResult?.code);
  const code = queryBaseCode || queryTransportCode || resultCode;
  const normalizedCode = normalizeCode(code);
  const strictTransportCode = normalizeTransportCodeStrict(normalizedCode);
  const numericBaseCode = /^\d+$/.test(code.replace(/^#+/, '').trim());
  const kind = queryBaseCode
    ? 'BASE'
    : queryTransportCode
      ? 'TRANSPORT'
      : numericBaseCode
        ? 'BASE'
        : (claimedKind === 'TRANSPORT' && (looksUuid(id) || strictTransportCode) ? 'TRANSPORT' : 'BASE');
  const table = kind === 'TRANSPORT' ? 'transport_orders' : 'orders';

  try {
    const { supabase } = await import('@/lib/supabaseClient');
    let row = null;

    // For a typed BASE code, a numeric BASE id is safe and exact. A UUID/id from
    // contaminated Transport cache is ignored and the BASE code is resolved.
    if (kind === 'BASE' && id && /^\d+$/.test(id)) {
      const byId = await supabase.from('orders').select('*').eq('id', Number(id)).limit(1).maybeSingle();
      if (!byId?.error && byId?.data) row = byId.data;
    }

    if (!row && kind === 'BASE' && queryBaseCode) {
      const byTypedCode = await supabase
        .from('orders')
        .select('*')
        .eq('code', Number(queryBaseCode))
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!byTypedCode?.error && byTypedCode?.data) row = byTypedCode.data;
    }

    if (!row && kind === 'TRANSPORT' && looksUuid(id)) {
      const byId = await supabase.from('transport_orders').select('*').eq('id', id).limit(1).maybeSingle();
      if (!byId?.error && byId?.data) row = byId.data;
    }

    if (!row && kind === 'BASE' && localOid) {
      const byLocal = await supabase.from('orders').select('*').eq('local_oid', localOid).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (!byLocal?.error && byLocal?.data) row = byLocal.data;
    }

    if (!row && code) {
      if (kind === 'BASE' && /^\d+$/.test(code)) {
        const byCode = await supabase.from('orders').select('*').eq('code', Number(code)).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        if (!byCode?.error && byCode?.data) row = byCode.data;
      } else if (kind === 'TRANSPORT' && strictTransportCode) {
        const codeNumber = Number(strictTransportCode.replace(/\D+/g, ''));
        if (Number.isFinite(codeNumber)) {
          const byCode = await supabase.from('transport_orders').select('*').eq('code_n', codeNumber).order('updated_at', { ascending: false }).limit(1).maybeSingle();
          if (!byCode?.error && byCode?.data) row = byCode.data;
        }
      }
    }

    const resolvedResult = normalizeResolvedDbRow(row, table);
    const finalResult = resolvedResult || authoritativeResult;
    const href = buildHomeSearchHref(finalResult);
    writeHomeSearchDiagnostics({
      event: 'result_click_resolve',
      query: searchQuery,
      queryMode,
      queryAuthority: queryBaseCode ? 'BASE_CODE' : queryTransportCode ? 'TRANSPORT_TCODE' : 'RESULT_METADATA',
      selectedKind: kind,
      selectedId: id,
      selectedCode: code,
      selectedStatus: authoritativeResult?.status || '',
      resolved: !!resolvedResult,
      resolvedId: resolvedResult?.orderId || resolvedResult?.id || '',
      resolvedStatus: resolvedResult?.status || '',
      href,
    });
    return { href, result: finalResult, resolved: !!resolvedResult, source: resolvedResult ? 'db-live-query-authority' : 'fallback-query-authority' };
  } catch (error) {
    writeHomeSearchDiagnostics({
      event: 'result_click_resolve_failed',
      query: searchQuery,
      queryMode,
      selectedKind: kind,
      selectedId: id,
      selectedCode: code,
      selectedStatus: authoritativeResult?.status || '',
      error: String(error?.message || error || ''),
      href: fallbackHref,
    });
    return { href: fallbackHref, result: authoritativeResult, resolved: false, source: 'error-fallback-query-authority', error };
  }
}

export async function searchHomeLocalFirst(query) {
  const q = safeString(query);
  if (!q) return { results: [], baseLocalCount: 0, transportLocalCount: 0 };
  const mode = getHomeSearchQueryMode(q);
  const [dbExactRows, dbGeneralRows, snapshotRows, idbRows, baseMasterRows] = await Promise.all([
    getRowsFromDbExact(q, mode),
    getRowsFromDbGeneral(q, mode),
    getRowsFromSnapshots(),
    getRowsFromIndexedDb(),
    getRowsFromBaseMasterCache(),
  ]);
  const localRows = [...dbExactRows, ...dbGeneralRows, ...baseMasterRows, ...idbRows, ...readLocalStorageRows(), ...snapshotRows];
  const matchedRows = localRows.filter((row) => rowMatches(row, q, mode));
  const userResolver = await buildHomeUserResolver(matchedRows);
  const matches = matchedRows.map((row) => normalizeResult(row, { userResolver }));
  const results = dedupeResults(matches);
  const baseLocalCount = localRows.filter((row) => getKind(row) === 'BASE').length;
  const transportLocalCount = localRows.filter((row) => getKind(row) === 'TRANSPORT').length;
  writeHomeSearchDiagnostics({
    query: q,
    normalizedQuery: normalizeText(q),
    queryMode: mode,
    baseLocalCount,
    transportLocalCount,
    dbExactCount: dbExactRows.length,
    dbGeneralCount: dbGeneralRows.length,
    resultsCount: results.length,
    policyVersion: 'HOME_SEARCH_SOLID_V1',
  });
  return { results, baseLocalCount, transportLocalCount };
}

export function writeHomeSearchDiagnostics(detail = {}) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(HOME_SEARCH_DIAG_KEY, JSON.stringify({
      ...detail,
      timestamp: new Date().toISOString(),
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      appVersion: window.__TEPIHA_BUILD_ID || '',
      epoch: window.__TEPIHA_APP_EPOCH || '',
    }));
  } catch {}
}
