export const BASE_DONE_STATUSES = new Set([
  'dorezuar',
  'dorëzuar',
  'dorzim',
  'dorezim',
  'paguar',
  'anuluar',
  'cancelled',
  'canceled',
  'failed',
  'deshtuar',
  'dështuar',
  'deleted',
  'void',
  'arkiv',
  'arkivuar',
  'done',
  'completed',
  'archived',
]);

function cleanId(value) {
  return String(value ?? '').trim();
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function firstText(values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return '';
}

export function normalizeBaseCode(value) {
  return cleanText(value).replace(/\D+/g, '').replace(/^0+/, '');
}

export function normalizeBasePhone(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits.length >= 6 ? digits : '';
}

export function baseOrderData(order) {
  const value = order?.data;
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isArchivedFletoreDraft(order) {
  const data = baseOrderData(order);
  return data?.is_archived_stale_draft === true
    || data?.fletore_cleanup?.archived === true
    || data?.fletore_cleanup?.state === 'ARCHIVED_STALE_DRAFT';
}

export function isBaseOrderActive(order) {
  const status = cleanText(order?.status).toLowerCase();
  return !BASE_DONE_STATUSES.has(status) && !isArchivedFletoreDraft(order);
}

export function baseClientKey(client) {
  const id = cleanId(client?.id);
  if (id) return `id:${id}`;
  const code = normalizeBaseCode(client?.code ?? client?.nr_rendor ?? client?.client_code);
  if (code) return `code:${code}`;
  const phone = normalizeBasePhone(client?.phone ?? client?.client_phone ?? client?.tel ?? client?.mobile);
  return phone ? `phone:${phone}` : '';
}

function addUnique(index, key, value) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, value);
    return;
  }
  if (index.get(key) !== value) index.set(key, null);
}

export function createBaseClientLookup(clients = []) {
  const byId = new Map();
  const byCode = new Map();
  const byPhone = new Map();
  for (const client of Array.isArray(clients) ? clients : []) {
    const id = cleanId(client?.id);
    if (id) byId.set(id, client);
    addUnique(byCode, normalizeBaseCode(client?.code ?? client?.nr_rendor ?? client?.client_code), client);
    addUnique(byPhone, normalizeBasePhone(client?.phone ?? client?.client_phone ?? client?.tel ?? client?.mobile), client);
  }
  return { byId, byCode, byPhone };
}

function orderHints(order) {
  const data = baseOrderData(order);
  const embedded = data?.client && typeof data.client === 'object' ? data.client : {};
  const directClientId = cleanId(order?.client_id);
  const embeddedIds = [
    data?.client_id,
    data?.clientId,
    data?.client_master_id,
    embedded?.id,
    embedded?.client_id,
  ].map(cleanId).filter((value, index, values) => value && value !== directClientId && values.indexOf(value) === index);
  const code = normalizeBaseCode(firstText([
    order?.client_code,
    order?.code,
    data?.client_code,
    embedded?.code,
    data?.code,
  ]));
  const phone = normalizeBasePhone(firstText([
    order?.client_phone,
    order?.phone,
    data?.client_phone,
    embedded?.phone,
    data?.phone,
  ]));
  const name = firstText([
    order?.client_name,
    order?.client_full_name,
    data?.client_name,
    embedded?.full_name,
    embedded?.name,
  ]);
  return { data, embedded, directClientId, embeddedIds, code, phone, name };
}

export function resolveBaseOrderClient(order, lookup) {
  const hints = orderHints(order);
  const directClient = hints.directClientId ? lookup?.byId?.get(hints.directClientId) : null;
  if (directClient) {
    return { client: directClient, linkedBy: 'client_id', linkIssue: null, hints };
  }

  for (const id of hints.embeddedIds) {
    const client = lookup?.byId?.get(id);
    if (client) {
      return {
        client,
        linkedBy: 'embedded_client_id',
        linkIssue: hints.directClientId ? 'BROKEN_CLIENT_ID' : 'MISSING_CLIENT_ID',
        hints,
      };
    }
  }

  const phoneClient = hints.phone ? lookup?.byPhone?.get(hints.phone) : null;
  if (phoneClient) {
    return {
      client: phoneClient,
      linkedBy: 'phone',
      linkIssue: hints.directClientId ? 'BROKEN_CLIENT_ID' : 'MISSING_CLIENT_ID',
      hints,
    };
  }

  const codeClient = hints.code ? lookup?.byCode?.get(hints.code) : null;
  if (codeClient) {
    return {
      client: codeClient,
      linkedBy: 'code',
      linkIssue: hints.directClientId ? 'BROKEN_CLIENT_ID' : 'MISSING_CLIENT_ID',
      hints,
    };
  }

  const hasCustomerHints = !!(hints.code || hints.phone || hints.name || hints.embeddedIds.length);
  return {
    client: null,
    linkedBy: null,
    linkIssue: hints.directClientId
      ? 'BROKEN_CLIENT_ID'
      : (hasCustomerHints ? 'CUSTOMER_NOT_FOUND' : 'MISSING_CUSTOMER_DATA'),
    hints,
  };
}

