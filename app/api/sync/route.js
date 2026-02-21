/*
 SYNC ROUTE — CLEAN VERSION
 Fixes applied exactly as requested:

 - Original insert_order logic preserved (NO UPSERT_ORDER)
 - patch_order_data uses UUID (no Number())
 - duplicate set_status block removed
*/

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function POST(req) {
  try {
    const body = await req.json();
    const { type, data, id } = body;

    // ---- INSERT ORDER (ORIGINAL LOGIC KEPT) ----
    if (type === "insert_order") {
      const { error } = await supabase
        .from("orders")
        .insert(data);

      if (error) {
        return NextResponse.json({ ok:false, error:error.message });
      }

      return NextResponse.json({ ok:true, localId: body.localId });
    }

    // ---- PATCH ORDER DATA (UUID SAFE) ----
    if (type === "patch_order_data") {
      const { error } = await supabase
        .from("orders")
        .update(data)
        .eq("id", id); // UUID safe (no Number())

      if (error) {
        return NextResponse.json({ ok:false, error:error.message });
      }

      return NextResponse.json({ ok:true });
    }

    // ---- SET STATUS ----
    if (type === "set_status") {
      const { error } = await supabase
        .from("orders")
        .update({ status: data.status })
        .eq("id", id);

      if (error) {
        return NextResponse.json({ ok:false, error:error.message });
      }

      return NextResponse.json({ ok:true });
    }

    return NextResponse.json({ ok:false, error:"UNKNOWN_OP_TYPE" });

  } catch (e) {
    return NextResponse.json({ ok:false, error:e.message });
  }
}
