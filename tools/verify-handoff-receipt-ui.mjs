import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Real receipt component/client, synthetic HTTP ledger. No hosted writes.
const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Panel from './components/HandoffReceiptsPanel.jsx';function App(){const [summary,setSummary]=useState(null);return <><output id="summary">{JSON.stringify(summary)}</output><Panel actor={window.actor} onSummary={value=>{window.summaries.push(value);setSummary(value);}} onChange={value=>window.changes.push(value)}/></>}const root=createRoot(document.getElementById('root'));window.renderReceipts=()=>root.render(<App key={window.actor.id}/>);window.renderReceipts();`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'identity-bonus-fixtures',setup(builder){builder.onResolve({filter:/(?:lib\/(actorSession|routerCompat\.jsx)|WorkerBonusHandoffSummary\.jsx)$/},args=>({path:args.path,namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('actorSession')?'export const getActor=()=>window.actor;':args.path.endsWith('routerCompat.jsx')?'import React from "react";export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}':'import React from "react";export const shouldShowWorkerBonusHandoff=worker=>worker.pay_ready_bonus_enabled;export default function Bonus(props){return <div data-bonus-tracked={String(props.receiptTracking)}>Bonus Baze · Kontroll Transporti</div>}',loader:'jsx',resolveDir:process.cwd()}));}}]});
const manager={id:'10000000-0000-4000-8000-000000000001',pin:'9001',name:'Fixture Manager',role:'DISPATCH'};
const workerId='20000000-0000-4000-8000-000000000001';
const virtualConsole=new VirtualConsole();
virtualConsole.on('jsdomError',error=>{throw error;});
const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.test/arka/ditore?handoff=11',pretendToBeVisual:true,runScripts:'outside-only',virtualConsole});
const w=dom.window; w.actor=manager; w.summaries=[]; w.changes=[]; w.requests=[]; w.scrollCount=0;
w.HTMLElement.prototype.scrollIntoView=()=>w.scrollCount++;
const handoff={id:11,worker_id:workerId,worker_pin:'8001',worker_name:'Fixture Worker',amount:100,status:'PENDING_DISPATCH_APPROVAL',submitted_at:'2026-11-21T10:00:00Z',receipt_tracking:false,receipt_received_amount:0,receipt_resolved_amount:0,receipt_outstanding_amount:null,can_receive:true,has_bonus_allocations:true,pay_ready_bonus_enabled:false};
const own={id:22,worker_id:manager.id,worker_pin:manager.pin,worker_name:manager.name,amount:40,status:'PENDING_DISPATCH_APPROVAL',submitted_at:'2026-11-21T10:00:00Z',receipt_tracking:false,can_receive:false};
const state={handoffs:[handoff,own],events:[]};
const replies=new Map(); let physicalCash=0,loseReply=true;
const remaining=h=>h.receipt_tracking?h.receipt_outstanding_amount:h.amount;
function report(){const isManager=w.actor.role==='DISPATCH';const handoffs=isManager?state.handoffs:state.handoffs.filter(h=>h.worker_id===w.actor.id);return {ok:true,manager:isManager,actorId:w.actor.id,handoffs:structuredClone(handoffs),events:structuredClone(state.events.filter(e=>handoffs.some(h=>h.id===e.handoff_id))),summary:{outstandingTotal:handoffs.reduce((sum,h)=>sum+remaining(h),0),receivedToday:isManager||handoffs.length?physicalCash:0},generated_at:new Date().toISOString()};}
w.fetch=async(url,options)=>{
  assert.equal(url,'/api/handoff-receipts'); assert.equal(options.credentials,'same-origin');
  const body=JSON.parse(options.body);w.requests.push(body);assert.equal(body.expectedActorId,w.actor.id);
  if(body.action==='list')return {ok:true,status:200,json:async()=>report()};
  assert.ok(['receive','resolve'].includes(body.action));
  if(replies.has(body.requestKey))return {ok:true,status:200,json:async()=>({...structuredClone(replies.get(body.requestKey)),replayed:true})};
  assert.equal(body.expectedOutstanding,remaining(handoff));assert.equal('actorId' in body,false);
  const e={id:state.events.length+1,handoff_id:handoff.id,event_kind:body.action==='receive'?'RECEIPT':'RESOLUTION',amount:body.amount,note:body.note,actor_name:manager.name,created_at:new Date().toISOString(),outstanding_before:remaining(handoff),outstanding_after:remaining(handoff)-body.amount};
  state.events.push(e);handoff.receipt_tracking=true;handoff.receipt_outstanding_amount=e.outstanding_after;
  if(body.action==='receive'){handoff.receipt_received_amount+=body.amount;physicalCash+=body.amount;}else handoff.receipt_resolved_amount+=body.amount;
  if(!handoff.receipt_outstanding_amount)handoff.status='ACCEPTED';
  const reply={ok:true,handoff:{...structuredClone(handoff),outstanding:remaining(handoff)},event:e,replayed:false};replies.set(body.requestKey,reply);
  if(loseReply){loseReply=false;throw new Error('Synthetic response lost after commit');}
  return {ok:true,status:200,json:async()=>reply};
};
const text=()=>w.document.body.textContent;
const query=s=>w.document.querySelector(s);
const button=label=>[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
async function wait(predicate,label='UI update'){const until=Date.now()+4000;while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timeout '+label+'\n'+text());}
async function click(label){await wait(()=>button(label)&&!button(label).disabled,label);button(label).click();await new Promise(resolve=>setTimeout(resolve,20));}
function input(selector,value){const e=query(selector);const proto=e.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new w.Event('input',{bubbles:true}));}
w.eval(bundle.outputFiles[0].text);
await wait(()=>query('#handoff-receipt-11'));
await wait(()=>w.scrollCount===1,'focused receipt scroll');
assert.equal(query('#handoff-receipt-22'),null);assert.equal(w.scrollCount,1);
assert.equal(w.requests.filter(r=>r.action==='list').length,1,'Inline summary callbacks must not restart fetching.');
assert.deepEqual(JSON.parse(query('#summary').textContent),{outstandingTotal:140,receivedToday:0});
await click('Prano paratë');
assert.equal(query('[role="dialog"] input[inputmode="decimal"]').value,'');
input('[role="dialog"] input[inputmode="decimal"]','70');input('[role="dialog"] textarea','Synthetic short receipt');
await click('Prano 70,00 €');
await wait(()=>button('Riprovo të njëjtin veprim'),'durable ambiguous response retry');
assert.equal(physicalCash,70);assert.equal(state.events.length,1);assert.equal(w.localStorage.length,1);
await click('Riprovo të njëjtin veprim');
await wait(()=>!query('[role="dialog"]'));
assert.equal(state.events.length,1);assert.equal(physicalCash,70);assert.equal(w.localStorage.length,0);
const mutations=w.requests.filter(r=>r.action==='receive');assert.equal(mutations.length,2);assert.equal(mutations[0].requestKey,mutations[1].requestKey);
assert.deepEqual(JSON.parse(query('#summary').textContent),{outstandingTotal:70,receivedToday:70});
assert.match(query('#handoff-receipt-11').textContent,/Pranuar pjesërisht/);
const bonusDetails=[...query('#handoff-receipt-11').querySelectorAll('details')].find(d=>d.querySelector('summary').textContent.includes('Bonuset'));
bonusDetails.open=true;bonusDetails.dispatchEvent(new w.Event('toggle'));
await wait(()=>query('[data-bonus-tracked="true"]'));
assert.match(query('#handoff-receipt-11').textContent,/Bonus Baze · Kontroll Transporti/);
console.log('PASS explicit partial amount, stable summary callback, focused handoff, historical bonus detail and lost-response retry with one cash credit');

await click('Shfaq të gjitha');
assert.ok(query('#handoff-receipt-22'));assert.equal(query('#handoff-receipt-22').querySelector('button'),null);
assert.match(query('#handoff-receipt-22').textContent,/person tjetër i autorizuar/);
handoff.receipt_received_amount+=5;handoff.receipt_outstanding_amount-=5;physicalCash+=5;
w.dispatchEvent(new w.Event('focus'));
await wait(()=>JSON.parse(query('#summary').textContent).receivedToday===75);
assert.match(query('#handoff-receipt-11').textContent,/25,00/);
await click('Sqaro diferencën');
input('[role="dialog"] input[inputmode="decimal"]','25');input('[role="dialog"] textarea','Synthetic documented adjustment');
await click('Sqaro 25,00 € pa cash');assert.ok(query('[role="dialog"]'));assert.equal(state.events.length,1);
query('[role="dialog"] input[type="checkbox"]').click();
input('[role="dialog"] textarea','no');
await click('Sqaro 25,00 € pa cash');assert.ok(query('[role="dialog"]'));assert.equal(state.events.length,1);
input('[role="dialog"] textarea','Synthetic documented adjustment');
await click('Sqaro 25,00 € pa cash');
await wait(()=>!query('[role="dialog"]'));
assert.equal(physicalCash,75);assert.equal(handoff.receipt_resolved_amount,25);assert.equal(handoff.status,'ACCEPTED');
assert.match(text(),/Sqaruar pa hyrje cash/);
console.log('PASS another dispatch refreshes remaining cash; own handoff cannot self-approve; noncash correction requires explicit confirmation and never increases cash');

w.actor={id:'20000000-0000-4000-8000-000000000099',role:'PUNTOR'};
w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(()=>!query('#handoff-receipt-11')&&!query('#handoff-receipt-22'));
const changedSummary=JSON.parse(query('#summary').textContent);
if(changedSummary!==null){assert.deepEqual(changedSummary,{outstandingTotal:0,receivedToday:0});assert.ok(w.requests.some(request=>request.action==='list'&&request.expectedActorId===w.actor.id));}
console.log('PASS identity changes clear prior handoffs, history and summary');
state.handoffs=[{...handoff,receipt_resolved_amount:20,receipt_outstanding_amount:5,status:'PENDING_DISPATCH_APPROVAL',can_receive:false}];
w.actor={id:workerId,pin:'8001',name:'Fixture Worker',role:'PUNTOR'};
w.renderReceipts();
await wait(()=>query('#handoff-receipt-11'));
assert.match(query('#handoff-receipt-11').textContent,/Mbetet për dorëzim5,00/);
assert.equal(button('Prano paratë'),undefined);assert.equal(button('Sqaro diferencën'),undefined);
assert.equal(query('[role="dialog"]'),null);
console.log('PASS loaded worker account displays its remaining handoff and history with no receive or correction actions');
dom.window.close();
