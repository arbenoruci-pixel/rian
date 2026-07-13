import { supabase } from './supabaseClient';

const INSTALL_KEY = '__TEPIHA_TRANSPORT_MULTI_LOCATION_BRIDGE_V1__';
const PICKER_ID = 'tepiha-transport-location-picker-v1';
const RPC_PATCH_KEY = '__TEPIHA_TRANSPORT_MULTI_LOCATION_RPC_PATCH_V1__';

const state = {
  phoneKey: '',
  locations: [],
  selected: null,
  loading: false,
  querySeq: 0,
  timer: null,
  suppressInput: false,
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePhoneKey(value) {
  let digits = String(value || '').replace(/\D+/g, '');
  if (digits.startsWith('00383')) digits = digits.slice(5);
  else if (digits.startsWith('383')) digits = digits.slice(3);
  digits = digits.replace(/^0+/, '');
  return digits;
}

function normalizeAddressKey(value) {
  return normalizeText(value).toLowerCase();
}

function isTransportPranimiRoute() {
  return String(window.location?.pathname || '').startsWith('/transport/pranimi');
}

function isVisible(element) {
  if (!element || !element.isConnected) return false;
  const style = window.getComputedStyle?.(element);
  if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  return Boolean(element.getClientRects?.().length);
}

function labelByText(text) {
  const wanted = normalizeText(text).toUpperCase();
  return Array.from(document.querySelectorAll('label')).find((label) => (
    isVisible(label) && normalizeText(label.textContent).toUpperCase() === wanted
  )) || null;
}

function findClientFields() {
  if (!isTransportPranimiRoute()) return null;
  const addressLabel = labelByText('ADRESA');
  const phoneLabel = labelByText('TELEFONI');
  if (!addressLabel || !phoneLabel) return null;

  const addressGroup = addressLabel.closest('.field-group') || addressLabel.parentElement;
  const phoneGroup = phoneLabel.closest('.field-group') || phoneLabel.parentElement;
  const textarea = addressGroup?.querySelector?.('textarea');
  const phoneInput = phoneGroup?.querySelector?.('input');
  const prefixButton = phoneGroup?.querySelector?.('.prefixBtn, button');
  if (!textarea || !phoneInput) return null;

  const prefix = normalizeText(prefixButton?.textContent || '+383');
  const phone = `${prefix}${String(phoneInput.value || '')}`;
  return { addressGroup, phoneGroup, textarea, phoneInput, prefixButton, phone };
}

function setControlledValue(element, value) {
  if (!element) return;
  const proto = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement?.prototype
    : window.HTMLInputElement?.prototype;
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
  state.suppressInput = true;
  try {
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } finally {
    window.setTimeout(() => { state.suppressInput = false; }, 0);
  }
}

function patchedOrderData(dataValue, { address, gpsLat, gpsLng, gpsExplicit = false }) {
  const data = dataValue && typeof dataValue === 'object' && !Array.isArray(dataValue)
    ? { ...dataValue }
    : {};
  const client = data.client && typeof data.client === 'object' && !Array.isArray(data.client)
    ? { ...data.client }
    : {};
  const gps = client.gps && typeof client.gps === 'object' && !Array.isArray(client.gps)
    ? { ...client.gps }
    : {};

  if (address) {
    data.address = address;
    client.address = address;
  }
  data.location_gps_explicit = Boolean(gpsExplicit);
  data.gps_lat = gpsLat || null;
  data.gps_lng = gpsLng || null;
  client.gps_lat = gpsLat || null;
  client.gps_lng = gpsLng || null;
  client.gps = { ...gps, lat: gpsLat || null, lng: gpsLng || null };
  data.client = client;
  return data;
}

function installRpcPatch() {
  if (supabase[RPC_PATCH_KEY]) return;
  const originalRpc = supabase.rpc.bind(supabase);
  supabase[RPC_PATCH_KEY] = { originalRpc };

  supabase.rpc = function patchedRpc(functionName, args, options) {
    if (
      functionName === 'create_transport_order' &&
      isTransportPranimiRoute() &&
      state.selected &&
      normalizePhoneKey(args?.p_client_phone) === state.selected.phoneKey
    ) {
      const selected = state.selected;
      const address = selected.mode === 'existing'
        ? normalizeText(selected.address)
        : normalizeText(args?.p_address);
      const gpsWasRefreshed = Number(selected.gpsRequestedAt || 0) > Number(selected.selectedAt || 0);
      const gpsLat = selected.mode === 'existing' && !gpsWasRefreshed
        ? (selected.gps_lat || null)
        : (gpsWasRefreshed ? (args?.p_gps_lat || null) : null);
      const gpsLng = selected.mode === 'existing' && !gpsWasRefreshed
        ? (selected.gps_lng || null)
        : (gpsWasRefreshed ? (args?.p_gps_lng || null) : null);

      args = {
        ...(args || {}),
        p_address: address,
        p_gps_lat: gpsLat,
        p_gps_lng: gpsLng,
        p_data: patchedOrderData(args?.p_data, { address, gpsLat, gpsLng, gpsExplicit: gpsWasRefreshed }),
      };
    }
    return originalRpc(functionName, args, options);
  };
}

function chooseLocation(location, fields) {
  const phoneKey = normalizePhoneKey(fields?.phone);
  if (!phoneKey) return;
  state.selected = {
    mode: 'existing',
    phoneKey,
    locationId: location?.location_id || '',
    address: normalizeText(location?.address),
    gps_lat: location?.gps_lat || null,
    gps_lng: location?.gps_lng || null,
    selectedAt: Date.now(),
    gpsRequestedAt: 0,
  };
  setControlledValue(fields.textarea, state.selected.address);
  renderPicker(fields);
}

function chooseNewLocation(fields) {
  const phoneKey = normalizePhoneKey(fields?.phone);
  if (!phoneKey) return;
  state.selected = {
    mode: 'new',
    phoneKey,
    locationId: '',
    address: '',
    gps_lat: null,
    gps_lng: null,
    selectedAt: Date.now(),
    gpsRequestedAt: 0,
  };
  setControlledValue(fields.textarea, '');
  fields.textarea?.focus?.();
  renderPicker(fields);
}

function locationButton(location, index, fields) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tepiha-location-choice';
  const selected = state.selected?.mode === 'existing' && (
    String(state.selected.locationId || '') === String(location?.location_id || '') ||
    normalizeAddressKey(state.selected.address) === normalizeAddressKey(location?.address)
  );
  button.dataset.selected = selected ? '1' : '0';
  button.innerHTML = `<strong>🏠 SHTEPIA ${index + 1}</strong><span>${normalizeText(location?.address)}</span>${(location?.gps_lat || location?.gps_lng) ? '<small>📍 GPS I RUAJTUR</small>' : ''}`;
  button.addEventListener('click', () => chooseLocation(location, fields));
  return button;
}

