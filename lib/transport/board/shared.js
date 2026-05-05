// Shared helpers for Transport Board modules
import { normalizePhoneForWhatsApp, canonicalizePhone } from '../../smartSms';


export function onlyDigits(v) { return String(v ?? "").replace(/\D/g, ""); }
export function getTid(session) { return session?.transport_id ? String(session.transport_id) : null; }
export function getCode(row) {
  const linked = String(
    row?.data?.linked_display_code ||
    row?.data?.dispatch_attached_code ||
    row?.data?.linked_transport_tcode ||
    (row?.data?.linked_client_code ? `#${String(row.data.linked_client_code).replace(/^#+/, '')}` : '') ||
    ''
  ).trim();
  if (linked) return linked;
  return String(row?.client_tcode || row?.code || row?.code_str || row?.order_code || "").trim();
}
export function getName(item) {
  const n = item?.client_name || item?.data?.client?.name || item?.data?.client_name || item?.data?.name || 'Pa emër';
  return String(n).length > 22 ? String(n).substring(0, 21) + '...' : String(n);
}
export function getPhone(item) {
  const raw = item?.client_phone || item?.data?.client_phone || item?.data?.client?.phone || item?.data?.phone || item?.phone || '';
  return normalizePhoneForWhatsApp(raw);
}
export function getAddress(item) { return (item?.data?.client?.address || item?.pickup_address || item?.address || item?.data?.address || item?.data?.pickup_address || 'Pa adresë'); }
export function getTotals(row) {
  const d = row?.data || row?.order || row || {};
  const rowTotal = Number(row?.total ?? row?.price_total ?? row?.amount ?? 0);
  let pieces = Number(row?.pieces ?? row?.cope ?? d?.pieces ?? d?.cope ?? d?.copë ?? 0);
  let m2 = Number(row?.m2_total ?? row?.m2 ?? d?.m2_total ?? d?.m2 ?? d?.total_m2 ?? d?.pay?.m2 ?? d?.totals?.m2 ?? 0);
  let total = Number(
    rowTotal ||
    d?.total ||
    d?.sum ||
    d?.amount ||
    d?.pay?.euro ||
    d?.totals?.grandTotal ||
    d?.totals?.grand_total ||
    d?.totals?.total ||
    0
  );
  if (pieces === 0) {
    const tQty = Array.isArray(d.tepiha) ? d.tepiha.reduce((acc, r) => acc + (Number(r.qty ?? r.pieces ?? r.count ?? 1) || 0), 0) : 0;
    const sQty = Array.isArray(d.staza) ? d.staza.reduce((acc, r) => acc + (Number(r.qty ?? r.pieces ?? r.count ?? 1) || 0), 0) : 0;
    const shQty = Array.isArray(d.shkallore)
      ? d.shkallore.reduce((acc, r) => acc + (Number(r.qty ?? r.pieces ?? r.count ?? 1) || 0), 0)
      : Number(d.shkallore?.qty || d.shkallore?.pieces || d.shkallore_count || 0);
    pieces = tQty + sQty + shQty;
  }
  if (m2 === 0) {
    const sumM2 = (list) => Array.isArray(list) ? list.reduce((acc, r) => acc + (Number(r.m2 ?? r.area ?? r.total_m2 ?? r.value ?? 0) * (Number(r.qty ?? 1) || 1)), 0) : 0;
    m2 = sumM2(d.tepiha) + sumM2(d.staza);
    if (!m2 && d.shkallore) m2 = Number(d.shkallore?.m2 || d.shkallore?.total_m2 || 0);
  }
  return { pieces, m2, total };
}
export function money(n) { return Number(n || 0).toFixed(0); }
export function formatTime(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  const now = new Date();
  if (d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}
export function pickLatLng(row) {
  const d = row?.data || row?.order || row || {};
  const lat = Number(d?.gps_lat ?? d?.lat ?? d?.latitude ?? row?.gps_lat ?? row?.lat ?? row?.latitude);
  const lng = Number(d?.gps_lng ?? d?.lng ?? d?.lon ?? d?.longitude ?? row?.gps_lng ?? row?.lng ?? row?.lon ?? row?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}
export function haversine(a, b) {
  if (!a || !b) return 999999;
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const q = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(q)));
}

// Actions
export function openMap(row) {
  const ll = pickLatLng(row);
  if (ll) window.open(`http://googleusercontent.com/maps.google.com/maps?q=${ll.lat},${ll.lng}`, '_blank');
  else {
    const addr = getAddress(row);
    if (addr) window.open(`http://googleusercontent.com/maps.google.com/maps?q=${encodeURIComponent(addr)}`, '_blank');
    else alert("S'ka GPS as Adresë.");
  }
}
export function callClient(row) {
  const ph = getPhone(row);
  if (ph) window.open(`tel:${canonicalizePhone(ph)}`, '_self');
  else alert("S'ka numër.");
}
export function sendMsg(row, type) {
  const ph = getPhone(row);
  if (!ph) return alert("S'ka numër.");
  const t = getTotals(row);

  const name = getName(row);
  let text = "";

  if (type === "gati") {
    text = `Pershendetje ${name}, Tepihat jane gati (${t.pieces} cope). Totali: ${money(t.total)}€. Konfirmo nese jeni ne shtepi?`;
  } else if (type === "eta30") {
    text = `Pershendetje ${name}, jam nis me tepiha. Arrij per rreth 30 min. Te lutna dil me i pranu.`;
  } else if (type === "eta20") {
    text = `Pershendetje ${name}, arrij per rreth 20 min. Te lutna dil me i pranu tepiha.`;
  } else if (type === "eta10") {
    text = `Pershendetje ${name}, arrij per rreth 10 min. Jam afer. Te lutna dil me i pranu.`;
  } else if (type === "door") {
    text = `Pershendetje ${name}, jam tek dera. A mundeni me dale me i pranu tepiha?`;
  } else if (type === "delivery") {
    text = `Pershendetje ${name}, jam nis me tepiha. A jeni ne shtepi?`;
  } else if (type === "wait5") {
    text = `Pershendetje ${name}, jam ketu. Po pres 5 min. Ju lutem me lajmroni.`;
  } else if (type === "wait10") {
    text = `Pershendetje ${name}, jam ketu. Po pres 10 min. Ju lutem me lajmroni.`;
  } else if (type === "noshow") {
    text = `Pershendetje ${name}, s'po muj me ju gjet / s'po pergjigjeni. Po e kthej porosine dhe e riplanifikojme. Ju lutem me shkruani kur jeni gati.`;
  } else {
    text = `Pershendetje ${name}, a jeni ne shtepi?`;
  }

  window.open(`https://wa.me/${ph}?text=${encodeURIComponent(text)}`, "_blank");
}
