const INFO_FOOTER = 'Për info:\nKompania JONI\nTel: +38344735312';
const BASE_CONFIRM_URL = 'https://tepiha.vercel.app/k/';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getOrderContexts(order = {}) {
  const top = isPlainObject(order) ? order : {};
  const fullOrder = isPlainObject(top?.fullOrder) ? top.fullOrder : {};
  const data = isPlainObject(top?.data) ? top.data : {};
  const fullData = isPlainObject(fullOrder?.data) ? fullOrder.data : {};
  return [top, fullOrder, data, fullData];
}

function pickFirstString(order = {}, getters = [], fallback = '') {
  const contexts = getOrderContexts(order);
  for (const getter of getters) {
    for (const ctx of contexts) {
      const raw = String(getter?.(ctx) ?? '').trim();
      if (raw) return raw;
    }
  }
  return fallback;
}

function pickFirstNumber(order = {}, getters = [], fallback = 0) {
  const contexts = getOrderContexts(order);
  let sawZero = false;
  for (const getter of getters) {
    for (const ctx of contexts) {
      const raw = getter?.(ctx);
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (n > 0) return n;
      if (n === 0) sawZero = true;
    }
  }
  return sawZero ? 0 : fallback;
}

function pickFirstArray(order = {}, keys = []) {
  const contexts = getOrderContexts(order);
  for (const key of keys) {
    for (const ctx of contexts) {
      const value = ctx?.[key];
      if (Array.isArray(value) && value.length) return value;
    }
  }
  return [];
}

