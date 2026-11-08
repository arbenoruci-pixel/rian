import { createHash } from 'node:crypto';
import { isBujar, canReviewBonusEvidence } from './baseBonusEvidence.js';
import { CONTROL_BUCKET, CONTROL_MAX_BYTES, validateControlRows, measurementSnapshot, controlRows, controlTotals } from './transportControl.js';
export class ControlError extends Error { constructor(code,status=400) { super(code); this.code=code; this.httpStatus=status; } }
const fail=(code,status)=>{throw new ControlError(code,status)};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields='id,order_id,worker_id,status,attempt_id,original_snapshot,proposed_rows,physical_count,note,created_at,submitted_at,reviewed_at,review_note,files_deleted_at';
async function checked(query) { const r=await query; if(r.error) fail('CONTROL_READ_FAILED',503);return r.data; }
async function rpc(s,name,args){const {data,error}=await s.rpc(name,args);if(error)fail(/^CONTROL_[A-Z_]+$/.test(error.message)?error.message:'CONTROL_SAVE_FAILED',409);return data;}
async function row(s,id){if(!uuid.test(id||''))fail('CONTROL_NOT_FOUND',404);const r=await checked(s.from('transport_controls').select('*').eq('id',id).maybeSingle());if(!r)fail('CONTROL_NOT_FOUND',404);return r;}
async function pages(makeQuery){let all=[];for(let start=0;;start+=500){const rows=await checked(makeQuery().range(start,start+499));all.push(...rows);if(rows.length<500)return all;}}
export async function inspectControlPhoto(s,path){
 const {data,error}=await s.storage.from(CONTROL_BUCKET).download(path);
 if(error||!data)fail('CONTROL_PHOTOS_REQUIRED');if(data.size<100||data.size>CONTROL_MAX_BYTES)fail('CONTROL_PHOTO_INVALID');
 const bytes=Buffer.from(await data.arrayBuffer());if(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217)fail('CONTROL_PHOTO_INVALID');
 return createHash('sha256').update(bytes).digest('hex');
}
function safeOrder(o){const rows=controlRows(o.data);return {id:o.id,code:o.code_str,client:o.client_name,status:o.status,visit:o.visit_nr,createdAt:o.created_at,driver:o.data?.brought_by_name||o.data?.driver_name||o.data?.transport_name||'',snapshot:measurementSnapshot(o.data),rows,totals:controlTotals(rows,Number(o.data?.pay?.rate??1.8))};}
export async function controlAction(body,{supabase:s,actor}){
 if(!actor?.id||actor.is_active===false||(!isBujar(actor)&&!canReviewBonusEvidence(actor)))fail('CONTROL_FORBIDDEN',403);
 if(body.expectedActorId!==actor.id)fail('CONTROL_SESSION_CHANGED',403);
 if(body.action==='LIST'){
  const [orders,open,recent,bonuses]=await Promise.all([
   pages(()=>s.from('transport_orders').select('id,code_str,client_name,status,visit_nr,created_at,data').in('status',['pastrim','gati']).order('created_at')),
   pages(()=>s.from('transport_controls').select(fields).neq('status','APPROVED').order('created_at')),
   checked(s.from('transport_controls').select(fields).eq('status','APPROVED').order('reviewed_at',{ascending:false}).limit(60)),
   pages(()=>s.from('base_ready_bonuses').select('id,transport_control_id,amount,remaining_amount,reserved_amount,retained_amount,ready_at,status').not('transport_control_id','is',null).order('id'))
  ]);
  const activeChecks=[];
  for(let i=0;i<orders.length;i+=100)activeChecks.push(...await checked(s.from('transport_controls').select(fields).in('order_id',orders.slice(i,i+100).map(o=>o.id))));
  const controls=[...new Map([...open,...recent,...activeChecks].map(c=>[c.id,c])).values()];
  const ids=controls.map(c=>c.order_id).filter(id=>!orders.some(o=>o.id===id));
  // Lookup historical names in bounded batches, without hiding any active task.
  for(let i=0;i<ids.length;i+=100) orders.push(...await checked(s.from('transport_orders').select('id,code_str,client_name,status,visit_nr,created_at,data').in('id',ids.slice(i,i+100))));
  return {manager:canReviewBonusEvidence(actor),orders:orders.map(safeOrder),controls,bonuses,serverNow:new Date().toISOString()};
 }
 if(body.action==='PREPARE'){
  if(!isBujar(actor))fail('CONTROL_BUJAR_ONLY',403);
  if(!uuid.test(body.orderId||'')||!uuid.test(body.attemptId||''))fail('CONTROL_ORDER_NOT_FOUND');
  let rows;try{rows=validateControlRows(body.rows);}catch(e){fail(e.message);}
  if(!Number.isInteger(body.count)||body.count!==controlTotals(rows).pieces)fail('CONTROL_COUNT_MISMATCH');
  if(!Array.isArray(body.hashes)||body.hashes.length<1||body.hashes.length>6||body.hashes.some(h=>!/^[a-f0-9]{64}$/.test(h))||new Set(body.hashes).size!==body.hashes.length)fail('CONTROL_PHOTOS_REQUIRED');
  const request=await rpc(s,'transport_control_prepare_v1',{p_order_id:body.orderId,p_actor_id:actor.id,p_attempt_id:body.attemptId,p_expected:body.snapshot,p_rows:rows,p_count:body.count,p_note:String(body.note||'').trim().slice(0,500),p_hashes:body.hashes});
  if(request.status!=='DRAFT')return {request,uploads:[]};
  const uploads=[];
  for(const photo of request.photos){
   const existing=await s.storage.from(CONTROL_BUCKET).info(photo.path);
   if(!existing.error&&existing.data){if(await inspectControlPhoto(s,photo.path)!==photo.hash)fail('CONTROL_FILES_CHANGED',409);uploads.push({...photo,exists:true});continue;}
   const {data,error}=await s.storage.from(CONTROL_BUCKET).createSignedUploadUrl(photo.path,{upsert:false});
   if(error||!data?.token)fail('CONTROL_UPLOAD_UNAVAILABLE',503);uploads.push({...photo,token:data.token});
  }
  return {request,uploads};
 }
 const c=await row(s,body.controlId);
 if(!canReviewBonusEvidence(actor)&&c.worker_id!==actor.id)fail('CONTROL_FORBIDDEN',403);
 if(body.action==='VIEW'){
  const images=[];
  if(!c.files_deleted_at)for(const ph of c.photos){
   if(c.status==='DRAFT'){const exists=await s.storage.from(CONTROL_BUCKET).info(ph.path);if(exists.error||!exists.data)continue;}
   const {data,error}=await s.storage.from(CONTROL_BUCKET).createSignedUrl(ph.path,300);if(error||!data?.signedUrl)fail('CONTROL_PREVIEW_FAILED',503);images.push({url:data.signedUrl,hash:ph.hash});
  }
  return {request:c,images};
 }
 if(c.attempt_id!==body.attemptId)fail('CONTROL_ATTEMPT_CHANGED',409);
 if(body.action==='SUBMIT'){
  if(!isBujar(actor))fail('CONTROL_BUJAR_ONLY',403);
  if(c.status==='DRAFT')for(const ph of c.photos)if(await inspectControlPhoto(s,ph.path)!==ph.hash)fail('CONTROL_FILES_CHANGED',409);
  return {request:await rpc(s,'transport_control_submit_v1',{p_control_id:c.id,p_actor_id:actor.id,p_attempt_id:c.attempt_id})};
 }
 if(body.action==='REVIEW'){
  if(!canReviewBonusEvidence(actor)||isBujar(actor))fail('CONTROL_REVIEW_FORBIDDEN',403);
  if(body.decision==='APPROVED'){
   if(body.checkedEvidence!==true)fail('CONTROL_REVIEW_CHECK_REQUIRED');
   if(c.status==='PENDING')for(const ph of c.photos)if(await inspectControlPhoto(s,ph.path)!==ph.hash)fail('CONTROL_FILES_CHANGED',409);
  }
  return {request:await rpc(s,'transport_control_review_v1',{p_control_id:c.id,p_actor_id:actor.id,p_attempt_id:c.attempt_id,p_decision:body.decision,p_note:String(body.note||'').trim().slice(0,500)})};
 }
 fail('CONTROL_ACTION_INVALID');
}
export async function cleanupTransportControlEvidence(s){
 const checks=await checked(s.from('transport_controls').select('id,order_id,worker_id,photos,history,transport_orders!inner(status)').eq('status','APPROVED').eq('transport_orders.status','done').lt('reviewed_at',new Date(Date.now()-2*3600000).toISOString()).is('files_deleted_at',null).order('reviewed_at').limit(100));
 if(!checks.length)return {deleted:0,failed:0};
 const done=await checked(s.from('transport_orders').select('id').in('id',checks.map(c=>c.order_id)).eq('status','done'));
 let deleted=0,failed=0;
 for(const c of checks.filter(c=>done.some(o=>o.id===c.order_id))){
  const paths=[...c.photos,...c.history.flatMap(h=>h.photos||[])].map(ph=>ph.path);
  if(paths.some(path=>!path.startsWith(`${c.worker_id}/${c.id}/`)||!path.endsWith('.jpg'))){failed++;continue;}
  const {error}=await s.storage.from(CONTROL_BUCKET).remove(paths);if(error){failed++;continue;}
  const result=await s.from('transport_controls').update({files_deleted_at:new Date().toISOString()}).eq('id',c.id).eq('status','APPROVED');if(result.error){failed++;continue;}deleted++;
 }
 return {deleted,failed};
}
