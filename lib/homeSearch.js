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

function getKind(row) {
  const table = safeString(row?._table || row?.table || row?.source_table).toLowerCase();
  const code = normalizeCode(pickCode(row));
  if (table === 'transport_orders' || table.includes('transport')) return 'TRANSPORT';
  if (/^T\d+$/i.test(code)) return 'TRANSPORT';
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
    row?.transport_name,
    row?.driver_name,
    row?.transporter_name,
    row?.created_by_name,
    row?.brought_by,
    row?.actor,
    data?.transport_name,
    data?.driver_name,
    data?.transporter_name,
    data?.created_by_name,
    data?.brought_by,
    data?.actor,
    data?._audit?.created_by_name,
    data?.transport?.name,
    data?.transport?.driver_name,
    data?.transport?.driverName,
    data?.transport?.assigned_driver_name,
    data?.transport?.brought_by
  );
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
  const pushValue = (value, qty = 1) => {
    const label = formatMeasureValue(value);
    if (!label) return;
    const count = Math.max(1, Math.min(Number(qty) || 1, 80));
    for (let index = 0; index < count; index += 1) chips.push(label);
  };
  const pushRows = (rows) => {
    if (!Array.isArray(rows)) return;
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
    pushRows(data?.tepiha);
    pushRows(data?.tepihaRows);
    pushRows(data?.staza);
    pushRows(data?.stazaRows);
    pushRows(data?.m2_list);
    pushRows(data?.m2s);
    pushRows(data?.measurements);
    const stairsQty = Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0;
    const stairsPer = Number(data?.shkallore?.per ?? data?.stairsPer ?? 0) || 0;
    if (stairsQty > 0 && stairsPer > 0) pushValue(stairsPer, stairsQty);
  } catch {}

  return chips.filter(Boolean);
}

function normalizeResult(row, options = {}) {
  const kind = getKind(row);
  const data = unwrapData(row);
  const rawCode = pickCode(row);
  const code = kind === 'TRANSPORT' ? normalizeCode(rawCode) : safeString(rawCode).replace(/^#+/, '');
  const transporter = kind === 'TRANSPORT'
    ? resolveTransporterName(row, options?.userResolver)
    : pickTransporter(row);
  const cleanTransporter = cleanVisiblePersonName(transporter);
  return {
    kind,
    id: row?.id ?? row?.local_oid ?? row?.transport_id ?? null,
    clientId: row?.client_id ?? row?.clientId ?? data?.client_id ?? data?.clientId ?? null,
    code,
    status: pickStatus(row),
    name: pickName(row),
    phone: pickPhone(row),
    address: pickAddress(row),
    pieces: computePieces(row),
    createdBy: pickCreatedBy(row),
    transporter: cleanTransporter,
    broughtBy: kind === 'TRANSPORT' ? (cleanTransporter || 'PA EMËR NË CACHE') : cleanTransporter,
    measurements: extractMeasurementChips(row),
    updatedAt: pickFirst(row?.updated_at, data?.updated_at, row?.ready_at, data?.ready_at, row?.delivered_at, data?.delivered_at, row?.created_at, data?.created_at),
    createdAt: pickFirst(row?.created_at, data?.created_at),
    deliveredAt: pickFirst(row?.delivered_at, data?.delivered_at),
    pickedUpAt: pickFirst(row?.picked_up_at, data?.picked_up_at),
    homeSearchSource: pickFirst(row?._homeSearchSource, row?._snapshot ? `snapshot:${row._snapshot}` : '', row?._table),
    sourceRank: computeHomeSearchSourceRank(row),
  };
}

function rowMatches(row, query, mode = getHomeSearchQueryMode(query)) {
  const qText = normalizeText(query);
  const qDigits = normalizeNumericCode(query);
  const qCode = normalizeCode(query);
  if (!qText && !qDigits && !qCode) return false;

  const result = normalizeResult(row);
  const kind = safeString(result.kind).toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  const code = normalizeCode(result.code);

  if (mode === 'BASE_ONLY') {
    if (kind !== 'BASE') return false;
    if (/^T\d+$/i.test(code)) return false;
    return !!qDigits && normalizeNumericCode(code) === qDigits;
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
  if (['dorzim', 'dorezim', 'dorzuar', 'dorezuar', 'delivered', 'delivery', 'marrje', 'completed', 'kompletuar'].includes(status)) return 5;
  if (status === 'gati') return 4;
  if (status === 'pastrim' || status === 'pastrimi') return 3;
  if (status === 'pranim' || status === 'pranimi') return 2;
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
  const strictCode = String(item?.kind || '').toUpperCase() === 'TRANSPORT'
    ? normalizeTransportCodeStrict(item?.code)
    : normalizeNumericCode(item?.code);
  return strictCode
    ? [item.kind, 'CODE', strictCode].join('|')
    : [item.kind, item.id || '', normalizePhone(item.phone || ''), normalizeText(item.name || '')].join('|');
}

function compareHomeSearchResultStrength(candidate, current) {
  const candidateStatusRank = getHomeStatusRank(candidate?.status);
  const currentStatusRank = getHomeStatusRank(current?.status);
  if (candidateStatusRank !== currentStatusRank) return candidateStatusRank - currentStatusRank;

  const candidateTime = getHomeResultTimestamp(candidate);
  const currentTime = getHomeResultTimestamp(current);
  if (candidateTime !== currentTime) return candidateTime - currentTime;

  const candidateSourceRank = Number(candidate?.sourceRank || 0) || 0;
  const currentSourceRank = Number(current?.sourceRank || 0) || 0;
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

export function buildHomeSearchHref(result) {
  const kind = safeString(result?.kind).toUpperCase();
  const code = safeString(result?.code);
  const id = result?.id != null ? safeString(result.id) : '';
  const status = normalizeText(result?.status);
  if (kind === 'TRANSPORT') {
    if (id) return `/transport/item?id=${encodeURIComponent(id)}&src=transport&from=home_inline_search`;
    if (code) return `/transport/item?code=${encodeURIComponent(normalizeCode(code))}&from=home_inline_search`;
    return '/transport';
  }
  const route = status === 'gati'
    ? '/gati'
    : (['dorzim', 'dorezim', 'dorzuar', 'dorezuar', 'delivered', 'delivery', 'marrje', 'completed', 'kompletuar'].includes(status))
      ? '/marrje-sot'
      : '/pastrimi';
  const params = new URLSearchParams();
  if (code) params.set('q', code);
  if (id) params.set('openId', id);
  if (code || id) params.set('exact', '1');
  params.set('from', 'home_inline_search');
  return `${route}?${params.toString()}`;
}

export async function searchHomeLocalFirst(query) {
  const q = safeString(query);
  if (!q) return { results: [], baseLocalCount: 0, transportLocalCount: 0 };
  const mode = getHomeSearchQueryMode(q);
  const [snapshotRows, idbRows, baseMasterRows] = await Promise.all([
    getRowsFromSnapshots(),
    getRowsFromIndexedDb(),
    getRowsFromBaseMasterCache(),
  ]);
  const localRows = [...baseMasterRows, ...idbRows, ...readLocalStorageRows(), ...snapshotRows];
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
    resultsCount: results.length,
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
