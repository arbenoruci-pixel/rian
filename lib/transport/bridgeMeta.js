function asObj(v){ return v && typeof v === 'object' ? v : {}; }

function asBool(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'po';
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function unwrapRowData(row){
  const raw = asObj(row?.data);
  if (raw.data && typeof raw.data === 'object') return { ...raw, ...asObj(raw.data) };
  return raw;
}

function readTransportBridgeNode(data = {}) {
  return asObj(data?.transport || data?.transport_meta || data?.transportOrder);
}

function normalizeStatus(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'pastrimi') return 'pastrim';
  if (raw === 'pranimi') return 'pranim';
  if (raw === 'marrje_sot') return 'marrje';
  return raw;
}

function computePiecesFromData(data){
  const t = Array.isArray(data?.tepiha) ? data.tepiha : (Array.isArray(data?.tepihaRows) ? data.tepihaRows : []);
  const s = Array.isArray(data?.staza) ? data.staza : (Array.isArray(data?.stazaRows) ? data.stazaRows : []);
  const tCope = t.reduce((a, b) => a + (Number(b?.qty ?? b?.pieces) || 0), 0);
  const sCope = s.reduce((a, b) => a + (Number(b?.qty ?? b?.pieces) || 0), 0);
  const shk = Number(data?.shkallore?.qty || data?.stairsQty || 0) || 0;
  return tCope + sCope + shk;
}

function buildTransportSearchBlob(row, data, summary = {}){
  return [
    summary.code,
    summary.clientName,
    summary.clientPhone,
    summary.rackText,
    summary.broughtBy,
    summary.transportRef,
    String(data?.notes || data?.driver_note || data?.transport_note || data?.address || data?.client?.address || '').trim(),
  ].filter(Boolean).join(' ');
}

export function matchesTransportSearch(input, searchText = ''){
  const q = normalizeText(searchText);
  if (!q) return true;

  const row = asObj(input);
  const summary = row?.searchBlob
    ? { searchBlob: String(row.searchBlob || '') }
    : getTransportBaseSummary(row);

  const hay = normalizeText(summary?.searchBlob || '');
  return !!hay && hay.includes(q);
}

export function getTransportBaseSummary(row){
  const data = unwrapRowData(row);
  const readySlots = Array.isArray(row?.ready_slots) ? row.ready_slots : (Array.isArray(data?.ready_slots) ? data.ready_slots : []);
  const readyLocation = String(row?.ready_location || data?.ready_location || '').trim();
  const readyNote = String(row?.ready_note || data?.ready_note || data?.base_note || data?.base_location_note || '').trim();
  const rackText = [readySlots.filter(Boolean).join(', '), readyLocation, readyNote].filter(Boolean).join(' • ').trim();

  const summary = {
    code: String(row?.client_tcode || row?.code_str || data?.client?.tcode || data?.client_tcode || '').trim().toUpperCase(),
    clientName: String(row?.client_name || data?.client?.name || data?.client_name || row?.name || '').trim(),
    clientPhone: String(row?.client_phone || data?.client?.phone || data?.client_phone || row?.phone || '').trim(),
    pieces: Number(row?.pieces || data?.pieces || data?.totals?.pieces || computePiecesFromData(data) || 0) || 0,
    rackText,
    broughtBy: String(
      data?.driver_name ||
      data?.transport_name ||
      data?.actor ||
      row?.driver_name ||
      row?.created_by_name ||
      data?._audit?.created_by_name ||
      data?.created_by_name ||
      row?.created_by ||
      data?.created_by ||
      ''
    ).trim(),
    transportRef: String(row?.transport_id || data?.transport_id || data?.transportId || '').trim(),
  };

  const searchBlob = buildTransportSearchBlob(row, data, summary);
  return {
    ...summary,
    searchBlob,
    matchesSearch: (searchText) => matchesTransportSearch({ searchBlob }, searchText),
  };
}

export function isTransportBridgeReadyForBase(input) {
  const row = asObj(input);
  const data = unwrapRowData(row);
  const transport = readTransportBridgeNode(data);
  const status = normalizeStatus(row?.status || data?.status || transport?.status || '');

  if (status === 'pastrim' || status === 'gati' || status === 'dorzim' || status === 'marrje' || status === 'done') {
    return true;
  }

  const flags = [
    row?.received_at_base,
    row?.unloaded_at_base,
    row?.base_received_at,
    row?.base_unloaded_at,
    row?.base_received,
    row?.received_in_base,
    data?.received_at_base,
    data?.unloaded_at_base,
    data?.base_received_at,
    data?.base_unloaded_at,
    data?.base_received,
    data?.received_in_base,
    data?.base_arrived,
    data?.at_base,
    transport?.received_at_base,
    transport?.unloaded_at_base,
    transport?.base_received_at,
    transport?.base_unloaded_at,
    transport?.base_received,
    transport?.received_in_base,
    transport?.at_base,
  ];
  if (flags.some((value) => asBool(value) || (!!value && typeof value !== 'boolean'))) {
    return true;
  }

  const markers = [
    row?.bridge_status,
    row?.base_status,
    data?.bridge_status,
    data?.base_status,
    transport?.bridge_status,
    transport?.base_status,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);

  return markers.some((value) => (
    value === 'received_at_base' ||
    value === 'unloaded_at_base' ||
    value === 'base_received' ||
    value === 'at_base' ||
    value === 'in_base'
  ));
}
