import fs from 'node:fs';

const FAST_MARKER = 'TRANSPORT_PHONE_FAST_RPC_V2';

function replaceBlock(path, startMarker, endMarker, replacement, label) {
  const source = fs.readFileSync(path, 'utf8');
  if (source.includes(FAST_MARKER) && source.includes(replacement.trim().slice(0, 80))) {
    console.log(`SKIP ${label}: already patched`);
    return false;
  }

  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`${label}: start marker not found`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`${label}: end marker not found`);

  const next = `${source.slice(0, start)}${replacement.trimEnd()}${source.slice(end)}`;
  fs.writeFileSync(path, next, 'utf8');
  console.log(`PATCH ${label}`);
  return true;
}

function replaceOnce(path, oldText, newText, label) {
  const source = fs.readFileSync(path, 'utf8');
  if (source.includes(newText)) {
    console.log(`SKIP ${label}: already patched`);
    return false;
  }
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  fs.writeFileSync(path, source.replace(oldText, newText), 'utf8');
  console.log(`PATCH ${label}`);
  return true;
}

const canonicalReplacement = String.raw`
export async function findTransportClientByPhoneOnly(phoneValue, options = {}) {
  // TRANSPORT_PHONE_FAST_RPC_V2
  const phoneKey = normalizeTransportPhoneKey(phoneValue);
  if (!isValidTransportPhoneDigits(phoneKey)) return null;

  const requestedTimeoutMs = Number(options?.timeoutMs || 0);
  const timeoutMs = Math.max(requestedTimeoutMs > 0 ? requestedTimeoutMs : 0, 15000);
  const signal = options?.signal || null;

  const runLookup = async (ms, label) => {
    let query = supabase.rpc('find_transport_client_by_phone_fast', { p_phone: phoneValue });
    if (typeof query?.timeout === 'function') query = query.timeout(ms, label);
    if (signal && typeof query?.abortSignal === 'function') query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    return data && typeof data === 'object' ? data : null;
  };

  const isAbortError = (error) => {
    const code = String(error?.code || '').toUpperCase();
    return error?.name === 'AbortError' || code === 'ABORT_ERR' || /abort/i.test(String(error?.message || ''));
  };

  let payload = null;
  let firstError = null;
  try {
    payload = await runLookup(timeoutMs, 'TRANSPORT_CLIENT_PHONE_TIMEOUT');
  } catch (error) {
    firstError = error;
    if (isAbortError(error) && signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, 180));
    try {
      payload = await runLookup(Math.max(timeoutMs, 20000), 'TRANSPORT_CLIENT_PHONE_RETRY_TIMEOUT');
    } catch (retryError) {
      const firstMessage = String(firstError?.message || firstError || '').trim();
      const retryMessage = String(retryError?.message || retryError || 'UNKNOWN').trim();
      throw new Error('TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED: ' + retryMessage + (firstMessage && firstMessage !== retryMessage ? ' | FIRST: ' + firstMessage : ''));
    }
  }

  const status = String(payload?.status || '').trim().toUpperCase();
  if (!payload || status === 'NOT_FOUND') return null;

  if (status === 'CONFLICT') {
    const clientIds = Array.isArray(payload?.client_ids) ? payload.client_ids.filter(Boolean) : [];
    const tcodes = Array.isArray(payload?.tcodes) ? payload.tcodes.filter(Boolean) : [];
    throw new Error('TRANSPORT_PHONE_IDENTITY_CONFLICT:' + phoneKey + ':clients=' + (clientIds.join(',') || '-') + ':tcodes=' + (tcodes.join(',') || '-'));
  }

  if (status !== 'FOUND' || !payload?.candidate) {
    throw new Error('TRANSPORT_CLIENT_PHONE_LOOKUP_INVALID_RESPONSE:' + (status || 'EMPTY'));
  }

  const candidate = normalizeTransportClientCandidate(
    payload.candidate,
    payload?.candidate?.source || (payload?.source_mode === 'MASTER' ? 'transport_clients' : 'transport_orders'),
  );
  const candidatePhoneKey = normalizeTransportPhoneKey(candidate?.phone_digits || candidate?.phone || '');
  if (!candidatePhoneKey || candidatePhoneKey !== phoneKey) {
    throw new Error('TRANSPORT_CLIENT_PHONE_RPC_MISMATCH:' + phoneKey + ':' + (candidatePhoneKey || '-'));
  }

  return candidate;
}
`;

const pageReplacement = String.raw`
async function findTransportClientByPhoneOnly(phoneValue, options = {}) {
  // TRANSPORT_PHONE_FAST_RPC_V2
  return findTransportClientByPhoneCanonical(phoneValue, {
    ...(options || {}),
    timeoutMs: Math.max(Number(options?.timeoutMs || 0), 15000),
  });
}
`;

replaceBlock(
  'lib/transport/transportDb.js',
  'export async function findTransportClientByPhoneOnly(phoneValue, options = {}) {',
  '\n\nfunction ensureTransportClientSearchCode',
  canonicalReplacement,
  'canonical transport phone lookup',
);

replaceBlock(
  'app/transport/pranimi/page.jsx',
  'async function findTransportClientByPhoneOnly(phoneValue, options = {}) {',
  '\n\nasync function searchClientsLive',
  pageReplacement,
  'transport pranimi phone lookup',
);

