import fs from 'node:fs';

const TAG = 'dispatch-boss-controls-v1';
const MARKER = 'DISPATCH_BOSS_CONTROLS_V1';

function replaceOnce(source, anchor, replacement, label) {
  const index = source.indexOf(anchor);
  if (index < 0) throw new Error(`${label}_ANCHOR_MISSING`);
  if (source.indexOf(anchor, index + anchor.length) >= 0) throw new Error(`${label}_ANCHOR_AMBIGUOUS`);
  return source.slice(0, index) + replacement + source.slice(index + anchor.length);
}

function appendTag(value) {
  const text = String(value || '').trim();
  return text.includes(TAG) ? text : `${text}-${TAG}`;
}

function patchServer() {
  const path = 'lib/transport/dispatchOrderServer.js';
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(MARKER)) return;

  const anchor = 'export async function createDispatchTransportPranimiOrderServer(bodyLike, { supabase, authUser } = {}) {';
  const fn = `export async function editDispatchTransportClientServer(bodyLike, { supabase, authUser } = {}) {
  // ${MARKER}: approved Dispatch is an elevated operational admin in this app.
  if (!supabase || !authUser?.id || !authUser?.pin) fail('AUTH_REQUIRED', 401);
  const actorRole = String(authUser.role || '').trim().toUpperCase();
  if (!DISPATCH_ORDER_ROLES.has(actorRole)) fail('DISPATCH_ORDER_ACTOR_NOT_ALLOWED', 403);

  const body = isPlainObject(bodyLike) ? bodyLike : {};
  const clientId = cleanUuid(body.client_id || body.clientId);
  const orderId = cleanUuid(body.order_id || body.orderId);
  const name = cleanText(body.name || body.client_name || body.clientName, 160);
  const phone = cleanText(body.phone || body.client_phone || body.clientPhone, 80);
  const address = cleanText(body.address || body.pickup_address || '', 1000);
  const phoneKey = normalizeTransportPhoneKeyServer(phone);
  if (!clientId) fail('DISPATCH_CLIENT_ID_INVALID', 400);
  if (!name) fail('TRANSPORT_CLIENT_NAME_REQUIRED', 400);
  if (!isValidTransportPhoneServer(phoneKey)) fail('TRANSPORT_PHONE_INVALID', 400);

  const { data: currentClient, error: currentClientError } = await supabase
    .from('transport_clients')
    .select('id,tcode,name,phone,phone_digits,address,updated_at')
    .eq('id', clientId)
    .maybeSingle();
  if (currentClientError) fail('DISPATCH_CLIENT_LOOKUP_FAILED', 503);
  if (!currentClient?.id) fail('DISPATCH_CLIENT_NOT_FOUND', 404);
  const permanentTcode = normalizeTransportTCodeServer(currentClient.tcode || '');
  if (!permanentTcode) fail('DISPATCH_CLIENT_TCODE_MISSING', 409);

  const { data: inspectionRaw, error: inspectionError } = await supabase.rpc('inspect_dispatch_transport_phone', { p_phone: phone });
  if (inspectionError) fail('DISPATCH_PHONE_CHECK_FAILED', 503);
  const inspection = normalizeRpcResult(inspectionRaw);
  const inspectionStatus = String(inspection?.status || '').trim().toUpperCase();
  if (inspectionStatus === 'CONFLICT') fail('TRANSPORT_PHONE_IDENTITY_CONFLICT', 409);
  const candidate = isPlainObject(inspection?.candidate) ? inspection.candidate : null;
  if (candidate?.id && String(candidate.id).toLowerCase() !== clientId) {
    fail('DISPATCH_PHONE_USED_BY_OTHER_CLIENT', 409, { clientId: String(candidate.id), tcode: candidate.tcode || null });
  }
  const activeSummary = isPlainObject(inspection?.active_order) ? inspection.active_order : null;
  if (activeSummary?.id && (!orderId || String(activeSummary.id).toLowerCase() !== orderId)) {
    fail('DISPATCH_PHONE_HAS_OTHER_ACTIVE_ORDER', 409, { orderId: String(activeSummary.id) });
  }

  let currentOrder = null;
  if (orderId) {
    currentOrder = await fetchExactOrder(supabase, orderId);
    if (!currentOrder?.id) fail('DISPATCH_ORDER_NOT_FOUND', 404);
    if (String(currentOrder.client_id || '').toLowerCase() !== clientId) fail('DISPATCH_ORDER_CLIENT_MISMATCH', 409);
  }

  const nowIso = new Date().toISOString();
  const phoneDigits = String(phone || '').replace(/\\D+/g, '');
  const clientPatch = { name, phone, phone_digits: phoneDigits, address, updated_at: nowIso };
  const { data: updatedClient, error: updateClientError } = await supabase
    .from('transport_clients')
    .update(clientPatch)
    .eq('id', clientId)
    .select('id,tcode,name,phone,phone_digits,address,updated_at')
    .maybeSingle();
  if (updateClientError || !updatedClient?.id) fail('DISPATCH_CLIENT_UPDATE_FAILED', 503);

  let updatedOrder = currentOrder;
  if (currentOrder?.id) {
    const oldData = isPlainObject(currentOrder.data) ? currentOrder.data : {};
    const oldClientData = isPlainObject(oldData.client) ? oldData.client : {};
    const nextData = {
      ...oldData,
      client_name: name,
      client_phone: phone,
      phone_digits: phoneDigits,
      address,
      pickup_address: address,
      client: {
        ...oldClientData,
        id: clientId,
        tcode: permanentTcode,
        code: permanentTcode,
        client_tcode: permanentTcode,
        transport_client_tcode: permanentTcode,
        name,
        phone,
        phone_digits: phoneDigits,
        address,
      },
      dispatch_boss_edit: {
        at: nowIso,
        by_id: String(authUser.id),
        by_pin: String(authUser.pin),
        by_name: cleanText(authUser.name || actorRole, 160),
        by_role: actorRole,
        fields: ['name', 'phone', 'address'],
      },
    };
    const { data: savedOrder, error: orderError } = await supabase
      .from('transport_orders')
      .update({ client_name: name, client_phone: phone, data: nextData, updated_at: nowIso })
      .eq('id', orderId)
      .select('*')
      .maybeSingle();
    if (orderError || !savedOrder?.id) {
      await supabase.from('transport_clients').update({
        name: currentClient.name,
        phone: currentClient.phone,
        phone_digits: currentClient.phone_digits,
        address: currentClient.address,
        updated_at: currentClient.updated_at || nowIso,
      }).eq('id', clientId);
      fail('DISPATCH_ORDER_CLIENT_EDIT_FAILED', 503);
    }
    updatedOrder = savedOrder;
  }

  return { ok: true, marker: '${MARKER}', client: updatedClient, order: updatedOrder };
}

${anchor}`;
  source = replaceOnce(source, anchor, fn, 'DISPATCH_SERVER_EDIT_FUNCTION');
  fs.writeFileSync(path, source, 'utf8');
}

