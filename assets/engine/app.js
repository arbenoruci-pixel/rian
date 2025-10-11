
// Supabase client (v2 SDK)
const SB = (()=>{
  const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
  const PFX = window.NAMESPACE_PREFIX || 'v2/';
  const B_O = window.BUCKET_ORDERS, B_C = window.BUCKET_CODES, B_CL = window.BUCKET_CLIENTS;

  async function nextCode(){
    try{
      const dl = await sb.storage.from(B_C).download(PFX+'next.json');
      let next=1;
      if(!dl.error&&dl.data){ const txt=await dl.data.text(); next = Number((JSON.parse(txt||'{}').next)||1); if(!Number.isFinite(next)||next<1) next=1; }
      const blob = new Blob([JSON.stringify({next: next+1})], {type:'application/json'});
      await sb.storage.from(B_C).upload(PFX+'next.json', blob, { upsert:true });
      return String(next);
    }catch(e){ console.warn(e); }
    const k='code_counter_num_v2'; const cur=Number(localStorage.getItem(k)||'0')+1; localStorage.setItem(k,String(cur)); return String(cur);
  }

  async function assignCode(o){ if(!o.code){ o.code=await nextCode(); o.code_n=Number(o.code);} return o; }

  async function saveOrder(order){
    order.id ||= uid(); order.updated_at=new Date().toISOString();
    const blob = new Blob([JSON.stringify(order,null,2)], {type:'application/json'});
    const r = await sb.storage.from(B_O).upload(PFX+order.id+'.json', blob, { upsert:true });
    if(r.error) throw r.error; return order.id;
  }

  async function list(status){
    const {data, error} = await sb.storage.from(B_O).list(PFX, {limit:10000});
    if(error) throw error; const out=[];
    for(const f of (data||[])){
      if(!f.name.endsWith('.json')) continue;
      const dl = await sb.storage.from(B_O).download(PFX+f.name);
      if (dl.error) continue;
      try{ const o=JSON.parse(await dl.data.text()); if(!status||o.status===status) out.push(o);}catch(e){}
    }
    out.sort((a,b)=> new Date(b.updated_at||0)-new Date(a.updated_at||0));
    return out;
  }

  async function clientLocks(o){
    const ops=[];
    if(o.phone) ops.push(sb.storage.from(B_CL).upload(PFX+`phone/${encodeURIComponent(o.phone)}.lock`, new Blob(['1']), {upsert:true}));
    if(o.name)  ops.push(sb.storage.from(B_CL).upload(PFX+`name/${encodeURIComponent(o.name)}.lock`,  new Blob(['1']), {upsert:true}));
    await Promise.all(ops);
  }

  const STATUS = {PRANIM:'pranim',PASTRIM:'pastrim',GATI:'gati',DORZIM:'dorzim'};

  return { sb, PFX, assignCode, saveOrder, list, clientLocks, STATUS };
})();

window.Engine = SB;
