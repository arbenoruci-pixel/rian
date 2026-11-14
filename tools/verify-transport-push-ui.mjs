import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'esbuild';
import { webcrypto, createECDH, randomBytes } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

const actorId='12345678-1234-4123-8123-123456789012';
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './components/transport/TransportPushPanel.jsx';createRoot(document.getElementById('root')).render(<Panel/>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'session-fixture',setup(b){
  b.onResolve({filter:/(actorSession|transportAuth|routerCompat)(\.jsx)?$/},a=>({path:a.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path.includes('routerCompat')?`export const usePathname=()=>'/transport/board';const r={replace:u=>window.destination=u};export const useRouter=()=>r;`:a.path.includes('actorSession')?'export const getActor=()=>window.actor;':'export const getTransportSession=()=>window.actor;',loader:'js'}));
}}]});
let dom,calls=[],failSubscribe=false,failOpen=false,subscribed=false,requestGesture=false;
const channels=[];
class TestMessageChannel extends MessageChannel { constructor(){super();channels.push(this);} }
const ec=createECDH('prime256v1');ec.generateKeys();
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
const text=()=>dom.window.document.body.textContent;
const button=name=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent.trim()===name);
async function wait(fn){const until=Date.now()+4000;while(Date.now()<until){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error(text());}
async function click(name){await wait(()=>button(name)&&!button(name).disabled);requestGesture=true;button(name).click();requestGesture=false;}
async function open(query='',ios=false){
  for(const c of channels.splice(0)){c.port1.close();c.port2.close();}
  dom?.window.close();calls=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{throw e});
  dom=new JSDOM('<div id="root"></div>',{url:'https://test.local/transport/board'+query,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window;w.actor={id:actorId,role:'TRANSPORT'};w.AbortController=AbortController;w.TextEncoder=TextEncoder;w.MessageChannel=TestMessageChannel;Object.defineProperty(w,'crypto',{value:webcrypto});
  w.Notification={permission:'default'};w.PushManager={};w.isSecureContext=true;w.matchMedia=()=>({matches:false});
  if(ios)Object.defineProperty(w.navigator,'userAgent',{value:'iPhone'});
  const sub={...subscription,toJSON:()=>subscription,unsubscribe:async()=>{subscribed=false;return true}};
  const reg={active:{postMessage:(message,ports)=>ports[0].postMessage({pushVersion:1})},pushManager:{getSubscription:async()=>subscribed?sub:null,subscribe:()=>{assert(requestGesture,'subscribe must begin in the tap handler');subscribed=true;w.Notification.permission='granted';return Promise.resolve(sub)}}};
  Object.defineProperty(w.navigator,'serviceWorker',{value:{ready:Promise.resolve(reg)}});
  w.fetch=async(url,opts)=>{
    const b=JSON.parse(opts.body);calls.push(b);assert.equal(b.expectedActorId,actorId);
    if(b.action==='SUBSCRIBE'&&failSubscribe){failSubscribe=false;throw new Error('offline');}
    if(b.action==='OPEN'&&failOpen)return {ok:false,json:async()=>({ok:false,error:'PUSH_ORDER_CHANGED'})};
    return {ok:true,json:async()=>({ok:true,enabled:b.action==='SUBSCRIBE',publicKey:ec.getPublicKey().toString('base64url'),endpointHash:'fixture',href:'/transport/item?id='+b.orderId})};
  };
  w.eval(bundle.outputFiles[0].text);
  await wait(()=>button('Aktivizo njoftimet')||ios||w.destination||text().includes('porosi ka ndryshuar')||text().includes('llogarisë tjetër'));
}
await open();failSubscribe=true;await click('Aktivizo njoftimet');await wait(()=>text().includes('offline'));
assert(!text().includes('✓ Aktive'));assert.equal(dom.window.localStorage.getItem('tepiha_transport_push_consent_v1'),null);
await click('Aktivizo njoftimet');await wait(()=>text().includes('✓ Aktive'));
assert.equal(JSON.parse(dom.window.localStorage.getItem('tepiha_transport_push_consent_v1')).actorId,actorId);
await click('Provo njoftimin');await wait(()=>text().includes('Prova u nis'));
await click('Çaktivizo');await wait(()=>text().includes('u çaktivizuan'));assert.equal(subscribed,false);
assert.deepEqual(calls.map(c=>c.action),['STATUS','SUBSCRIBE','SUBSCRIBE','TEST','DISABLE']);
await open('?push_order=22345678-1234-4123-8123-123456789012&push_user='+actorId);await wait(()=>dom.window.destination);assert(dom.window.destination.includes('/transport/item?id='));
failOpen=true;await open('?push_order=22345678-1234-4123-8123-123456789012&push_user='+actorId);await wait(()=>text().includes('porosi ka ndryshuar'));assert.equal(dom.window.destination,undefined);
failOpen=false;await open('?push_order=22345678-1234-4123-8123-123456789012&push_user=other');await wait(()=>text().includes('llogarisë tjetër'));assert(!calls.some(c=>c.action==='OPEN'));
await open('',true);await wait(()=>text().includes('Add to Home Screen'));assert.equal(calls.length,0,'iPhone installation guidance uses no API requests');
dom.window.close();console.log('PASS actual React UI: gesture-safe opt-in, failed save/retry, test, disable, protected deep links and iPhone install guidance');
for(const c of channels.splice(0)){c.port1.close();c.port2.close();}
