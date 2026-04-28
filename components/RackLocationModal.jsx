'use client';
import React from 'react';
import {
  RACK_SPOTS,
  OVERFLOW_ROOMS,
  OVERFLOW_SPOTS_BY_ROOM,
  buildOverflowLocation,
  formatRackLocationLabel,
} from '@/lib/rackLocations';

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
  const [showOverflow, setShowOverflow] = React.useState(false);
  const [overflowRoom, setOverflowRoom] = React.useState('FURRA_POSHT');

  if (!open) return null;

  const selectedSet = new Set((Array.isArray(selectedSlots) ? selectedSlots : []).map((x) => String(x || '').trim().toUpperCase()).filter(Boolean));

  function renderSlotButton(slot, options = {}) {
    const s = String(slot || '').trim().toUpperCase();
    const label = options?.label || formatRackLocationLabel(s);
    const owners = slotMap[s] || [];
    const isMine = selectedSet.has(s);
    const otherOwners = owners.filter((x) => String(x.orderId) !== String(currentOrderId));
    const hasOthers = otherOwners.length > 0;
    const count = owners.length;
    const bg = isMine ? '#16a34a' : hasOthers ? 'rgba(245, 158, 11, 0.25)' : 'rgba(255,255,255,0.05)';
    const border = isMine ? '#4ade80' : hasOthers ? 'rgba(245, 158, 11, 0.6)' : 'rgba(255,255,255,0.15)';
    const color = isMine ? '#fff' : hasOthers ? '#fcd34d' : 'rgba(255,255,255,0.8)';

    return (
      <button key={s} disabled={busy} onClick={() => onToggleSlot?.(s)} style={{ padding:'8px 2px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', borderRadius:10, fontWeight:900, fontSize:options?.compact ? 12 : 15, border:`1px solid ${border}`, background:bg, color, cursor:'pointer', transition:'all 0.1s', minHeight:options?.compact ? '50px' : '54px' }}>
        <span style={{ textAlign:'center', lineHeight:1.1 }}>{label}</span>
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
  }

  const overflowSlots = OVERFLOW_SPOTS_BY_ROOM[overflowRoom] || [];

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
        <div style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap:8, marginBottom:16 }}>
          {RACK_SPOTS.map((s) => renderSlotButton(s))}
        </div>

        <div style={{ marginBottom:20, border:'1px solid rgba(255,255,255,0.12)', borderRadius:14, background:'rgba(255,255,255,0.035)', overflow:'hidden' }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowOverflow((value) => !value)}
            style={{ width:'100%', padding:'12px 14px', display:'flex', alignItems:'center', justifyContent:'space-between', border:0, background:'rgba(220, 38, 38, 0.18)', color:'#fff', fontWeight:950, fontSize:14, cursor:'pointer' }}
          >
            <span>OVERFLOW / MAGAZINË EXTRA</span>
            <span style={{ fontSize:18, lineHeight:1 }}>{showOverflow ? '−' : '+'}</span>
          </button>

          {showOverflow ? (
            <div style={{ padding:12 }}>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:8, marginBottom:12 }}>
                {OVERFLOW_ROOMS.map((room) => {
                  const active = overflowRoom === room.key;
                  return (
                    <button
                      key={room.key}
                      type="button"
                      disabled={busy}
                      onClick={() => setOverflowRoom(room.key)}
                      style={{ padding:'10px 8px', borderRadius:10, border:`1px solid ${active ? '#f97316' : 'rgba(255,255,255,0.16)'}`, background:active ? 'rgba(249, 115, 22, 0.24)' : 'rgba(255,255,255,0.05)', color:active ? '#fed7aa' : 'rgba(255,255,255,0.82)', fontWeight:950, cursor:'pointer' }}
                    >
                      {room.label}
                    </button>
                  );
                })}
              </div>

              <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:8 }}>
                {overflowSlots.map((slotKey) => {
                  const slot = slotKey.replace(`${overflowRoom}_`, '');
                  const safeKey = buildOverflowLocation(overflowRoom, slot) || slotKey;
                  return renderSlotButton(safeKey, { label: slot, compact: true });
                })}
              </div>

              <div style={{ marginTop:10, color:'rgba(255,255,255,0.55)', fontSize:11, fontWeight:700, textAlign:'center' }}>
                Përdore vetëm kur raftat normalë janë të mbingarkuar.
              </div>
            </div>
          ) : null}
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
