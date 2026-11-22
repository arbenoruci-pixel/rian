import { getActor } from '@/lib/actorSession';
const identity=actor=>`${actor?.id||actor?.user_id||''}:${actor?.pin||''}:${actor?.role||''}`;
const cache=new Map();
const pending=new Map();
const cacheMs=30000;
const elapsedNow=()=>typeof performance!=='undefined'?performance.now():Date.now();
const messages={MEAL_POLICY_FORBIDDEN:'Nuk ke qasje në këtë llogari.',MEAL_POLICY_SESSION_CHANGED:'Llogaria ka ndryshuar. Hape përsëri faqen.',AUTH_REQUIRED:'Hyr përsëri në aplikacion.',DEVICE_NOT_APPROVED:'Pajisja duhet të jetë e aprovuar.'};
const errorFor=(code,status=0)=>Object.assign(new Error(messages[code]||'Rregulli i ushqimit nuk u ngarkua. Provo përsëri.'),{code,httpStatus:status});
async function request(body,actorKey){
  const actor=getActor()||{};
  if(identity(actor)!==actorKey)throw errorFor('MEAL_POLICY_SESSION_CHANGED',403);
  if(typeof navigator!=='undefined'&&navigator.onLine===false)throw errorFor('MEAL_POLICY_OFFLINE');
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch('/api/meal-policy',{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({...body,expectedActorId:actor.id||actor.user_id})});
    const data=await response.json();
    if(!response.ok||!data?.ok){if([401,403].includes(response.status))cache.clear();throw errorFor(data?.error||'MEAL_POLICY_READ_FAILED',response.status);}
    if(identity(getActor())!==actorKey){cache.clear();throw errorFor('MEAL_POLICY_SESSION_CHANGED',403);}
    return data;
  }finally{clearTimeout(timeout);}
}
export async function fetchMealPolicy({scope='own',targetPin,force=false}={}){
  const actorKey=identity(getActor());const key=`${actorKey}:${scope}:${targetPin||''}`;
  const saved=cache.get(key);
  // Do not serve a cached pre-cutoff response across the server-provided activation.
  const expiresAt=(saved?.savedAt||0)+Math.min(cacheMs,saved?.activationDelay??Infinity);
  if(!force&&saved&&elapsedNow()<expiresAt)return saved.value;
  if(pending.has(key))return pending.get(key);
  const promise=request({action:'read',scope,...(targetPin?{targetPin}:{})},actorKey).then(value=>{
    const activationDelay=value.nextActivationAt?Math.max(0,Date.parse(value.nextActivationAt)-Date.parse(value.serverNow)):Infinity;
    cache.set(key,{savedAt:elapsedNow(),activationDelay,value});
    while(cache.size>16)cache.delete(cache.keys().next().value);
    return value;
  });
  pending.set(key,promise);
  try{return await promise;}finally{if(pending.get(key)===promise)pending.delete(key);}
}
export async function acknowledgeMealPolicy(policyKey){
  const data=await request({action:'acknowledge',policyKey},identity(getActor()));
  cache.clear();
  return data;
}