function patchApi() {
  const path = 'api/transport/order.js';
  let source = fs.readFileSync(path, 'utf8');
  if (!source.includes('editDispatchTransportClientServer')) {
    source = replaceOnce(
      source,
      '  inspectDispatchTransportPhoneServer,\n} from \'../../lib/transport/dispatchOrderServer.js\';',
      '  inspectDispatchTransportPhoneServer,\n  editDispatchTransportClientServer,\n} from \'../../lib/transport/dispatchOrderServer.js\';',
      'DISPATCH_API_IMPORT',
    );
  }
  if (!source.includes("action === 'CLIENT_ADMIN_EDIT'")) {
    const anchor = `    if (action === 'PHONE_CHECK') {\n      return apiOk(res, await inspectDispatchTransportPhoneServer(body, { supabase, authUser }));\n    }`;
    const replacement = `${anchor}\n    if (action === 'CLIENT_ADMIN_EDIT') {\n      return apiOk(res, await editDispatchTransportClientServer(body, { supabase, authUser }));\n    }`;
    source = replaceOnce(source, anchor, replacement, 'DISPATCH_API_ACTION');
  }
  fs.writeFileSync(path, source, 'utf8');
}

function patchClientDb() {
  const path = 'lib/transport/transportDb.js';
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes('editDispatchTransportClientViaApi')) return;
  const anchor = 'function ensureTransportClientSearchCode(payload = {}, { tcode = \'\', name = \'\', phoneDigits = \'\' } = {}) {';
  const helper = `export async function editDispatchTransportClientViaApi(input = {}, options = {}) {
  // ${MARKER}: server-authoritative client/order identity edit for Dispatch/Boss.
  const timeoutMs = Math.max(Number(options?.timeoutMs || 0) || 0, 15000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetch('/api/transport/order', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      signal: controller?.signal,
      body: JSON.stringify({
        action: 'CLIENT_ADMIN_EDIT',
        client_id: input.clientId || input.client_id,
        order_id: input.orderId || input.order_id,
        name: input.name,
        phone: input.phone,
        address: input.address,
      }),
    });
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'DISPATCH_CLIENT_EDIT_TIMEOUT' : 'DISPATCH_CLIENT_EDIT_NETWORK_FAILED';
    throw Object.assign(new Error(code), { code, cause: error });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok || body?.ok !== true) {
    const code = String(body?.error || 'DISPATCH_CLIENT_EDIT_FAILED');
    throw Object.assign(new Error(code), { code, httpStatus: Number(response.status) || 0, detail: body });
  }
  return body;
}

${anchor}`;
  source = replaceOnce(source, anchor, helper, 'DISPATCH_CLIENT_DB_HELPER');
  fs.writeFileSync(path, source, 'utf8');
}