export function formatDateDDMMYYYY(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function addDays(dateInput, days = 0) {
  const base = dateInput instanceof Date ? new Date(dateInput) : new Date(dateInput || Date.now());
  if (Number.isNaN(base.getTime())) return new Date();
  base.setDate(base.getDate() + Number(days || 0));
  return base;
}

export function extractPieces(order = {}) {
  const tepihaRows = pickFirstArray(order, ['tepiha', 'tepihaRows']);
  const stazaRows = pickFirstArray(order, ['staza', 'stazaRows']);
  const looseRows = (!tepihaRows.length && !stazaRows.length)
    ? pickFirstArray(order, ['rows'])
    : [];

  let totalPieces = 0;
  const sumArray = (arr) => {
    for (const row of arr) {
      const raw = Number(row?.qty ?? row?.pieces ?? row?.count ?? 0);
      if (Number.isFinite(raw) && raw > 0) totalPieces += raw;
    }
  };

  sumArray(tepihaRows);
  sumArray(stazaRows);
  sumArray(looseRows);

  const stairsQty = pickFirstNumber(order, [
    (ctx) => ctx?.shkallore?.qty,
    (ctx) => ctx?.stairsQty,
  ], 0);
  totalPieces += stairsQty;

  if (Number.isFinite(totalPieces) && totalPieces > 0) return totalPieces;

  const directPieces = pickFirstNumber(order, [
    (ctx) => ctx?.copeCount,
    (ctx) => ctx?.piece_count,
    (ctx) => ctx?.totals?.piece_count,
    (ctx) => ctx?.totals?.pieces,
    (ctx) => ctx?.t?.pieces,
    (ctx) => ctx?.pieces,
    (ctx) => ctx?.summary?.pieces,
    (ctx) => ctx?.cope,
    (ctx) => ctx?.copë,
    (ctx) => ctx?.pay?.pieces,
  ], 0);
  if (directPieces > 0) return directPieces;

  const m2ish = pickFirstNumber(order, [
    (ctx) => ctx?.m2_total,
    (ctx) => ctx?.totals?.m2,
    (ctx) => ctx?.m2,
    (ctx) => ctx?.pay?.m2,
  ], 0);
  if (m2ish > 0) return 1;

  return 0;
}

export function extractTotal(order = {}) {
  return pickFirstNumber(order, [
    (ctx) => ctx?.effectiveTotalEuro,
    (ctx) => ctx?.total_euro,
    (ctx) => ctx?.price_total,
    (ctx) => ctx?.total,
    (ctx) => ctx?.pay?.euro,
    (ctx) => ctx?.totals?.total,
    (ctx) => ctx?.totals?.euro,
    (ctx) => ctx?.amount,
  ], 0);
}

export function normalizePhone(phone) {
  return String(phone || '').trim();
}

export function canonicalizePhone(phone, defaultCountryCode = '383') {
  const raw = normalizePhone(phone);
  if (!raw) return '';
  const hadPlus = raw.startsWith('+');
  let digits = raw.replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits) return '';
  if (hadPlus) return `+${digits}`;
  if (digits.startsWith(defaultCountryCode)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${defaultCountryCode}${digits.slice(1)}`;
  return `+${digits}`;
}

export function normalizePhoneForWhatsApp(phone) {
  return canonicalizePhone(phone).replace(/[^\d]/g, '');
}

export function getOrderPublicId(order = {}) {
  const preferred = [
    (ctx) => ctx?.public_id,
    (ctx) => ctx?.publicId,
    (ctx) => ctx?.confirm_id,
    (ctx) => ctx?.confirmId,
    (ctx) => ctx?.client_tcode,
    (ctx) => ctx?.code_str,
    (ctx) => ctx?.t_code,
    (ctx) => ctx?.code,
    (ctx) => ctx?.codeRaw,
    (ctx) => ctx?.normCodeNow,
    (ctx) => ctx?.client?.tcode,
    (ctx) => ctx?.client?.code,
    (ctx) => ctx?.token,
  ];

  for (const getter of preferred) {
    const raw = pickFirstString(order, [getter], '');
    if (!raw) continue;
    const transportMatch = raw.match(/^T\s*-?\s*(\d+)$/i);
    if (transportMatch) return `T${transportMatch[1]}`;
    if (/^\d+$/.test(raw)) return raw;
  }

  return '';
}

function isTransportLikeOrder(order = {}) {
  const candidates = [
    (ctx) => ctx?.client_tcode,
    (ctx) => ctx?.code_str,
    (ctx) => ctx?.t_code,
    (ctx) => ctx?.client?.tcode,
  ];
  return candidates.some((getter) => /^T\d+$/i.test(pickFirstString(order, [getter], '')));
}

function getExactBaseOrderId(order = {}) {
  const candidates = [
    (ctx) => ctx?.id,
    (ctx) => ctx?.db_id,
    (ctx) => ctx?.order_id,
  ];
  for (const getter of candidates) {
    const raw = pickFirstString(order, [getter], '');
    if (!raw) continue;
    if (/^\d+$/.test(raw)) return raw;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;
  }
  return '';
}

export function buildOrderTrackUrl(order = {}) {
  if (isTransportLikeOrder(order)) {
    const publicId = getOrderPublicId(order);
    return publicId ? `${BASE_CONFIRM_URL}${encodeURIComponent(publicId)}?src=transport` : BASE_CONFIRM_URL;
  }

  const publicId = getOrderPublicId(order);
  if (publicId) return `${BASE_CONFIRM_URL}${encodeURIComponent(publicId)}?src=base`;

  const exactId = getExactBaseOrderId(order);
  if (/^\d+$/.test(String(exactId || '').trim())) {
    return `${BASE_CONFIRM_URL}${encodeURIComponent(exactId)}?src=base`;
  }

  return BASE_CONFIRM_URL;
}

export function buildTransportConfirmUrl(order = {}) {
  const publicId = getOrderPublicId(order);
  return publicId ? `${BASE_CONFIRM_URL}${encodeURIComponent(publicId)}?src=transport` : BASE_CONFIRM_URL;
}

function appendFooter(message) {
  return `${String(message || '').trim()}\n\n${INFO_FOOTER}`;
}

export function buildSmartSmsText(order = {}, actionType = '') {
  const action = String(actionType || '').trim();
  const pieces = extractPieces(order);
  const pickupDate = formatDateDDMMYYYY(addDays(new Date(), 2));
  const trackUrl = buildOrderTrackUrl(order);
  const trackText = trackUrl && trackUrl !== BASE_CONFIRM_URL ? `\n\nNdiqni porosinë tuaj live:\n${trackUrl}` : '';

  const clientName = pickFirstString(order, [
    (ctx) => ctx?.client_name,
    (ctx) => ctx?.client?.name,
    (ctx) => ctx?.name,
  ], 'klient');

  const code = pickFirstString(order, [
    (ctx) => ctx?.client_tcode,
    (ctx) => ctx?.code_str,
    (ctx) => ctx?.code,
    (ctx) => ctx?.t_code,
    (ctx) => ctx?.client?.code,
    (ctx) => ctx?.client?.tcode,
  ], '');

  const m2 = Number(pickFirstNumber(order, [
    (ctx) => ctx?.m2_total,
    (ctx) => ctx?.totals?.m2,
    (ctx) => ctx?.pay?.m2,
    (ctx) => ctx?.m2,
  ], 0));

  const total = extractTotal(order);

  if (action === 'pranimi_baze') {
    const liveUrl = buildOrderTrackUrl(order);
    return `Përshëndetje ${clientName !== 'klient' ? clientName : 'klient'},
Tepihat tuaj janë në duar të sigurta! Porosia u pranua dhe procesi i pastrimit profesional ka filluar. 🫧
KODI: ${code || '—'}
SASIA: ${pieces || 0} copë (${m2.toFixed(2)} m²)
TOTALI / BORXHI: ${total.toFixed(2)} €

📍 Ndiqni statusin LIVE: ${liveUrl}

⚠️ Shënim: Për të ruajtur freskinë dhe prej hapësirës së limituar, ju lutemi t'i tërhiqni sapo të njoftoheni që janë gati. Nuk mbajmë përgjegjësi për vonesa të gjata pa lajmërim.
Faleminderit, KOMPANIA JONI ✨`;
  }

  if (action === 'gati_baze') {
    return appendFooter(
      `Përshëndetje ${clientName !== 'klient' ? clientName : ''}, Porosia juaj është GATI (${pieces} copë). Totali: ${total.toFixed(2)}€. Për shkak të hapësirës së kufizuar, nëse nuk i merrni brenda 24 orëve, kompania nuk mban përgjegjësi në rast ngatërrimi apo humbje.${trackText}`
    );
  }

  if (action === 'transport_marrje') {
    return appendFooter(
      `Përshëndetje ${clientName !== 'klient' ? clientName : ''}! Jam shoferi i kompanisë JONI. Jam rrugës për të marrë porosinë tuaj për larjen e tepihave. Ju lutem na ktheni një "Ok" në këtë mesazh që t'ju hapet linku më poshtë për të na konfirmuar lokacionin dhe ndjekur statusin live:\n${trackUrl}`
    );
  }

  if (action === 'transport_konfirmim') {
    return [
      `Përshëndetje ${clientName !== 'klient' ? clientName : ''},`,
      `Tepihat tuaj janë gati dhe brenda 1 ore nisen drejt jush.`,
      ``,
      `⚠️ TË LUTEM KONFIRMO:`,
      `Na kthe përgjigje për të konfirmuar që je në shtëpi. Nëse nuk e konfirmon, porosia NUK ngarkohet në furgon!`,
      ``,
      `KODI: ${code || '—'}`,
      `COPË: ${pieces || 0}`,
      `TOTALI PËR PAGESË: ${total.toFixed(2)} €`,
      ``,
      `RREGULLORJA:`,
      `• Ne tentojmë dërgesën deri 3 herë.`,
      `• Nëse nuk lajmërohesh, duhet të vish t'i marrësh vetë në depo,`,
      `• Ose do të aplikohet tarifë ekstra prej 5 € për t'i risjellë.`,
      `📍 Ndiqni porosinë live:\n${trackUrl}`,
      ``,
      INFO_FOOTER,
    ].join('\n');
  }

  if (action === 'transport_dorzim') {
    return appendFooter(`Përshëndetje ${clientName !== 'klient' ? clientName : ''}, Tepihat tuaj janë pastruar dhe jemi rrugës për t'i sjellë.${trackText}`);
  }

  return appendFooter(String(order?.messageText || order?.message || '').trim() + trackText);
}

