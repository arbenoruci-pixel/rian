
// PATCH: Transport client snapshot + coords persistence
// Safe patch – does NOT touch BASE modules.
// Makes transport behave like PRANIMI logic:
// - T-code permanent
// - Orders keep client snapshot (name/phone/coords)

import { supabase } from "@/lib/supabaseClient";

async function getClientByTcode(tcode){
  const { data, error } = await supabase
    .from("transport_clients")
    .select("*")
    .eq("tcode", tcode)
    .single();
  if(error) throw error;
  return data;
}

async function getNextVisitNr(tcode){
  const { data, error } = await supabase
    .from("transport_orders")
    .select("visit_nr")
    .eq("client_tcode", tcode)
    .order("visit_nr", { ascending:false })
    .limit(1);

  if(error) throw error;
  const max = (data && data[0] && data[0].visit_nr) ? Number(data[0].visit_nr) : 0;
  return max + 1;
}

// MAIN CREATE ORDER (WITH CLIENT SNAPSHOT)
export async function createNewTransportOrderForClientTcode({
  client_tcode,
  transport_id,
  status = "pickup"
}){

  const tcode = String(client_tcode||"").toUpperCase().trim();
  if(!tcode) throw new Error("MISSING_TCODE");

  // 🔎 fetch full client (name/phone/coords/address)
  const client = await getClientByTcode(tcode);

  const visit_nr = await getNextVisitNr(tcode);

  const payload = {
    client:{
      id: client.id,
      tcode: client.tcode,
      name: client.name || "",
      phone: client.phone || "",
      coords: client.coords || null,
      address: client.address || ""
    }
  };

  const order = {
    client_tcode: tcode,
    visit_nr,
    transport_id: String(transport_id||"").trim(),
    status,
    data: payload
  };

  const { data, error } = await supabase
    .from("transport_orders")
    .insert(order)
    .select("*")
    .single();

  if(error) throw error;
  return data;
}

// OPTIONAL: update client coords when GPS captured
export async function updateClientCoords(tcode, coords){
  if(!coords) return;

  const { error } = await supabase
    .from("transport_clients")
    .update({ coords })
    .eq("tcode", tcode);

  if(error) throw error;
}

// READ ONE (by id)
export async function fetchTransportOrderById(id) {
  const oid = String(id || '').trim();
  if (!oid) throw new Error('MISSING_ID');
  const { data, error } = await supabase
    .from('transport_orders')
    .select('*')
    .eq('id', oid)
    .single();
  if (error) throw error;
  return data;
}

// UPDATE ONE (by id) - safe helper used across Transport modules
export async function updateTransportOrderById(id, patch = {}) {
  const oid = String(id || '').trim();
  if (!oid) throw new Error('MISSING_ID');

  const { data, error } = await supabase
    .from('transport_orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', oid)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

