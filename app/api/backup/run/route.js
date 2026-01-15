// ✅ Krijo "clients" në formatin që e pret FLETORJA:
// { kodi, emri, telefoni, aktive }

function pickPhone(obj) {
  return String(
    obj.telefoni ??
    obj.phone ??
    obj.tel ??
    obj.client_phone ??
    obj.clientPhone ??
    ""
  ).trim();
}

function pickName(obj) {
  return String(
    obj.emri ??
    obj.name ??
    obj.client_name ??
    obj.clientName ??
    ""
  ).trim();
}

function pickCode(obj) {
  const v = obj.kodi ?? obj.code ?? obj.client_code ?? obj.clientCode ?? obj.nr ?? "";
  const s = String(v).trim();
  return s || "-";
}

function normStatus(s) {
  return String(s || "").toLowerCase().trim();
}

function isActiveStatus(s) {
  const st = normStatus(s);
  return !["dorzim", "dorezim", "delivered", "arkiv", "archived"].includes(st);
}

async function detectClientsTable(sb) {
  for (const t of ["clients", "app_clients"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (!error) return t;
  }
  return null;
}

// ---- brenda POST handler, pasi i ke marrë orders ----

// 1) llogarit AKTIVE prej orders (by phone)
const activeByPhone = new Map();
for (const o of orders || []) {
  const phone = pickPhone(o);
  if (!phone) continue;
  if (!isActiveStatus(o.status)) continue;
  activeByPhone.set(phone, (activeByPhone.get(phone) || 0) + 1);
}

// 2) merr klientat nga tabela clients (nëse ekziston), përndryshe fallback nga orders
let rawClients = [];
let clientsSource = "fallback_from_orders";

const clientsTable = await detectClientsTable(sb);
if (clientsTable) {
  const { data: cdata, error: ce } = await sb
    .from(clientsTable)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20000);

  if (!ce && Array.isArray(cdata)) {
    rawClients = cdata;
    clientsSource = clientsTable;
  }
}

if (!rawClients.length) {
  // fallback: nxjerr klientat unik nga orders
  const seen = new Set();
  for (const o of orders || []) {
    const phone = pickPhone(o);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    rawClients.push(o);
  }
}

// 3) normalizo klientat në formatin e FLETORJA-s
const clients = rawClients.map((c) => {
  const telefoni = pickPhone(c) || "-";
  const emri = pickName(c) || "-";
  const kodi = pickCode(c);
  const aktive = activeByPhone.get(String(telefoni).trim()) || 0;
  return { kodi, emri, telefoni, aktive };
});

// 4) ruaj payload me këtë format
const payload = {
  generated_at: new Date().toISOString(),
  clients_source: clientsSource,
  clients,
  orders: orders || [],
  clients_count: clients.length,
  orders_count: (orders || []).length,
};