// Shared helpers for Transport Board modules

export function onlyDigits(v) { return String(v ?? "").replace(/\D/g, ""); }
export function getTid(session) { return session?.transport_id ? String(session.transport_id) : null; }
export function getCode(row) { return String(row?.client_tcode || row?.code || row?.code_str || row?.order_code || "").trim(); }
export function getName(row) {
  const n = row?.client_name || row?.name || row?.emri || row?.full_name || row?.data?.client?.name || "Pa Emër";
  return n.length > 22 ? n.substring(0, 21) + "..." : n;
}
export function getPhone(row) { return onlyDigits(row?.client_phone || row?.phone || row?.telefoni || row?.data?.client?.phone || ""); }
export function getAddress(row) { return (row?.address || row?.adresa || row?.pickup_address || row?.data?.address || row?.data?.pickup_address || row?.note || ""); }
export function getTotals(row) {
  const d = row?.data || row?.order || row || {};
  let pieces = Number(d?.pieces ?? d?.cope ?? d?.copë ?? 0);
  let m2 = Number(d?.m2_total ?? d?.m2 ?? d?.total_m2 ?? d?.pay?.m2 ?? 0);
  let total = Number(d?.total ?? d?.sum ?? d?.amount ?? d?.pay?.euro ?? 0);
  if (pieces === 0) {
    const tQty = Array.isArray(d.tepiha) ? d.tepiha.reduce((acc, r) => acc + (Number(r.qty) || 0), 0) : 0;
    const sQty = Array.isArray(d.staza) ? d.staza.reduce((acc, r) => acc + (Number(r.qty) || 0), 0) : 0;
    const shQty = Number(d.shkallore?.qty || 0);
    pieces = tQty + sQty + shQty;
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
  if (ph) window.open(`tel:${ph}`, '_self');
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