const bridgePath = 'lib/transportMultiLocationBridge.js';
replaceOnce(
  bridgePath,
  `  suppressInput: false,\n};`,
  `  suppressInput: false,\n  loadedPhoneKey: '',\n  loadedAt: 0,\n  loadFailed: false,\n};`,
  'transport location cache state',
);

replaceOnce(
  bridgePath,
  `    state.phoneKey = phoneKey;\n    state.locations = [];\n    state.selected = null;\n    renderPicker(fields);\n    return;`,
  `    state.phoneKey = phoneKey;\n    state.locations = [];\n    state.selected = null;\n    state.loadedPhoneKey = '';\n    state.loadedAt = 0;\n    state.loadFailed = false;\n    renderPicker(fields);\n    return;`,
  'transport location invalid phone reset',
);

replaceOnce(
  bridgePath,
  `  if (state.loading && state.phoneKey === phoneKey) return;\n  if (state.phoneKey === phoneKey && state.locations.length) {\n    renderPicker(fields);\n    return;\n  }`,
  `  const cacheTtl = state.loadFailed ? 5000 : 60000;\n  if (state.loading && state.phoneKey === phoneKey) return;\n  if (state.loadedPhoneKey === phoneKey && (Date.now() - Number(state.loadedAt || 0)) < cacheTtl) {\n    renderPicker(fields);\n    return;\n  }`,
  'transport location cache guard',
);

replaceOnce(
  bridgePath,
  `    state.locations = (Array.isArray(data) ? data : [])\n      .filter((row) => normalizeText(row?.address))\n      .filter((row, index, rows) => rows.findIndex((other) => normalizeAddressKey(other?.address) === normalizeAddressKey(row?.address)) === index);`,
  `    state.locations = (Array.isArray(data) ? data : [])\n      .filter((row) => normalizeText(row?.address))\n      .filter((row, index, rows) => rows.findIndex((other) => normalizeAddressKey(other?.address) === normalizeAddressKey(row?.address)) === index);\n    state.loadedPhoneKey = phoneKey;\n    state.loadedAt = Date.now();\n    state.loadFailed = false;`,
  'transport location successful cache',
);

replaceOnce(
  bridgePath,
  `    state.locations = [];\n    try { console.warn('TRANSPORT_MULTI_LOCATION_LOAD_FAILED', error); } catch {}`,
  `    state.locations = [];\n    state.loadedPhoneKey = phoneKey;\n    state.loadedAt = Date.now();\n    state.loadFailed = true;\n    try { console.warn('TRANSPORT_MULTI_LOCATION_LOAD_FAILED', error); } catch {}`,
  'transport location failed cache',
);

replaceOnce(
  bridgePath,
  `      state.locations = [];\n      state.selected = null;`,
  `      state.locations = [];\n      state.selected = null;\n      state.loadedPhoneKey = '';\n      state.loadedAt = 0;\n      state.loadFailed = false;`,
  'transport location phone change reset',
);

replaceOnce(
  bridgePath,
  `  const observer = new MutationObserver(() => scheduleRefresh(60));\n  observer.observe(document.documentElement, { childList: true, subtree: true });`,
  `  window.setInterval(() => {\n    if (!isTransportPranimiRoute()) return;\n    const fields = findClientFields();\n    if (!fields) return;\n    const phoneKey = normalizePhoneKey(fields.phone);\n    if (phoneKey.length >= 8 && (phoneKey !== state.phoneKey || phoneKey !== state.loadedPhoneKey)) {\n      scheduleRefresh(40);\n    }\n  }, 750);`,
  'remove transport location mutation feedback loop',
);

const canonicalAfter = fs.readFileSync('lib/transport/transportDb.js', 'utf8');
const canonicalStart = canonicalAfter.indexOf('export async function findTransportClientByPhoneOnly');
const canonicalEnd = canonicalAfter.indexOf('\n\nfunction ensureTransportClientSearchCode', canonicalStart);
const canonicalBlock = canonicalAfter.slice(canonicalStart, canonicalEnd);
if (!canonicalBlock.includes("supabase.rpc('find_transport_client_by_phone_fast'")) {
  throw new Error('canonical transport phone lookup did not switch to fast RPC');
}
if (canonicalBlock.includes('.limit(5000)')) {
  throw new Error('canonical transport phone lookup still performs full-table history scans');
}

const pageAfter = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const pageStart = pageAfter.indexOf('async function findTransportClientByPhoneOnly');
const pageEnd = pageAfter.indexOf('\n\nasync function searchClientsLive', pageStart);
const pageBlock = pageAfter.slice(pageStart, pageEnd);
if (!pageBlock.includes('findTransportClientByPhoneCanonical')) {
  throw new Error('transport pranimi lookup did not delegate to canonical fast lookup');
}

const bridgeAfter = fs.readFileSync(bridgePath, 'utf8');
if (bridgeAfter.includes('new MutationObserver')) {
  throw new Error('transport multi-location bridge still contains a mutation feedback loop');
}
if (!bridgeAfter.includes('loadedPhoneKey') || !bridgeAfter.includes('setInterval')) {
  throw new Error('transport multi-location bridge cache/poller patch missing');
}

console.log('PASS transport phone resilience source patch');
