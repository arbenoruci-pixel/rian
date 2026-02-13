import { NextResponse } from "next/server";

let supabaseAdmin = null;
try{
  // your project has lib/supabaseAdminClient.js (or similar)
  // If import fails, route still responds ok:false
  // eslint-disable-next-line import/no-unresolved
  supabaseAdmin = (await import("@/lib/supabaseAdminClient")).default;
}catch(e){
  supabaseAdmin = null;
}

export async function POST(req){
  try{
    const op = await req.json();

    // If no admin client, do not hard crash
    if(!supabaseAdmin){
      return NextResponse.json({ ok:false, error:"SUPABASE_ADMIN_NOT_AVAILABLE" }, { status: 200 });
    }

    const type = op?.type;
    const payload = op?.payload || {};

    if(type === "save_order"){
      // upsert by id (or code_n if your table uses it). Adjust table name if needed.
      const { error } = await supabaseAdmin
        .from("orders")
        .upsert(payload, { onConflict: "id" });

      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true });
    }

    if(type === "set_status"){
      const { id, status, ...rest } = payload;
      const { error } = await supabaseAdmin
        .from("orders")
        .update({ status, ...rest })
        .eq("id", id);

      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true });
    }

    if(type === "add_payment"){
      // Recommended: store payments in ledger table "payments". Change if your schema differs.
      const { error } = await supabaseAdmin.from("payments").insert(payload);
      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true });
    }

    return NextResponse.json({ ok:false, error:"UNKNOWN_OP_TYPE" }, { status: 200 });
  }catch(e){
    return NextResponse.json({ ok:false, error: String(e?.message || e) }, { status: 200 });
  }
}