function renderPicker(fields = findClientFields()) {
  const existing = document.getElementById(PICKER_ID);
  if (!fields || !isTransportPranimiRoute()) {
    existing?.remove?.();
    return;
  }

  const phoneKey = normalizePhoneKey(fields.phone);
  if (!phoneKey || state.phoneKey !== phoneKey || (!state.loading && !state.locations.length)) {
    existing?.remove?.();
    return;
  }

  const picker = existing || document.createElement('div');
  picker.id = PICKER_ID;
  picker.className = 'tepiha-transport-location-picker';
  picker.replaceChildren();

  const title = document.createElement('div');
  title.className = 'tepiha-location-title';
  title.textContent = state.locations.length > 1 ? 'ZGJIDH SHTEPINE / ADRESEN' : 'ADRESA E RUAJTUR';
  picker.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'tepiha-location-hint';
  hint.textContent = 'NUMRI DHE T-CODE MBESIN TE NJEJTE. ZGJIDH VETEM LOKACIONIN E KESAJ POROSIE.';
  picker.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'tepiha-location-list';
  state.locations.forEach((location, index) => list.appendChild(locationButton(location, index, fields)));

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'tepiha-location-choice tepiha-location-new';
  addButton.dataset.selected = state.selected?.mode === 'new' ? '1' : '0';
  addButton.innerHTML = '<strong>＋ ADRESE E RE</strong><span>Per shtepi, banese ose lokal tjeter</span>';
  addButton.addEventListener('click', () => chooseNewLocation(fields));
  list.appendChild(addButton);
  picker.appendChild(list);

  if (!existing) fields.addressGroup.parentNode?.insertBefore?.(picker, fields.addressGroup);

  if (
    state.selected?.mode === 'existing' &&
    state.selected.phoneKey === phoneKey &&
    normalizeAddressKey(fields.textarea.value) !== normalizeAddressKey(state.selected.address)
  ) {
    setControlledValue(fields.textarea, state.selected.address);
  }
}

