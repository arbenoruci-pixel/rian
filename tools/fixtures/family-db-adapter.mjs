// Minimal PostgREST-shaped adapter executing real SQL in the isolated test database.
export function familyDbAdapter(db) {
 const ident = value => { if (!/^[a-z_][a-z_0-9]*$/i.test(value)) throw Error('Invalid SQL identifier'); return `"${value}"`; };
 return {
  async rpc(name, args = {}) {
   try {
    const entries = Object.entries(args);
    const sql = `select ${ident(name)}(${entries.map(([k],i)=>`${ident(k)} := $${i+1}`).join(',')}) as value`;
    const result = await db.query(sql, entries.map(([,v])=>v && typeof v==='object' ? JSON.stringify(v) : v));
    return { data: result.rows[0]?.value, error: null };
   } catch (error) { return { data: null, error }; }
  },
  from(table) {
   let fields='*', single=false, limit=5000, insertion=null; const where=[], values=[], sort=[];
   const q={
    upsert(row,options={}) { insertion={row,options};return q; },
    select(v) { fields=v.split(',').map(x=>x==='*'?'*':ident(x)).join(',');return q; },
    eq(k,v) {values.push(v);where.push(`${ident(k)}=$${values.length}`);return q;},
    is(k,v) {if(v!==null) throw Error('Unsupported test predicate');where.push(`${ident(k)} is null`);return q;},
    in(k,v) {where.push(v.length ? `${ident(k)} in (${v.map(x=>{values.push(x);return '$'+values.length}).join(',')})`:'false');return q;},
    order(k,opts={}) {sort.push(`${ident(k)} ${opts.ascending===false?'desc':'asc'}`);return q;},
    limit(v) {limit=Number(v);return q;},
    maybeSingle() {single=true;return q;},
    then(resolve,reject) {return (async()=>{
     if(insertion) {
      try {
       const entries=Object.entries(insertion.row), conflict=insertion.options.onConflict;
       if(!insertion.options.ignoreDuplicates || !conflict)throw Error('Unsupported test upsert');
       await db.query(`insert into ${ident(table)} (${entries.map(([k])=>ident(k)).join(',')}) values (${entries.map((_,i)=>'$'+(i+1)).join(',')}) on conflict (${ident(conflict)}) do nothing`,entries.map(([,v])=>v));
       return {data:null,error:null};
      } catch(error){return {data:null,error};}
     }
     try {const r=await db.query(`select ${fields} from ${ident(table)}${where.length?' where '+where.join(' and '):''}${sort.length?' order by '+sort.join(','):''} limit ${limit}`,values);return {data:single?r.rows[0]||null:r.rows,error:null};}
     catch(error){return {data:null,error};}
    })().then(resolve,reject);},
   };return q;
  },
 };
}
