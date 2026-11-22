import { apiFail, apiOk, createAdminClientOrThrow, readBody } from './_helpers.js';
import { authenticateWorkerBonusActor, WorkerBonusAccountError } from '../lib/workerBonusAccountServer.js';
import { handleMealPolicy, MealPolicyError } from '../lib/mealPolicyServer.js';

export const config = { maxDuration:15 };
export function createMealPolicyHandler({ createClient=createAdminClientOrThrow, authenticate=authenticateWorkerBonusActor, action=handleMealPolicy } = {}) {
  return async (req,res) => {
    res.setHeader('cache-control','private, no-store, max-age=0, must-revalidate');
    res.setHeader('vary','Cookie, Origin');
    res.setHeader('x-content-type-options','nosniff');
    try {
      if(req.method!=='POST'){res.setHeader('allow','POST');return apiFail(res,'METHOD_NOT_ALLOWED',405);}
      const host=String(req.headers?.['x-forwarded-host']||req.headers?.host||'').split(',')[0].trim().toLowerCase();
      let origin;try{origin=new URL(req.headers?.origin||'');}catch{}
      if(!origin||!['https:','http:'].includes(origin.protocol)||origin.host.toLowerCase()!==host||req.headers?.['sec-fetch-site']==='cross-site')return apiFail(res,'ORIGIN_NOT_ALLOWED',403);
      if(String(req.headers?.['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')return apiFail(res,'CONTENT_TYPE_NOT_ALLOWED',415);
      if(Number(req.headers?.['content-length']||0)>2048)return apiFail(res,'MEAL_POLICY_BODY_TOO_LARGE',413);
      const body=await readBody(req);
      if(!body||typeof body!=='object'||Array.isArray(body))return apiFail(res,'MEAL_POLICY_BODY_INVALID',400);
      if(Buffer.byteLength(JSON.stringify(body))>2048)return apiFail(res,'MEAL_POLICY_BODY_TOO_LARGE',413);
      const cookie=String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tepiha_device_id='));
      let deviceId='';try{deviceId=decodeURIComponent(cookie?.slice('tepiha_device_id='.length)||'');}catch{}
      if(!deviceId)return apiFail(res,'AUTH_REQUIRED',401);
      const supabase=createClient();
      const actor=await authenticate(supabase,deviceId);
      return apiOk(res,await action(body,{supabase,actor}));
    }catch(error){
      const known=error instanceof MealPolicyError||error instanceof WorkerBonusAccountError;
      return apiFail(res,known?error.code:'MEAL_POLICY_REQUEST_FAILED',known?error.httpStatus:503);
    }
  };
}
export default createMealPolicyHandler();
