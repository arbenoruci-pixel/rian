import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFamilyTestDb,seedFamilyDb,ids} from './verify-client-family-db-v1.mjs';
import {familyDbAdapter} from './fixtures/family-db-adapter.mjs';
import {familyAction,signFamilyToken,verifyFamilyToken} from '../lib/clientFamilyServer.js';
import {createFamilyHandler} from '../api/client-family.js';
import {buildClientProfile} from '../lib/clientProfileServer.js';
import {buildClientProfileSmartSmsOrder} from '../lib/clientProfileSmartSms.js';
import {prepareFamilySmartMessage,FAMILY_INVITATION} from '../lib/clientFamilyClient.js';
const db=await createFamilyTestDb();await seedFamilyDb(db);
const supabase=familyDbAdapter(db), secret='isolated-family-test-secret-never-production',authUser={id:ids.staff};
const env={supabase,secret,authUser};
const base={source:'BASE',clientId:ids.a};const b={source:'BASE',clientId:ids.b};
const get=async data=>(await familyAction({action:'GET_FAMILY',...data},env)).family;
const mutate=async(data,fields)=>{const f=await get(data);return familyAction({...data,...fields,expectedRoot:f.rootKey,expectedRevision:f.revision,requestId:randomUUID()},env)};
let n=0;function check(v,label){assert.ok(v,label);n++;console.log('PASS',label);}
const bf=await get(b);await mutate(base,{action:'MERGE',otherKey:bf.rootKey,otherRoot:bf.rootKey,otherRevision:bf.revision});
await mutate(b,{action:'ADD_CONTACTS',contacts:[{name:'Today family contact',phone:'044555666'}]});
const resolved=await familyAction({action:'RESOLVE_PHONE',source:'BASE',phone:'00383 44 555 666'},env);
check(resolved.client.id===ids.a&&resolved.client.phone==='00383 44 555 666'&&resolved.client.master_phone==='+38344111222','phone resolution preserves master identity and submitted visit contact');
let result=await buildClientProfile({...base,orderId:10},env);
check(result.profile.visits.length===2&&result.profile.payments.length===1,'family card contains both exact visits and one payment');
check(result.profile.summary.totalDebt===110,'family debt sums distinct orders without rewriting balances');
check(result.profile.identity.baseClientId===ids.a&&result.profile.visits.find(v=>v.id==='11')?.contactName==='Besnik','anchor identity and individual visit contact are preserved');
await db.query("update orders set client_name='Today family contact',client_phone='044555666' where id=10");
result=await buildClientProfile({...base,orderId:10},env);
const sms=buildClientProfileSmartSmsOrder(result.profile,result.profile.visits.find(v=>v.id==='10'));
check(sms.client_phone==='044555666'&&sms.client_name==='Today family contact','Smart SMS addresses exact visit contact rather than family primary');
const token=(await familyAction({action:'SIGN_LINK',source:'BASE',orderId:10},env)).token;
const info=await familyAction({action:'PUBLIC_INFO',source:'BASE',orderId:'10',token},{supabase,secret});
check(info.codes.length===2&&!JSON.stringify(info).includes('044')&&!('contacts' in info),'public link returns codes but no contact list or finances');
await familyAction({action:'PUBLIC_ADD',source:'BASE',orderId:10,token,requestId:randomUUID(),contacts:[{name:'Public family',phone:'049555111'}]},{supabase,secret});
check((await get(base)).contacts.length===2,'customer addition reaches real SQL transaction');
for(const fields of [{orderId:11},{source:'TRANSPORT'},{token:token.slice(0,-2)+'xx'}]){await assert.rejects(familyAction({action:'PUBLIC_INFO',source:'BASE',orderId:10,token,...fields},{supabase,secret}),/FAMILY_LINK_INVALID/);n++;}
await assert.rejects(familyAction({action:'MERGE',...base},{supabase,secret}),/AUTH_REQUIRED/);n++;
const expired=signFamilyToken({...base,orderId:10},secret,Date.now()-31*24*3600000);assert.throws(()=>verifyFamilyToken(expired,secret),/EXPIRED/);n++;
const handler=createFamilyHandler({createClient:()=>supabase,getSecret:()=>secret,authenticate:async(_,device)=>{if(device!=='test-approved')throw Object.assign(new Error('AUTH_REQUIRED'),{code:'AUTH_REQUIRED',httpStatus:401});return authUser;}});
async function http(body,{method='POST',origin='http://test.local',cookie='tepiha_device_id=test-approved'}={}){let status,value,headers={};await handler({method,headers:{host:'test.local',origin,cookie},body},{setHeader(k,v){headers[k]=v},set statusCode(s){status=s},end(v){value=JSON.parse(v)}});return {status,value,headers};}
check((await http({action:'GET_FAMILY',...base},{cookie:''})).status===401,'staff endpoint requires approved device');
check((await http({action:'GET_FAMILY',...base},{origin:'https://evil.invalid'})).status===403,'cross-origin request is refused');
check((await http({}, {method:'GET'})).status===405,'GET cannot mutate');
check((await http({x:'x'.repeat(17000)})).status===413,'oversized body is refused');
const response=await http({action:'GET_FAMILY',...base});check(response.status===200&&response.headers['cache-control'].includes('no-store'),'family API responds successfully without caching');
const savedFetch=globalThis.fetch;globalThis.fetch=async(_,opts)=>{const r=await http(JSON.parse(opts.body));return {ok:r.status===200,status:r.status,json:async()=>r.value};};
try{
 const original='Porosia juaj: https://tepiha.vercel.app/k/10?src=base';
 const prepared=await prepareFamilySmartMessage(original);check(/\/k\/s_[A-Za-z0-9_-]{22}/.test(prepared)&&prepared.includes(FAMILY_INVITATION),'Smart Message uses a short capability bound to the exact existing order');
 check(await prepareFamilySmartMessage(prepared)===prepared,'preparing message twice adds one invitation');
 const bulk=original+' https://tepiha.vercel.app/k/11?src=base';check(await prepareFamilySmartMessage(bulk)===bulk,'bulk message never gets a shared family capability');
 check(await prepareFamilySmartMessage('Legacy https://tepiha.vercel.app/k/123')==='Legacy https://tepiha.vercel.app/k/123','source-less legacy message stays compatible');
}finally{globalThis.fetch=savedFetch;}
// Rollout compatibility: no migration means no new family UI/links, existing card still works.
const missing={...supabase,rpc:async()=>({data:null,error:{code:'PGRST202',message:'missing'}})};
check((await buildClientProfile({...base,orderId:10},{supabase:missing,authUser})).profile.family===null,'profile works before additive migration is installed');
console.log(`PASS ${n} family API and profile scenarios`);await db.close();
