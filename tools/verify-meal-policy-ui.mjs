import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Synthetic browser-only fixture: no live database, staff data or financial writes.
const bundle=await build({
  stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,useLocation} from 'react-router-dom';import Notice from './components/MealPolicyNotice.jsx';function NoticePage(){const location=useLocation();React.useEffect(()=>{window.noticeRoute=location.pathname+location.search;},[location]);return <Notice/>;}const root=createRoot(document.getElementById('root'));window.renderNotice=()=>root.render(<BrowserRouter><NoticePage/></BrowserRouter>);`,resolveDir:process.cwd(),loader:'jsx'},
  bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},
  plugins:[{name:'meal-fixtures',setup(builder){
    builder.onResolve({filter:/lib\/(actorSession|mealPolicyClient)$/},args=>({path:args.path,namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('actorSession')?'export const getActor=()=>window.actor;':'export const fetchMealPolicy=options=>window.fetchPolicy(options);export const acknowledgeMealPolicy=key=>window.acknowledge(key);',loader:'js'}));
  }}],
});
const actor={id:'20000000-0000-4000-8000-000000000001',pin:'9911',role:'PUNTOR',name:'Punëtori test'};
const setting={policyKey:'meal_monthly_2026_12',effectiveFrom:'2026-12-01',effectiveAt:'2026-11-30T23:00:00Z',dailyRate:3,workDays:26,monthlyAmount:78,enabled:true};
const active={serverNow:'2026-11-30T23:00:00Z',businessDate:'2026-12-01',actorId:actor.id,targetId:actor.id,dailyMealsAllowed:false,nextActivationAt:null,settings:[setting],policies:[{policyKey:setting.policyKey,workerId:actor.id,enabled:true}],acknowledged:[]};
const upcoming={...active,serverNow:'2026-11-30T22:59:59.900Z',businessDate:'2026-11-30',dailyMealsAllowed:true,nextActivationAt:setting.effectiveAt};
const clone=value=>JSON.parse(JSON.stringify(value));
let dom;
let passed=0;
const pass=name=>{passed++;console.log('PASS '+name);};
const query=selector=>dom.window.document.querySelector(selector);
const text=()=>dom.window.document.body.textContent;
const button=label=>[...dom.window.document.querySelectorAll('button')].find(item=>item.textContent.trim()===label);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(predicate,label='UI update'){
  const limit=Date.now()+5000;
  while(Date.now()<limit){if(predicate())return;await sleep(10);}
  throw new Error('Timeout: '+label+'\n'+text());
}
async function click(label){await wait(()=>button(label)&&!button(label).disabled,label);button(label).click();await sleep(20);}
function open(policy=active,pathname='/arka'){
  dom?.window.close();
  const consoleSink=new VirtualConsole();
  consoleSink.on('jsdomError',error=>{throw error;});
  dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.test'+pathname,pretendToBeVisual:true,runScripts:'outside-only',virtualConsole:consoleSink});
  const w=dom.window;
  w.actor=clone(actor);w.policy=clone(policy);w.reads=0;w.acks=[];w.opened=0;w.policyChanged=0;w.decisions=[];
  w.fetchPolicy=async()=>{w.reads++;return clone(w.policy);};
  w.acknowledge=async key=>{w.acks.push(key);w.policy.acknowledged=[key];return {ok:true};};
  w.submitHandoff=async decision=>{w.decisions.push(clone(decision));return {ok:true,handoff:{id:'fixture-handoff',amount:w.returnedNet},readyBonusTotal:5};};
  w.addEventListener('tepiha:meal-policy-open',()=>{w.opened++;});
  w.addEventListener('tepiha:meal-policy-updated',()=>{w.policyChanged++;});
  w.eval(bundle.outputFiles[0].text);
  return w;
}

let w=open(upcoming);
// A wrong device clock must neither open early nor delay the server-based timer.
const ActualDate=w.Date;w.Date=class extends ActualDate{constructor(...args){super(...(args.length?args:['2045-06-01T12:00:00Z']));}static now(){return ActualDate.parse('2045-06-01T12:00:00Z');}};
w.renderNotice();await wait(()=>w.reads===1);await sleep(30);
assert.equal(query('[data-meal-policy-notice="open"]'),null);
w.policy=clone(active);
await wait(()=>query('[data-meal-policy-notice="open"]'),'server cutoff timer');
await wait(()=>w.opened===1,'notice priority event');
assert.match(text(),/78\.00/);assert.match(text(),/26 ditë pune/);assert.equal(w.opened,1);assert.equal(w.policyChanged,1);
assert.equal(query('[role="alertdialog"]').style.zIndex,'200000');
await click('E kuptova');await wait(()=>!query('[role="alertdialog"]'));
assert.deepEqual(w.acks,[setting.policyKey]);
w.dispatchEvent(new w.Event('focus'));await sleep(30);assert.equal(query('[role="alertdialog"]'),null);
pass('notice waits for server business cutoff despite wrong device clock, opens automatically with message priority, and persists acknowledgment');

w=open({...active,policies:[]});w.renderNotice();await wait(()=>w.reads===1);await sleep(30);assert.equal(query('[role="alertdialog"]'),null);
w=open({...active,acknowledged:[setting.policyKey]});w.renderNotice();await wait(()=>w.reads===1);await sleep(30);assert.equal(query('[role="alertdialog"]'),null);
w=open();w.acknowledge=async()=>{throw new Error('Konfirmimi nuk u ruajt.');};w.renderNotice();await wait(()=>query('[role="alertdialog"]'));await click('E kuptova');assert.ok(query('[role="alertdialog"]'));assert.match(query('[role="alert"]').textContent,/Konfirmimi nuk u ruajt/);
w.actor={...actor,id:'20000000-0000-4000-8000-000000000004',pin:'9914'};w.policy={...clone(active),actorId:w.actor.id,targetId:w.actor.id,policies:[]};w.dispatchEvent(new w.Event('tepiha:session-changed'));await wait(()=>!query('[role="alertdialog"]'));
pass('noneligible/already acknowledged workers have no popup; failed acknowledgment stays visible and account switching clears old content');

w=open();let resolveRead;w.fetchPolicy=()=>new Promise(resolve=>{resolveRead=resolve;});w.renderNotice();await wait(()=>Boolean(resolveRead));
w.actor={...actor,id:'20000000-0000-4000-8000-000000000004',pin:'9914'};resolveRead(clone(active));await sleep(30);assert.equal(query('[role="alertdialog"]'),null);
pass('an in-flight policy response cannot open another worker’s notice after a session change');

w=open(active,'/porosit');w.renderNotice();await wait(()=>w.noticeRoute==='/porosit');
async function navigateNotice(path){w.history.pushState({},'',path);w.dispatchEvent(new w.PopStateEvent('popstate'));await wait(()=>w.noticeRoute===path);}
for(const path of ['/porosit','/porosit/new','/k/fixture-customer','/login','/transport/login','/diag-lite','/debug-lite','/offline','/arka?public=1']){
  await navigateNotice(path);w.dispatchEvent(new w.Event('focus'));await sleep(10);
  assert.equal(w.reads,0,`No staff policy request on public route ${path}`);
  assert.equal(query('[role="alertdialog"]'),null,`No salary notice on public route ${path}`);
}
await navigateNotice('/arka');await wait(()=>query('[role="alertdialog"]'));
assert.equal(w.reads,1);assert.match(text(),/78\.00/);
await navigateNotice('/k/fixture-customer');assert.equal(query('[role="alertdialog"]'),null);
let resolvePrivateRead;w.fetchPolicy=()=>{w.reads++;return new Promise(resolve=>{resolvePrivateRead=resolve;});};
await navigateNotice('/arka');await wait(()=>Boolean(resolvePrivateRead));
await navigateNotice('/porosit');resolvePrivateRead(clone(active));await sleep(20);
assert.equal(query('[role="alertdialog"]'),null,'Late private-route response cannot cover a public customer page');
assert.equal(w.acks.length,0,'Changing route never acknowledges a notice');
pass('logged-in eligible staff have no policy requests or salary popup on public routes; private navigation opens it and late responses cannot restore it over customer pages');

const clientBundle=await build({stdin:{contents:`import {fetchMealPolicy} from './lib/mealPolicyClient.js';window.readRealPolicy=fetchMealPolicy;`,resolveDir:process.cwd(),loader:'js'},bundle:true,write:false,format:'iife',alias:{'@':process.cwd()},plugins:[{name:'actor-fixture',setup(builder){builder.onResolve({filter:/lib\/actorSession$/},args=>({path:args.path,namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const getActor=()=>window.actor;',loader:'js'}));}}]});
w=open(upcoming);const CacheDate=w.Date;w.Date=class extends CacheDate{constructor(...args){super(...(args.length?args:['2045-06-01T12:00:00Z']));}static now(){return CacheDate.parse('2045-06-01T12:00:00Z');}};
w.fetches=0;w.fetch=async()=>{w.fetches++;return {ok:true,status:200,json:async()=>({ok:true,...clone(w.policy)})};};w.eval(clientBundle.outputFiles[0].text);
assert.equal((await w.readRealPolicy()).dailyMealsAllowed,true);w.policy=clone(active);assert.equal((await w.readRealPolicy()).dailyMealsAllowed,true);assert.equal(w.fetches,1);
await sleep(130);assert.equal((await w.readRealPolicy()).dailyMealsAllowed,false);assert.equal(w.fetches,2);
w.actor={...actor,id:'20000000-0000-4000-8000-000000000004',pin:'9914'};w.policy={...clone(active),actorId:w.actor.id,targetId:w.actor.id,policies:[]};
assert.equal((await w.readRealPolicy()).actorId,w.actor.id);assert.equal(w.fetches,3);
let resolveResponse;w.fetch=()=>new Promise(resolve=>{resolveResponse=resolve;});const inflight=w.readRealPolicy({force:true});await wait(()=>Boolean(resolveResponse));w.actor=clone(actor);resolveResponse({ok:true,status:200,json:async()=>({ok:true,...clone(w.policy)})});
await assert.rejects(()=>inflight,error=>error.code==='MEAL_POLICY_SESSION_CHANGED');
pass('real policy client expires upcoming cache on server activation using a monotonic timer and rejects cached/in-flight cross-account results');

// The five-step wizard’s November/December and carry tests live in
// verify-worker-handoff-wizard-ui.mjs and run against its injected server API.
dom.window.close();
console.log(`Meal policy UI: ${passed} verification groups passed.`);