function patchDispatchPage() {
  const path = 'app/dispatch/page.jsx';
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(MARKER)) return;

  source = replaceOnce(
    source,
    'import { findTransportClientByPhoneOnly, inspectDispatchTransportPhoneViaApi, insertTransportOrder, isValidTransportPhoneDigits, normTCode, normalizeTransportPhoneKey, sameTransportPhoneDigits } from "@/lib/transport/transportDb";',
    'import { editDispatchTransportClientViaApi, findTransportClientByPhoneOnly, inspectDispatchTransportPhoneViaApi, insertTransportOrder, isValidTransportPhoneDigits, normTCode, normalizeTransportPhoneKey, sameTransportPhoneDigits } from "@/lib/transport/transportDb";',
    'DISPATCH_PAGE_IMPORT',
  );

  source = replaceOnce(
    source,
    '  const [editPickupMeasurements, setEditPickupMeasurements] = useState("");',
    `  const [editPickupMeasurements, setEditPickupMeasurements] = useState("");\n  const [editClientName, setEditClientName] = useState("");\n  const [editClientPhone, setEditClientPhone] = useState("");\n  const [editClientAddress, setEditClientAddress] = useState(""); // ${MARKER}`,
    'DISPATCH_PAGE_EDIT_STATE',
  );

  source = replaceOnce(
    source,
    '    setEditPickupMeasurements(formatDispatchPickupPlanForInput(row));\n    setSmartMessageLabel("COPY PËR KLIENT");',
    '    setEditPickupMeasurements(formatDispatchPickupPlanForInput(row));\n    setEditClientName(getClientName(row));\n    setEditClientPhone(getClientPhone(row));\n    setEditClientAddress(getAddress(row));\n    setSmartMessageLabel("COPY PËR KLIENT");',
    'DISPATCH_PAGE_OPEN_ROW',
  );

  source = replaceOnce(
    source,
    '      const pickedDriverPin = s(pickedDriver?.pin || pickedDriver?.user_pin);\n      const nextPickupPlan = buildDispatchPickupPlan',
    `      const pickedDriverPin = s(pickedDriver?.pin || pickedDriver?.user_pin);\n      const bossClientName = s(editClientName || getClientName(selectedRow));\n      const bossClientPhone = onlyDigits(editClientPhone || getClientPhone(selectedRow));\n      const bossClientPhoneKey = getDispatchPhoneDigits(bossClientPhone);\n      const bossClientAddress = s(editClientAddress);\n      if (!bossClientName) throw new Error('EMRI I KLIENTIT MUNGON.');\n      if (!isValidTransportPhoneDigits(bossClientPhoneKey)) throw new Error('TELEFONI NUK ËSHTË VALID.');\n      if (rowTable === 'transport_orders') {\n        const bossClientId = getTransportClientId(selectedRow);\n        if (!bossClientId) throw new Error('CLIENT ID MUNGON — NUK U BË EDITIMI.');\n        await editDispatchTransportClientViaApi({\n          clientId: bossClientId,\n          orderId: selectedRow.id,\n          name: bossClientName,\n          phone: bossClientPhone,\n          address: bossClientAddress,\n        }, { timeoutMs: 18000 });\n      }\n      const nextPickupPlan = buildDispatchPickupPlan`,
    'DISPATCH_PAGE_SAVE_IDENTITY',
  );

  source = replaceOnce(
    source,
    '        ...(selectedRow.data || {}),\n        note: s(editNote),',
    `        ...(selectedRow.data || {}),\n        client_name: bossClientName,\n        client_phone: bossClientPhone,\n        phone_digits: bossClientPhoneKey,\n        address: bossClientAddress,\n        pickup_address: bossClientAddress,\n        client: {\n          ...((selectedRow?.data?.client && typeof selectedRow.data.client === 'object') ? selectedRow.data.client : {}),\n          name: bossClientName,\n          phone: bossClientPhone,\n          phone_digits: bossClientPhoneKey,\n          address: bossClientAddress,\n        },\n        note: s(editNote),`,
    'DISPATCH_PAGE_NEXT_DATA',
  );

  source = replaceOnce(
    source,
    '      if (assignedClientTcode) planPatch.client_tcode = assignedClientTcode;\n      if (nextStatus) planPatch.status = nextStatus;',
    `      if (assignedClientTcode) planPatch.client_tcode = assignedClientTcode;\n      if (rowTable === 'transport_orders') {\n        planPatch.client_name = bossClientName;\n        planPatch.client_phone = bossClientPhone;\n      }\n      if (nextStatus) planPatch.status = nextStatus;`,
    'DISPATCH_PAGE_PLAN_PATCH',
  );

  source = replaceOnce(
    source,
    '                <button type="button" style={ui.actionBtnDisabled} disabled>EDITO ADRESËN</button>',
    '                <button type="button" style={ui.actionBtn} onClick={() => document.getElementById("dispatch-boss-edit-address")?.focus()}>EDITO KLIENTIN / ADRESËN</button>',
    'DISPATCH_PAGE_EDIT_ACTION',
  );

  const driverSectionAnchor = `            <div style={ui.updateSection}>\n              <div style={ui.sectionTitle}>LIROJA TRANSPORTUESIT</div>`;
  const bossSection = `            <div style={ui.updateSection}>\n              <div style={ui.sectionTitle}>DISPATCH ADMIN / BOSS — EDITO KLIENTIN</div>\n              <div style={ui.sectionHint}>Ky Dispatch ka të drejta operative admin. T-code mbetet permanent. Emri, telefoni dhe adresa ruhen në klient dhe në këtë vizitë.</div>\n              <div style={ui.row2}>\n                <div style={ui.field}>\n                  <div style={ui.label}>EMRI</div>\n                  <input style={ui.input} value={editClientName} onChange={(e) => setEditClientName(e.target.value)} placeholder="EMRI I KLIENTIT" />\n                </div>\n                <div style={ui.field}>\n                  <div style={ui.label}>TELEFONI</div>\n                  <input style={ui.input} value={editClientPhone} onChange={(e) => setEditClientPhone(e.target.value)} inputMode="tel" placeholder="+383..." />\n                </div>\n              </div>\n              <div style={ui.field}>\n                <div style={ui.label}>ADRESA E KËSAJ VIZITE / KLIENTIT</div>\n                <input id="dispatch-boss-edit-address" style={ui.input} value={editClientAddress} onChange={(e) => setEditClientAddress(e.target.value)} placeholder="RRUGA / LAGJJA / BANESA E RE" />\n              </div>\n            </div>\n\n${driverSectionAnchor}`;
  source = replaceOnce(source, driverSectionAnchor, bossSection, 'DISPATCH_PAGE_BOSS_SECTION');

  const existingButtonsAnchor = `              <button type="button" style={ui.btnGhostMini} onClick={() => applySuggestion(phoneHit, { keepPhoneHit: true, confirmExisting: true })}>PËRDOR KODIN {getTransportTCode(phoneHit) || "EKZISTUES"}</button>\n              <button type="button" style={ui.btnGhostMini} onClick={() => { setPhone(""); setPhoneHit(null); setExistingClientDecision(null); }}>KTHEHU / NDËRRO NUMRIN</button>`;
  const existingButtonsReplacement = `              <button type="button" style={ui.btnGhostMini} onClick={() => applySuggestion(phoneHit, { keepPhoneHit: true, confirmExisting: true })}>PËRDOR KODIN {getTransportTCode(phoneHit) || "EKZISTUES"}</button>\n              <button type="button" style={ui.btnGhostMini} onClick={() => {\n                applySuggestion(phoneHit, { keepPhoneHit: true, confirmExisting: true });\n                const phoneKey = getDispatchPhoneDigits(phone);\n                autoAddressRef.current = { phoneKey, address: '' };\n                addressRef.current = '';\n                setAddress('');\n              }}>PËRDOR {getTransportTCode(phoneHit) || "KODIN"} + ADRESË TJETËR</button>\n              <button type="button" style={ui.btnGhostMini} onClick={() => { setPhone(""); setPhoneHit(null); setExistingClientDecision(null); }}>KTHEHU / NDËRRO NUMRIN</button>`;
  source = replaceOnce(source, existingButtonsAnchor, existingButtonsReplacement, 'DISPATCH_PAGE_EXISTING_ADDRESS');

  if (!source.includes(MARKER) || !source.includes('PËRDOR {getTransportTCode(phoneHit) || "KODIN"} + ADRESË TJETËR')) {
    throw new Error('DISPATCH_BOSS_PAGE_VERIFY_FAILED');
  }
  fs.writeFileSync(path, source, 'utf8');
}

