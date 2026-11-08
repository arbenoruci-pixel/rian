import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { compressBonusEvidenceImage } from './baseBonusEvidenceClient.js';
import { CONTROL_BUCKET } from './transportControl.js';
export { compressBonusEvidenceImage as compressControlPhoto };
const messages={
 CONTROL_FORBIDDEN:'Kjo mundësi është për Bujarin dhe Dispatch-in.', CONTROL_SESSION_CHANGED:'Sesioni ka ndryshuar. Hape përsëri faqen.',
 CONTROL_ORDER_CHANGED:'Porosia ka ndryshuar. Mbylle kontrollin dhe hape përsëri për të parë regjistrimin e fundit.',
 CONTROL_COUNT_MISMATCH:'Numri i copave duhet të përputhet me listën e kontrolluar.', CONTROL_REASON_REQUIRED:'Shkruaje shkurt arsyen e ndryshimit.',
 CONTROL_PHOTOS_REQUIRED:'Shto foto të qarta me tepihat dhe T-kodin.', CONTROL_DUPLICATE_PHOTO:'Kjo foto është përdorur tashmë. Bëj një foto të re për këtë kontroll.',
 CONTROL_FILES_CHANGED:'Provat nuk përputhen. Hape kontrollin përsëri.', CONTROL_REVIEW_CONFLICT:'Kërkesa është shqyrtuar tashmë. Rifresko listën.',
 CONTROL_PAID_ORDER_REVIEW_REQUIRED:'Ka pagesë të regjistruar. Dispatch duhet ta sqarojë pagesën para ndryshimit të masave.',
 CONTROL_ORDER_NOT_AT_BASE:'Kontrolli bëhet për porositë në pastrim ose gati në bazë.', CONTROL_ATTEMPT_CHANGED:'Është dërguar një version i ri. Hape kontrollin përsëri.',
 CONTROL_MEASUREMENTS_INVALID:'Kontrollo masat dhe numrin e copave.', CONTROL_UPLOAD_UNAVAILABLE:'Fotot nuk mund të ngarkohen tani. Provat mbeten në këtë pajisje.',
};
export async function controlRequest(body){
 if(navigator.onLine===false)throw new Error('Je offline. Provat ruhen në këtë pajisje; dërgoji kur të kthehet interneti.');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55000);
 try{
  const response=await fetch('/api/transport-control',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({...body,expectedActorId:getActor()?.id||getActor()?.user_id||''}),signal:controller.signal});
  const result=await response.json();if(!response.ok||!result.ok)throw new Error(messages[result.error]||`Nuk u krye (${result.error||response.status}). Provo përsëri.`);return result;
 }finally{clearTimeout(timer);}
}
export async function submitControl({order,rows,count,note,files,attemptId,onProgress=()=>{}}){
 const hashes=await Promise.all(files.map(async f=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('')));
 onProgress('Duke ruajtur kontrollin…');
 const prepared=await controlRequest({action:'PREPARE',orderId:order.id,attemptId,snapshot:order.snapshot,rows,count:Number(count),note,hashes});
 if(prepared.request.status!=='DRAFT')return prepared;
 for(const [i,upload] of prepared.uploads.entries()){
  if(upload.exists)continue;onProgress(`Duke dërguar foton ${i+1}/${files.length}…`);
  const {error}=await supabase.storage.from(CONTROL_BUCKET).uploadToSignedUrl(upload.path,upload.token,files[i],{contentType:'image/jpeg',upsert:false});
  if(error)throw new Error('Ngarkimi nuk u konfirmua. Provo përsëri; fotot mbeten të ruajtura.');
 }
 onProgress('Duke dërguar për aprovim…');
 return controlRequest({action:'SUBMIT',controlId:prepared.request.id,attemptId:prepared.request.attempt_id});
}
function openDraftDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open('tepiha-transport-control-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function controlDraft(orderId,mode='read',value){
 const db=await openDraftDb();const actor=getActor();const key=`${actor?.id||actor?.user_id}:${orderId}`;
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('drafts',mode==='read'?'readonly':'readwrite'),store=tx.objectStore('drafts');const req=mode==='read'?store.get(key):mode==='delete'?store.delete(key):store.put(value,key);let result;req.onsuccess=()=>{result=req.result};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
