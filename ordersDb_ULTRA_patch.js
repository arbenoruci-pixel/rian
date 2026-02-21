
// 🔥 ULTRA DB SCAN WRAPPER (AUTO LOGGING)
// Drop this at TOP of lib/ordersDb.js (after imports)

function __docLog(stage, data){
  try{
    const key = "DOC_DB_ULTRA_LOG";
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    arr.push({
      ts:new Date().toISOString(),
      stage,
      data
    });
    localStorage.setItem(key, JSON.stringify(arr.slice(-50)));
  }catch(e){}
}

// Wrap Supabase calls to expose REAL DB errors
async function __safeInsert(supabase, row){
  try{
    const {data,error} = await supabase
      .from("orders")
      .insert([row])
      .select("id,code,created_at")
      .single();

    if(error){
      __docLog("DB_INSERT_ERROR", error);
      throw error;
    }

    __docLog("DB_INSERT_OK", data);
    return data;
  }catch(e){
    __docLog("DB_INSERT_THROW", {message:e?.message,stack:e?.stack});
    throw e;
  }
}
