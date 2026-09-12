import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {isStaffAdmin} from '../lib/roles.js';
let checks=0;const check=(v,m)=>{assert(v,m);checks++;};
const strip=s=>s.replace(/^import .*;\n/gm,'').replace(/export /g,'');
const approved=strip(fs.readFileSync('lib/approvedApiRequest.js','utf8'));
const client=strip(fs.readFileSync('lib/deviceAdminClient.js','utf8'));
let replies=[],calls=[],repairs=0;
const ctx=vm.createContext({fetchJsonWithDeadline:async(url,init)=>{calls.push({url,body:init.body});const r=replies.shift();if(r instanceof Error)throw r;return r;},ensureApprovedDeviceSession:async()=>{repairs++;return {ok:true};}});
vm.runInContext(approved+'\n'+client,ctx);
const reply=(status,body)=>({response:{ok:status===200,status},body});
const row={device_id:'synthetic-device',requested_role:'DISPATCH'};
replies=[reply(401,{error:'AUTH_REQUIRED'}),reply(200,{ok:true,devices:[row]})];
check((await ctx.listPendingDevices()).length===1,'cookie recovery returns pending request');
check(repairs===1&&calls.length===2&&calls[0].body===calls[1].body,'one bounded recovery with identical action');
replies=[reply(403,{error:'DEVICE_NOT_APPROVED'})];calls=[];repairs=0;
await assert.rejects(ctx.listPendingDevices(),e=>e.code==='DEVICE_NOT_APPROVED'&&e.status===403);checks++;
check(calls.length===1&&repairs===0,'explicit device denial never repaired or bypassed');
replies=[reply(200,{ok:true})];await assert.rejects(ctx.listPendingDevices(),/INVALID_RESPONSE/);checks++;
replies=[reply(200,{ok:true,devices:[]})];check((await ctx.listPendingDevices()).length===0,'only explicit empty array means no requests');
replies=[Object.assign(new Error('deadline'),{name:'AbortError'})];await assert.rejects(ctx.listPendingDevices(),e=>e.code==='DEVICE_ADMIN_TIMEOUT');checks++;

const page=fs.readFileSync('app/arka/stafi/page.jsx','utf8');
const reload=page.slice(page.indexOf('  async function reloadAll('),page.indexOf('  async function handleOneClickApprove('));
function harness(staff,devices){
 const state={};const context=vm.createContext({reloadSequence:{current:0},reloadInFlight:{current:false},DB_TIMEOUT_MS:10,
  listUserRecords:staff,listPendingDevices:devices,withTimeout:p=>p,
  ...Object.fromEntries(['Refreshing','Loading','Staff','StaffLoadError','Pending','DeviceLoadError'].map(n=>['set'+n,v=>{state[n]=v;}]))
 });vm.runInContext(reload,context);return {state,context};
}
let deviceReads=0;
let h=harness(async()=>{throw new Error('staff timeout');},async()=>{deviceReads++;return [row];});await h.context.reloadAll();
check(deviceReads===1&&h.state.Pending.length===1,'staff failure cannot suppress pending read');check(!!h.state.StaffLoadError,'staff error visible independently');
h=harness(async()=>[{is_active:true}],async()=>{throw new Error('Load failed');});await h.context.reloadAll();
check(h.state.Pending===null&&!!h.state.DeviceLoadError&&h.state.Staff.length===1,'device failure is unknown, not zero, with independent staff success');
h=harness(async()=>[],async()=>{throw {code:'DEVICE_NOT_APPROVED'};});await h.context.reloadAll();
check(h.state.DeviceLoadError.includes('administrator'),'device denial explains required authorized session');
h.context.listPendingDevices=async()=>[row];await h.context.reloadAll();check(h.state.Pending.length===1&&!h.state.DeviceLoadError,'refresh recovers and clears error');
let releaseOld,readCount=0;
h=harness(async()=>[],()=>++readCount===1?new Promise(r=>{releaseOld=r;}):Promise.resolve([row]));
const old=h.context.reloadAll();await h.context.reloadAll();releaseOld([]);await old;
check(h.state.Pending.length===1,'older empty response cannot erase a newer request');

const auto=page.slice(page.indexOf('  useEffect(() => {\n    if (!canManageStaff)'),page.indexOf('  useEffect(() => () =>'));
let cleanup,tick,refreshes=0;const listeners=new Map();
const environment={canManageStaff:true,actionBusy:false,reloadInFlight:{current:false},reloadAll:()=>{refreshes++;},useEffect:fn=>{cleanup=fn();},
 window:{addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n),setInterval:f=>{tick=f;return 1;},clearInterval(){}},
 document:{hidden:false,addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n)}};
vm.runInNewContext(auto,environment);
for(const name of ['focus','online','visibilitychange'])listeners.get(name)();tick();
check(refreshes===4,'focus, reconnection, visibility and timer refresh');environment.document.hidden=true;tick();check(refreshes===4,'hidden page does not poll');environment.document.hidden=false;environment.reloadInFlight.current=true;tick();check(refreshes===4,'no overlapping background reads');cleanup();check(listeners.size===0,'subscriptions cleaned up');

function render(pending,error=''){
 let i=0;const initial=[{id:'synthetic-admin',role:'ADMIN'},pending,error,'',false,[],false,false];
 const hooks={...React,useState:v=>[i<initial.length?initial[i++]:typeof v==='function'?v():v,()=>{}],useEffect:()=>{},useRef:v=>({current:v}),useMemo:f=>f()};
 const module={exports:{}};
 const imports={'react':hooks,'@/lib/routerCompat.jsx':{default:({children})=>React.createElement('span',null,children),useRouter:()=>({}),__esModule:true},'@/lib/deviceAdminClient':{},'@/lib/roles':{isStaffAdmin},'@/lib/usersService':{},'@/components/WorkerCompensationEditor':{default:()=>null,__esModule:true}};
 vm.runInNewContext(transformSync(page,{loader:'jsx',format:'cjs',jsx:'transform'}).code,{module,exports:module.exports,require:n=>{assert(n in imports,n);return imports[n];}});
 return renderToStaticMarkup(React.createElement(module.exports.default));
}
for(const [pending,error] of [[null,''],[null,'Kërkesat nuk u lexuan.']])check(!render(pending,error).includes('Nuk ka kërkesa të reja'),'actual JSX never displays false empty on unknown/error');
check(render([]).includes('Nuk ka kërkesa të reja'),'actual confirmed empty view');
check(render([row]).includes('APROVO PAJISJEN'),'actual pending view offers approval');
check(render(null,'Gabim leximi').includes('role="alert"'),'load failure accessible on screen');
const shortcut=fs.readFileSync('components/ArkaDailyCloseShortcut.jsx','utf8');check(shortcut.includes("['/arka/ditore', '/arka/stafi', '/admin/devices'].includes(path)"),'staff page excludes floating close shortcut that covers refresh');
console.log(`PASS device pending visibility: ${checks} checks for session recovery, honest empty/error state, independent loads, stale-response protection, auto refresh and JSX.`);