async function loadLocations(fields = findClientFields()) {
  if (!fields) return;
  const phoneKey = normalizePhoneKey(fields.phone);
  if (phoneKey.length < 8) {
    state.phoneKey = phoneKey;
    state.locations = [];
    state.selected = null;
    renderPicker(fields);
    return;
  }
  if (state.loading && state.phoneKey === phoneKey) return;
  if (state.phoneKey === phoneKey && state.locations.length) {
    renderPicker(fields);
    return;
  }

  const seq = ++state.querySeq;
  state.phoneKey = phoneKey;
  state.locations = [];
  state.selected = null;
  state.loading = true;
  renderPicker(fields);

  try {
    const { data, error } = await supabase.rpc('list_transport_client_locations_by_phone', { p_phone: fields.phone });
    if (error) throw error;
    if (seq !== state.querySeq) return;
    state.locations = (Array.isArray(data) ? data : [])
      .filter((row) => normalizeText(row?.address))
      .filter((row, index, rows) => rows.findIndex((other) => normalizeAddressKey(other?.address) === normalizeAddressKey(row?.address)) === index);
  } catch (error) {
    if (seq !== state.querySeq) return;
    state.locations = [];
    try { console.warn('TRANSPORT_MULTI_LOCATION_LOAD_FAILED', error); } catch {}
  } finally {
    if (seq === state.querySeq) {
      state.loading = false;
      renderPicker(findClientFields());
    }
  }
}

function scheduleRefresh(delay = 80) {
  if (state.timer) window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => {
    state.timer = null;
    const fields = findClientFields();
    if (!fields) {
      renderPicker(null);
      return;
    }
    const phoneKey = normalizePhoneKey(fields.phone);
    if (phoneKey !== state.phoneKey) {
      state.locations = [];
      state.selected = null;
    }
    void loadLocations(fields);
  }, delay);
}

function installStyles() {
  if (document.getElementById(`${PICKER_ID}-style`)) return;
  const style = document.createElement('style');
  style.id = `${PICKER_ID}-style`;
  style.textContent = `
    #${PICKER_ID}{margin:12px 0;padding:14px;border-radius:18px;border:1px solid rgba(59,130,246,.45);background:rgba(37,99,235,.13);color:#fff}
    #${PICKER_ID} .tepiha-location-title{font-size:14px;font-weight:1000;color:#bfdbfe;letter-spacing:.02em}
    #${PICKER_ID} .tepiha-location-hint{margin-top:5px;font-size:11px;line-height:1.35;opacity:.78;font-weight:800}
    #${PICKER_ID} .tepiha-location-list{display:grid;grid-template-columns:1fr;gap:8px;margin-top:12px}
    #${PICKER_ID} .tepiha-location-choice{width:100%;text-align:left;padding:11px 12px;border-radius:13px;border:1px solid rgba(255,255,255,.15);background:rgba(2,6,23,.58);color:#fff;display:flex;flex-direction:column;gap:4px}
    #${PICKER_ID} .tepiha-location-choice[data-selected="1"]{border-color:#22c55e;background:rgba(22,163,74,.22);box-shadow:0 0 0 2px rgba(34,197,94,.15)}
    #${PICKER_ID} .tepiha-location-choice strong{font-size:12px;font-weight:1000;color:#fff}
    #${PICKER_ID} .tepiha-location-choice span{font-size:13px;line-height:1.3;color:#e2e8f0}
    #${PICKER_ID} .tepiha-location-choice small{font-size:10px;color:#86efac;font-weight:900}
    #${PICKER_ID} .tepiha-location-new{border-style:dashed;background:rgba(255,255,255,.05)}
  `;
  document.head?.appendChild?.(style);
}

export function installTransportMultiLocationBridge() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window[INSTALL_KEY]) return;
  window[INSTALL_KEY] = true;

  installRpcPatch();
  installStyles();

  document.addEventListener('input', (event) => {
    if (!isTransportPranimiRoute() || state.suppressInput) return;
    const fields = findClientFields();
    if (!fields) return;
    if (event.target === fields.phoneInput) {
      scheduleRefresh(180);
      return;
    }
    if (event.target === fields.textarea && state.selected?.phoneKey === normalizePhoneKey(fields.phone)) {
      if (state.selected.mode === 'existing' && normalizeAddressKey(fields.textarea.value) !== normalizeAddressKey(state.selected.address)) {
        state.selected = {
          mode: 'new',
          phoneKey: state.selected.phoneKey,
          locationId: '',
          address: '',
          gps_lat: null,
          gps_lng: null,
          selectedAt: Date.now(),
          gpsRequestedAt: 0,
        };
        renderPicker(fields);
      }
    }
  }, true);

  document.addEventListener('click', (event) => {
    if (!isTransportPranimiRoute()) return;
    const gpsButton = event.target?.closest?.('.gps-big-btn');
    if (gpsButton && state.selected) {
      state.selected.gpsRequestedAt = Date.now();
    }
    const prefixButton = event.target?.closest?.('.prefixBtn');
    if (prefixButton) scheduleRefresh(250);
  }, true);

  const observer = new MutationObserver(() => scheduleRefresh(60));
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('popstate', () => scheduleRefresh(80));
  window.addEventListener('hashchange', () => scheduleRefresh(80));
  scheduleRefresh(0);
}

export default installTransportMultiLocationBridge;