export function buildWhatsAppAppLink(phone, messageText) {
  const clean = normalizePhoneForWhatsApp(phone);
  const encoded = encodeURIComponent(String(messageText || '').trim());
  return clean ? `whatsapp://send?phone=${clean}&text=${encoded}` : '';
}

export function buildWhatsAppLink(phone, messageText) {
  const clean = normalizePhoneForWhatsApp(phone);
  const encoded = encodeURIComponent(String(messageText || '').trim());
  return clean ? `https://wa.me/${clean}?text=${encoded}` : '';
}

export function buildViberLink(phone, messageText) {
  const encoded = encodeURIComponent(String(messageText || '').trim());
  return `viber://forward?text=${encoded}`;
}

function smsBodySeparator() {
  try {
    if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(String(navigator.userAgent || ''))) {
      return '&';
    }
  } catch {}
  return '?';
}

export function buildSmsLink(phone, messageText) {
  const clean = canonicalizePhone(phone);
  const encoded = encodeURIComponent(String(messageText || '').trim());
  if (!clean) return '';
  return `sms:${clean}${smsBodySeparator()}body=${encoded}`;
}

export function buildSmartSmsLinks(phone, messageText) {
  return {
    whatsappApp: buildWhatsAppAppLink(phone, messageText),
    whatsapp: buildWhatsAppLink(phone, messageText),
    viber: buildViberLink(phone, messageText),
    sms: buildSmsLink(phone, messageText),
    canonicalPhone: canonicalizePhone(phone),
  };
}

const smartSms = {
  INFO_FOOTER,
  BASE_CONFIRM_URL,
  formatDateDDMMYYYY,
  addDays,
  extractPieces,
  extractTotal,
  normalizePhone,
  canonicalizePhone,
  normalizePhoneForWhatsApp,
  getOrderPublicId,
  buildTransportConfirmUrl,
  buildSmartSmsText,
  buildWhatsAppAppLink,
  buildWhatsAppLink,
  buildViberLink,
  buildSmsLink,
  buildSmartSmsLinks,
};

export default smartSms;
