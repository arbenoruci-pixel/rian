'use client';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getActor } from '@/lib/actorSession';
import { acknowledgeMealPolicy, fetchMealPolicy } from '@/lib/mealPolicyClient';
import { activeOwnMealPolicy, mealPolicyNoticeText } from '@/lib/mealPolicy';

const actorKey=actor=>`${actor?.id||actor?.user_id||''}:${actor?.pin||''}:${actor?.role||''}`;
const PUBLIC_PREFIXES=['/login','/transport/login','/porosit','/k','/debug','/diag','/offline'];
const isPublic=location=>PUBLIC_PREFIXES.some(path=>location.pathname===path||location.pathname.startsWith(path+'/')||(path==='/debug'||path==='/diag')&&location.pathname.startsWith(path))||new URLSearchParams(location.search).get('public')==='1';

export default function MealPolicyNotice(){
  const location=useLocation();
  const publicRoute=isPublic(location);
  const [envelope,setEnvelope]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const version=useRef(0);
  const stateKey=useRef('');
  const button=useRef(null);
  useEffect(()=>{
    if(publicRoute){setEnvelope(null);setError('');setBusy(false);return;}
    let alive=true;let timer;
    const refresh=async()=>{
      if(document.visibilityState==='hidden')return;
      const actor=getActor();const key=actorKey(actor);const generation=++version.current;
      if(!actor?.id&&!actor?.user_id){setEnvelope(null);return;}
      try{
        const data=await fetchMealPolicy({force:true});
        if(!alive||generation!==version.current||key!==actorKey(getActor()))return;
        setEnvelope({...data,identity:key});setError('');
        const nextStateKey=`${key}:${data.businessDate}:${data.dailyMealsAllowed}`;
        if(stateKey.current && stateKey.current!==nextStateKey) window.dispatchEvent(new CustomEvent('tepiha:meal-policy-updated'));
        stateKey.current=nextStateKey;
        clearTimeout(timer);
        if(data.nextActivationAt){
          const delay=Date.parse(data.nextActivationAt)-Date.parse(data.serverNow);
          timer=setTimeout(refresh,Math.max(250,Math.min(delay+500,2147483000)));
        }
      }catch{
        if(alive&&generation===version.current)setEnvelope(null);
      }
    };
    const changed=()=>{setEnvelope(null);setError('');setBusy(false);void refresh();};
    void refresh();
    const events=['focus','pageshow','online','tepiha:root-resume'];
    events.forEach(event=>window.addEventListener(event,refresh));
    window.addEventListener('tepiha:session-changed',changed);
    document.addEventListener('visibilitychange',refresh);
    return()=>{alive=false;version.current++;clearTimeout(timer);events.forEach(event=>window.removeEventListener(event,refresh));window.removeEventListener('tepiha:session-changed',changed);document.removeEventListener('visibilitychange',refresh);};
  },[publicRoute]);
  const policy=!publicRoute&&envelope?.identity===actorKey(getActor())?activeOwnMealPolicy(envelope):null;
  const open=Boolean(policy&&!envelope?.acknowledged?.includes(policy.policyKey));
  useEffect(()=>{
    if(!open)return;
    window.dispatchEvent(new CustomEvent('tepiha:meal-policy-open'));
    button.current?.focus();
  },[open,policy?.policyKey]);
  const confirm=async()=>{
    if(busy||!policy)return;
    const identityAtStart=actorKey(getActor());const key=policy.policyKey;
    setBusy(true);setError('');
    try{
      await acknowledgeMealPolicy(key);
      if(identityAtStart!==actorKey(getActor()))return;
      setEnvelope(previous=>previous?{...previous,acknowledged:[...(previous.acknowledged||[]),key]}:previous);
      window.dispatchEvent(new CustomEvent('tepiha:meal-policy-acknowledged'));
    }catch(err){if(identityAtStart===actorKey(getActor()))setError(err?.message||'Konfirmimi nuk u ruajt. Provo përsëri.');}
    finally{if(identityAtStart===actorKey(getActor()))setBusy(false);}
  };
  if(!open)return null;
  return <div data-meal-policy-notice="open" role="alertdialog" aria-modal="true" aria-labelledby="meal-policy-title" aria-describedby="meal-policy-copy" style={{position:'fixed',inset:0,zIndex:200000,background:'rgba(2,6,15,.88)',display:'grid',placeItems:'center',padding:'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))'}}>
    <section style={{width:'100%',maxWidth:520,maxHeight:'90dvh',overflowY:'auto',border:'1px solid #35516f',borderRadius:22,padding:24,color:'#f8fafc',background:'#101d30',boxShadow:'0 24px 80px #0008'}}>
      <div style={{color:'#85e5c1',fontWeight:800,fontSize:14}}>Njoftim për pagën</div>
      <h2 id="meal-policy-title" style={{fontSize:25,lineHeight:1.2,margin:'10px 0 18px'}}>Ushqimi kalon në pagën mujore</h2>
      <div style={{padding:18,borderRadius:16,background:'#073d2e',marginBottom:18}}><strong style={{fontSize:38}}>{Number(policy.monthlyAmount).toFixed(2)} €</strong><div style={{marginTop:4,color:'#b7ead7'}}>në muaj · {Number(policy.dailyRate).toFixed(2)} € × {policy.workDays} ditë pune</div></div>
      <p id="meal-policy-copy" style={{fontSize:16,lineHeight:1.65,margin:'0 0 20px'}}>{mealPolicyNoticeText(policy)}</p>
      {error?<p role="alert" style={{color:'#ffb4b4',fontSize:15}}>{error}</p>:null}
      <button ref={button} type="button" disabled={busy} onClick={confirm} style={{width:'100%',minHeight:54,border:0,borderRadius:14,background:'#22c58b',color:'#05281e',fontSize:17,fontWeight:850,cursor:'pointer'}}>{busy?'Duke ruajtur…':'E kuptova'}</button>
    </section>
  </div>;
}
