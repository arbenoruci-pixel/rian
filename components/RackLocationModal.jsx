'use client';
import React from 'react';
import { RACK_SPOTS } from '@/lib/rackLocations';

export default function RackLocationModal({
  open,
  busy,
  orderCode,
  currentOrderId,
  subtitle = 'Zgjidh një ose më shumë vende',
  slotMap = {},
  selectedSlots = [],
  placeText = '',
  onTextChange,
  onToggleSlot,
  onClose,
  onClear,
  onSave,
  error = '',
  autoSaveOnSlot = false,
}) {
  if (!open) return null;
  return (
    <div style={{ position:'fixed', inset:0, background:'#0b0b0b', zIndex:10001, display:'flex', flexDirection:'column' }}>
      <div style={{ padding:14, borderBottom:'1px solid rgba(255,255,255,0.08)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontWeight:900, fontSize:18 }}>POZICIONI (KODI: {orderCode || '—'})</div>
          <div style={{ fontSize:12, color:'rgba(255,255,255,0.6)' }}>{subtitle}</div>
        </div>
        <button className="btn secondary" onClick={onClose} disabled={busy}>✕</button>
      </div>
      <div style={{ padding:'16px 14px', overflow:'auto', flex:1 }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap:8, marginBottom:20 }}>
          {RACK_SPOTS.map((s) => {
            const owners = slotMap[s] || [];
            const isMine = selectedSlots.includes(s);
            const otherOwners = owners.filter((x) => String(x.orderId) !== String(currentOrderId));
            const hasOthers = otherOwners.length > 0;
            const count = owners.length;
            const bg = isMine ? '#16a34a' : hasOthers ? 'rgba(245, 158, 11, 0.25)' : 'rgba(255,255,255,0.05)';
            const border = isMine ? '#4ade80' : hasOthers ? 'rgba(245, 158, 11, 0.6)' : 'rgba(255,255,255,0.15)';
            const color = isMine ? '#fff' : hasOthers ? '#fcd34d' : 'rgba(255,255,255,0.8)';
            return (
              <button key={s} disabled={busy} onClick={() => onToggleSlot?.(s)} style={{ padding:'8px 2px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', borderRadius:10, fontWeight:900, fontSize:15, border:`1px solid ${border}`, background:bg, color, cursor:'pointer', transition:'all 0.1s', minHeight:'54px' }}>
                {s}
                {count > 0 && (
                  <span style={{ fontSize:9, marginTop:2, fontWeight:700, opacity:0.95, textAlign:'center', lineHeight:1.1 }}>
                    {count} 📦
                  </span>
                )}
                {hasOthers && !isMine && (
                  <span style={{ fontSize:9, marginTop:2, fontWeight:700, opacity:0.9, textAlign:'center', lineHeight:1.1 }}>
                    {otherOwners.map((x) => x?.code || '').filter(Boolean).join(', ')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="field-group">
          <label className="label">SHËNIM SHTESË (OPSIONALE)</label>
          <textarea value={placeText} onChange={(e) => onTextChange?.(e.target.value)} placeholder="Psh: Të paketuara dy e nga dy..." className="input" rows={3} style={{ resize:'none' }} />
        </div>
        {error ? <div style={{ marginTop:10, color:'#ef4444', fontWeight:800, fontSize:13, background:'rgba(239, 68, 68, 0.1)', padding:8, borderRadius:8 }}>{error}</div> : null}
        {autoSaveOnSlot ? <div style={{ fontSize:11, color:'rgba(255,255,255,0.55)', marginTop:12, textAlign:'center' }}>Preke raftin për ruajtje direkte dhe hapje të SMS-së.</div> : null}
      </div>
      <div style={{ padding:14, borderTop:'1px solid rgba(255,255,255,0.08)', display:'flex', gap:10 }}>
        <button className="btn secondary" onClick={onClear} disabled={busy} style={{ flex:1, fontWeight:900 }}>PASTRO</button>
        {!autoSaveOnSlot ? <button className="btn primary" onClick={onSave} disabled={busy} style={{ flex:2, fontWeight:900 }}>{busy ? 'DUKE RUAJTUR...' : 'RUAJ POZICIONIN'}</button> : null}
      </div>
    </div>
  );
}
