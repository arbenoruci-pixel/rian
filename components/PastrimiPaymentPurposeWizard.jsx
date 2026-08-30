'use client';

import { useRef } from 'react';
import { PASTRIMI_PAYMENT_PURPOSE } from '@/lib/pastrimiPaymentPurpose';

function euro(value) { return `${(Number(value || 0) || 0).toFixed(2)}€`; }

export default function PastrimiPaymentPurposeWizard({ open, code, clientName, due, cashGiven, busy, onChoose, onBack }) {
  const activationRef = useRef({ at: 0, action: '' });
  if (!open) return null;
  const applied = Math.min(Math.max(0, Number(cashGiven || 0)), Math.max(0, Number(due || 0)));
  const remaining = Math.max(0, Number((Number(due || 0) - applied).toFixed(2)));
  const pickupBlocked = remaining > 0;

  const activate = (action, callback) => {
    if (busy) return;
    const now = Date.now();
    if (now - Number(activationRef.current?.at || 0) < 700) return;
    activationRef.current = { at: now, action };
    callback?.();
  };

  const touchHandlers = (action, callback) => ({
    onPointerUp: (event) => {
      const pointerType = String(event?.pointerType || '').toLowerCase();
      if (pointerType === 'touch' || pointerType === 'pen') activate(action, callback);
    },
    onTouchEnd: () => activate(action, callback),
    onClick: () => activate(action, callback),
  });

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="pastrimi-payment-purpose-title" data-pastrimi-payment-purpose-wizard="1" style={{position:'fixed',inset:0,zIndex:100600,background:'rgba(2,6,23,.90)',display:'grid',placeItems:'center',padding:12}}>
      <div style={{width:'min(560px,100%)',border:'1px solid rgba(96,165,250,.38)',borderRadius:22,background:'linear-gradient(180deg,#111827,#020617)',color:'#fff',padding:16,boxShadow:'0 24px 90px rgba(0,0,0,.72)'}}>
        <div style={{fontSize:11,fontWeight:1000,color:'#93c5fd',letterSpacing:'.12em'}}>PAGESA • KODI {code || '—'}</div>
        <h2 id="pastrimi-payment-purpose-title" style={{fontSize:23,lineHeight:1.08,margin:'8px 0 4px',fontWeight:1000}}>ÇKA PO NDODH ME TEPIHAT?</h2>
        {clientName ? <div style={{color:'#cbd5e1',fontSize:13,fontWeight:850}}>{clientName}</div> : null}
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:6,marginTop:12}}>
          <div style={{padding:8,borderRadius:11,background:'rgba(15,23,42,.8)'}}><small>BORXHI</small><div style={{fontWeight:1000}}>{euro(due)}</div></div>
          <div style={{padding:8,borderRadius:11,background:'rgba(15,23,42,.8)'}}><small>PAGESA</small><div style={{fontWeight:1000}}>{euro(applied)}</div></div>
          <div style={{padding:8,borderRadius:11,background:remaining?'rgba(127,29,29,.35)':'rgba(20,83,45,.35)'}}><small>MBETET</small><div style={{fontWeight:1000}}>{euro(remaining)}</div></div>
        </div>

        <div style={{display:'grid',gap:10,marginTop:14}}>
          <button type="button" disabled={busy || pickupBlocked} {...touchHandlers('PICKUP_NOW', () => onChoose?.(PASTRIMI_PAYMENT_PURPOSE.PICKUP_NOW))} style={{minHeight:72,borderRadius:15,border:'1px solid rgba(74,222,128,.48)',background:pickupBlocked?'#334155':'linear-gradient(135deg,#166534,#15803d)',color:'#fff',fontWeight:1000,fontSize:16,textAlign:'left',padding:'10px 13px',opacity:busy?.7:1,touchAction:'manipulation',WebkitTapHighlightColor:'transparent'}}>
            KLIENTI PO I MERR TEPIHAT TASH
            <span style={{display:'block',fontSize:11,color:pickupBlocked?'#cbd5e1':'#dcfce7',marginTop:4}}>{pickupBlocked ? `DUHET PAGESA E PLOTË — MUNGOJNË ${euro(remaining)}` : 'PAGESA MBYLLET DHE POROSIA KALON NË DORZIM'}</span>
          </button>
          <button type="button" disabled={busy} {...touchHandlers('PREPAY', () => onChoose?.(PASTRIMI_PAYMENT_PURPOSE.PREPAY))} style={{minHeight:72,borderRadius:15,border:'1px solid rgba(96,165,250,.48)',background:'linear-gradient(135deg,#1e3a8a,#1d4ed8)',color:'#fff',fontWeight:1000,fontSize:16,textAlign:'left',padding:'10px 13px',opacity:busy?.7:1,touchAction:'manipulation',WebkitTapHighlightColor:'transparent'}}>
            KLIENTI VETËM PO PARAPAGUAN
            <span style={{display:'block',fontSize:11,color:'#dbeafe',marginTop:4}}>PAGESA MUND TË JETË E PJESSHME OSE E PLOTË; POROSIA MBETET NË PASTRIMI</span>
          </button>
        </div>
        <button type="button" disabled={busy} {...touchHandlers('BACK', onBack)} style={{width:'100%',minHeight:46,marginTop:12,borderRadius:13,border:'1px solid rgba(148,163,184,.28)',background:'rgba(15,23,42,.75)',color:'#e2e8f0',fontWeight:950,touchAction:'manipulation',WebkitTapHighlightColor:'transparent'}}>← KTHEHU TE SHUMA</button>
      </div>
    </div>
  );
}
