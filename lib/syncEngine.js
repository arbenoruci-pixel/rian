// lib/syncEngine.js
import { getPendingOps, deleteOp, setMeta } from "./offlineStore";
import { supabase } from "@/lib/supabaseClient";

let syncing = false;

async function execOp(op){
  const type = op?.type;
  const payload = op?.payload || {};

  if(type === "upsert_client"){
    const phone = String(payload.phone || "").trim();
    if(!phone) return { ok:false, error:"MISSING_PHONE" };

    // keep existing code if phone exists; only refresh names/photo
    const { data: existing, error: selErr } = await supabase
      .from("clients")
      .select("id, code, phone")
      .eq("phone", phone)
      .maybeSingle();
    if (selErr) throw selErr;

    if (existing?.id){
      const patch = {
        updated_at: new Date().toISOString(),
        full_name: payload.full_name || null,
        first_name: payload.first_name || null,
        last_name: payload.last_name || null,
        photo_url: payload.photo_url || null,
      };
      const { error } = await supabase.from("clients").update(patch).eq("id", existing.id);
      if (error) throw error;
      return { ok:true, id: existing.id };
    }

    // insert new
    const row = { ...payload, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from("clients").insert(row).select("id").single();
    if (error) throw error;
    return { ok:true, id: data?.id };
  }

  if(type === "insert_order"){
    // Insert a NEW order every time (same as ordersDb.js)
    const { error } = await supabase.from("orders").insert(payload);
    if (error) throw error;
    return { ok:true };
  }

  if(type === "set_status"){
    const { id, status, ...rest } = payload;
    if(!id) throw new Error("MISSING_ID");
    const { error } = await supabase.from("orders").update({ status, ...rest }).eq("id", id);
    if (error) throw error;
    return { ok:true };
  }

  if(type === "add_payment"){
    const { error } = await supabase.from("payments").insert(payload);
    if (error) throw error;
    return { ok:true };
  }

  // unknown type => treat as done to avoid blocking forever
  return { ok:true, skipped:true };
}

export async function runSync(){
  if(syncing) return;
  if(typeof navigator !== "undefined" && !navigator.onLine) return;

  syncing = true;
  try{
    const ops = await getPendingOps();
    ops.sort((a,b)=>(a.created_at||0)-(b.created_at||0));

    for(const op of ops){
      try{
        await execOp(op);
        await deleteOp(op.op_id);
      }catch(e){
        // keep op, retry later
        console.warn("[SYNC] op failed, will retry", op?.type, e?.message || e);
        break;
      }
    }

    await setMeta("last_sync_at", Date.now());
  } finally{
    syncing = false;
  }
}
