'use client';

import { useEffect, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { getActor } from '@/lib/actorSession';
import { BUJAR_USER_ID } from '@/lib/baseBonusEvidence';
import { fetchWorkerBonusAccount, workerBonusMonthKey } from '@/lib/workerBonusAccountClient.js';

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits:2, maximumFractionDigits:2 });
const money = (amount) => `${MONEY.format(amount)} €`;
const upper = (value) => String(value || '').trim().toUpperCase();

function sessionActorKey(actor) {
  const id = String(actor?.id || actor?.user_id || actor?.pin || '').trim();
  return id ? `${id}:${String(actor?.pin || '').trim()}:${upper(actor?.role)}` : '';
}

export function shouldShowWorkerBonusHandoff(worker) {
  return String(worker?.id || worker?.user_id || '') === BUJAR_USER_ID
    || worker?.pay_ready_bonus_enabled === true;
}

function validBreakdown(row) {
  if (!row) return false;
  const amounts = [row.base, row.transport, row.total];
  if (amounts.some((value) => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0)) return false;
  return Math.abs(Number(row.base) + Number(row.transport) - Number(row.total)) < 0.005;
}

export default function WorkerBonusHandoffSummary({ actor, targetPin, handoffId, submittedAt }) {
  const pin = String(targetPin || '').trim();
  const id = String(handoffId ?? '');
  const actorIdentity = sessionActorKey(actor);
  const sessionIdentity = sessionActorKey(getActor());
  const month = workerBonusMonthKey(submittedAt || new Date()) || workerBonusMonthKey();
  const requestKey = `${actorIdentity}:${pin}:${id}:${month}`;
  const [, updateSession] = useState(0);
  const [state, setState] = useState({ key:'', loading:true, row:null, error:false });

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    if (!actorIdentity || actorIdentity !== sessionIdentity) return undefined;
    if (!actor?.pin || !pin || !id) {
      setState({ key:requestKey, loading:false, row:null, error:true });
      return undefined;
    }
    async function load(force = false) {
      const current = ++sequence;
      if (sessionActorKey(getActor()) !== actorIdentity) {
        setState({ key:requestKey, loading:false, row:null, error:false });
        updateSession((value) => value + 1);
        return;
      }
      setState({ key:requestKey, loading:true, row:null, error:false });
      try {
        const report = await fetchWorkerBonusAccount({ targetPin:pin, month, force });
        if (cancelled || current !== sequence) return;
        if (sessionActorKey(getActor()) !== actorIdentity) {
          setState({ key:requestKey, loading:false, row:null, error:false });
          updateSession((value) => value + 1);
          return;
        }
        const row = Array.isArray(report?.handoffs) ? report.handoffs.find((value) => String(value.id) === id) : null;
        setState({ key:requestKey, loading:false, row:validBreakdown(row) ? row : null, error:false });
      } catch {
        if (!cancelled && current === sequence) setState({ key:requestKey, loading:false, row:null, error:true });
      }
    }
    const refresh = () => { if (document.visibilityState !== 'hidden') void load(true); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    void load();
    window.addEventListener('arka:refresh', refresh);
    window.addEventListener('base-ready-bonus:refresh', refresh);
    window.addEventListener('focus', focus);
    return () => {
      cancelled = true;
      window.removeEventListener('arka:refresh', refresh);
      window.removeEventListener('base-ready-bonus:refresh', refresh);
      window.removeEventListener('focus', focus);
    };
  }, [actorIdentity, sessionIdentity, pin, id, month, requestKey]);

  useEffect(() => {
    const changed = () => {
      if (sessionActorKey(getActor()) !== actorIdentity) {
        setState({ key:requestKey, loading:false, row:null, error:false });
      }
      updateSession((value) => value + 1);
    };
    window.addEventListener('tepiha:session-changed', changed);
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener('tepiha:session-changed', changed);
      window.removeEventListener('storage', changed);
    };
  }, [actorIdentity, requestKey]);

  if (!actorIdentity || actorIdentity !== sessionIdentity) return null;
  const current = state.key === requestKey ? state : { loading:true, row:null, error:false };
  const row = current.row;
  const pending = ['PENDING', 'PENDING_DISPATCH_APPROVAL'].includes(upper(row?.status));
  const accepted = ['ACCEPTED', 'ACCEPTED_BY_DISPATCH'].includes(upper(row?.status));
  return <section data-worker-bonus-handoff={id} style={{ border:'1px solid rgba(245,158,11,.3)', borderRadius:12, padding:11, background:'rgba(245,158,11,.06)', display:'grid', gap:8 }} aria-label={`Bonuset në dorëzimin ${id}`}>
    <strong style={{ color:'#fde68a', fontSize:12 }}>BONUSET NË DORËZIMIN #{id}</strong>
    {current.loading ? <div role="status" style={{ fontSize:12, color:'#cbd5e1' }}>Duke ngarkuar bonuset e dorëzimit…</div> : row ? <>
      <div style={{ display:'flex', justifyContent:'space-between', gap:10, fontSize:12 }}><span>Bonus Baze</span><b>{money(Number(row.base))}</b></div>
      <div style={{ display:'flex', justifyContent:'space-between', gap:10, fontSize:12 }}><span>Kontroll Transporti</span><b>{money(Number(row.transport))}</b></div>
      <div style={{ display:'flex', justifyContent:'space-between', gap:12, borderTop:'1px solid rgba(245,158,11,.2)', paddingTop:8, fontSize:12 }}><strong>Gjithsej të mbajtura në këtë dorëzim</strong><b style={{ whiteSpace:'nowrap', color:'#fde68a' }}>{money(Number(row.total))}</b></div>
      <small style={{ color:pending ? '#fde68a' : '#cbd5e1' }}>{pending ? 'Pret pranimin e Dispatch-it' : accepted ? 'Dorëzim i pranuar nga Dispatch-i' : 'Shiko gjendjen e dorëzimit në llogari.'}</small>
    </> : <>
      <div role={current.error ? 'alert' : undefined} style={{ fontSize:12, color:'#cbd5e1' }}>{current.error ? 'Nuk u ngarkua ndarja e bonusit.' : 'Hape llogarinë për detajet e bonusit të këtij dorëzimi.'}</div>
      <Link href={`/arka/puntor/${encodeURIComponent(pin)}#bonuset`} style={{ fontSize:12, color:'#fde68a' }}>Shih llogarinë / bonuset →</Link>
    </>}
  </section>;
}