function bumpIdentity() {
  const pkgPath = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = appendTag(pkg.version);
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  let epoch = fs.readFileSync('lib/appEpoch.js', 'utf8');
  epoch = epoch.replace(/(export const APP_VERSION = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  epoch = epoch.replace(/(export const GATI_RACK_SAVE_BUILD = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  fs.writeFileSync('lib/appEpoch.js', epoch, 'utf8');

  let index = fs.readFileSync('index.html', 'utf8');
  index = index.replace(/(<meta name="tepiha-build-id" content=")([^"]+)(" \/>)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  index = index.replace(/(window\.__TEPIHA_BUILD_ID = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  fs.writeFileSync('index.html', index, 'utf8');

  let sw = fs.readFileSync('public/sw.js', 'utf8');
  sw = sw.replace(/(const APP_VERSION = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  fs.writeFileSync('public/sw.js', sw, 'utf8');

  let vite = fs.readFileSync('vite.config.js', 'utf8');
  vite = vite.replace(/(cacheName:\s*'tepiha-vite-(?:business-routes|static-assets|media)-)([^']+)(')/g, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  fs.writeFileSync('vite.config.js', vite, 'utf8');
}

patchServer();
patchApi();
patchClientDb();
patchDispatchPage();
bumpIdentity();

for (const [path, marker] of [
  ['app/dispatch/page.jsx', MARKER],
  ['lib/transport/dispatchOrderServer.js', MARKER],
  ['lib/transport/transportDb.js', MARKER],
]) {
  if (!fs.readFileSync(path, 'utf8').includes(marker)) throw new Error(`DISPATCH_BOSS_MARKER_MISSING:${path}`);
}
if (!fs.readFileSync('api/transport/order.js', 'utf8').includes("action === 'CLIENT_ADMIN_EDIT'")) throw new Error('DISPATCH_BOSS_API_ACTION_MISSING');
console.log('PASS Dispatch Boss Controls V1: full client edit, per-visit address change, server-authoritative phone safety, audit trail and permanent T-code preservation.');