function orderTime(order) {
  const time = new Date(order?.created_at || order?.updated_at || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function compareBaseOrdersNewestFirst(a, b) {
  const timeDiff = orderTime(b) - orderTime(a);
  if (timeDiff) return timeDiff;
  return String(b?.id ?? '').localeCompare(String(a?.id ?? ''), undefined, { numeric: true });
}

function compareClients(a, b) {
  const aCode = a?.code ?? a?.nr_rendor ?? a?.client_code ?? '';
  const bCode = b?.code ?? b?.nr_rendor ?? b?.client_code ?? '';
  return String(aCode).localeCompare(String(bCode), undefined, { numeric: true, sensitivity: 'base' });
}

export function buildBaseOrderBuckets(clients = [], orders = []) {
  const safeClients = Array.isArray(clients) ? clients : [];
  const safeOrders = Array.isArray(orders) ? orders : [];
  const lookup = createBaseClientLookup(safeClients);
  const clientGroups = new Map();
  const resolvedActiveOrders = [];
  const repairActiveOrders = [];
  const unlinkedActiveOrders = [];
  const lastOrdersByClientKey = new Map();

  for (const order of [...safeOrders].sort(compareBaseOrdersNewestFirst)) {
    const resolution = resolveBaseOrderClient(order, lookup);
    const clientKey = resolution.client ? baseClientKey(resolution.client) : '';
    if (clientKey && !lastOrdersByClientKey.has(clientKey)) {
      lastOrdersByClientKey.set(clientKey, order);
    }
    if (!isBaseOrderActive(order)) continue;

    const entry = { order, ...resolution };
    if (!resolution.client || !clientKey) {
      unlinkedActiveOrders.push(entry);
      continue;
    }

    resolvedActiveOrders.push(entry);
    if (resolution.linkIssue) repairActiveOrders.push(entry);
    const group = clientGroups.get(clientKey) || {
      ...resolution.client,
      _activeOrders: [],
      _activeOrderLinks: [],
    };
    group._activeOrders.push(order);
    group._activeOrderLinks.push(entry);
    clientGroups.set(clientKey, group);
  }

  const activeClients = Array.from(clientGroups.values()).map((client) => {
    client._activeOrders.sort(compareBaseOrdersNewestFirst);
    client._activeOrder = client._activeOrders[0] || null;
    return client;
  }).sort(compareClients);

  return {
    lookup,
    activeClients,
    resolvedActiveOrders,
    repairActiveOrders,
    unlinkedActiveOrders,
    lastOrdersByClientKey,
    activeOrderCount: resolvedActiveOrders.length + unlinkedActiveOrders.length,
  };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function firstPositive(values) {
  for (const value of values) {
    const number = positiveNumber(value);
    if (number > 0) return number;
  }
  return 0;
}

export function baseOrderTotalEur(order) {
  const data = baseOrderData(order);
  const pay = data?.pay && typeof data.pay === 'object' ? data.pay : {};
  const transfer = data?.partial_pickup_transfer_in;
  if (transfer && (typeof transfer !== 'object' || Object.keys(transfer).length > 0)) {
    const combined = firstPositive([
      data?.total,
      data?.debt,
      order?.total,
      transfer?.total,
      transfer?.balance,
      transfer?.debt,
    ]);
    if (combined > 0) return Number(combined.toFixed(2));
  }

  const direct = firstPositive([
    pay?.euro,
    pay?.total,
    data?.total,
    order?.total,
    order?.price_total,
    data?.price_total,
  ]);
  if (direct > 0) return Number(direct.toFixed(2));

  const rate = firstPositive([pay?.price, pay?.rate, data?.price]);
  const m2 = firstPositive([pay?.m2, data?.total_m2, data?.m2, order?.m2_total]);
  return Number((rate * m2).toFixed(2));
}

export function baseLinkIssueLabel(issue) {
  if (issue === 'BROKEN_CLIENT_ID') return 'client_id i prishur';
  if (issue === 'MISSING_CLIENT_ID') return 'mungon client_id';
  if (issue === 'CUSTOMER_NOT_FOUND') return 'klienti nuk u gjet në master';
  if (issue === 'MISSING_CUSTOMER_DATA') return 'mungojnë të dhënat e klientit';
  return '';
}
