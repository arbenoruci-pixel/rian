'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

function n(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}
function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function SwitchRow({ label, description, checked, onChange, children = null }) {
  return (
    <div style={{ border:'1px solid #e2e8f0', borderRadius:15, padding:12, background:'#fff', display:'grid', gap:10 }}>
      <label style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) auto', alignItems:'center', gap:12, cursor:'pointer' }}>
        <span>
          <strong style={{ display:'block', fontSize:13, color:'#0f172a' }}>{label}</strong>
          <span style={{ display:'block', marginTop:4, color:'#64748b', fontSize:11, lineHeight:1.35, fontWeight:650 }}>{description}</span>
        </span>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} style={{ width:24, height:24 }} />
      </label>
      {checked && children ? <div style={{ display:'grid', gap:8 }}>{children}</div> : null}
    </div>
  );
}

function MoneyField({ label, value, onChange, placeholder = '0.00' }) {
  return (
    <label style={{ display:'grid', gap:5 }}>
      <span style={{ color:'#475569', fontSize:10.5, fontWeight:900, letterSpacing:'.04em' }}>{label}</span>
      <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={fieldStyle} />
    </label>
  );
}

export default function WorkerCompensationEditor({ actor, worker, onSaved }) {
  // WORKER_COMPENSATION_EDITOR_V1
  const workerPin = String(worker?.pin || '').trim();
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  async function load() {
    if (!actor?.pin || !workerPin) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: rpcError } = await supabase.rpc('get_worker_compensation_profile_v1', {
        p_actor_pin: String(actor.pin),
        p_worker_pin: workerPin,
      });
      if (rpcError) throw rpcError;
      setForm({
        salary_enabled: data?.salary_enabled === true,
        salary_amount: String(data?.salary_amount ?? 0),
        salary_day: data?.salary_day == null ? '' : String(data.salary_day),
        meal_enabled: data?.meal_enabled === true,
        meal_amount: String(data?.meal_amount ?? 0),
        commission_enabled: data?.commission_enabled === true,
        commission_rate_m2: String(data?.commission_rate_m2 ?? 0),
        transport_bonus_enabled: data?.transport_bonus_enabled === true,
        transport_bonus_amount: String(data?.transport_bonus_amount ?? 0),
        ready_bonus_enabled: data?.ready_bonus_enabled === true,
        cash_mode: upper(data?.cash_mode || 'FULL_CASH'),
        notes: String(data?.notes || ''),
      });
    } catch (err) {
      setError(String(err?.message || err?.details || err || 'NUK U NGARKUAN OPSIONET E PAGESËS.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [actor?.pin, workerPin]);

  const role = upper(worker?.role);
  const transportRole = role === 'TRANSPORT';
  const canReadyBonus = !transportRole;
  const formula = useMemo(() => {
    if (!form) return '';
    const parts = [];
    if (form.salary_enabled) parts.push(`RROGË ${n(form.salary_amount).toFixed(2)}€`);
    if (form.meal_enabled) parts.push(`USHQIM ${n(form.meal_amount).toFixed(2)}€`);
    if (form.transport_bonus_enabled) parts.push(`BONUS TRANSPORT ${n(form.transport_bonus_amount).toFixed(2)}€`);
    if (form.commission_enabled) parts.push(`KOMISION ${n(form.commission_rate_m2).toFixed(2)}€/m²`);
    return parts.length ? parts.join(' + ') : 'ASNJË KOMPONENT PAGESE AKTIVE';
  }, [form]);

  async function save() {
    if (!form || !actor?.pin || !workerPin) return;
    if (form.commission_enabled && upper(form.cash_mode) !== 'HYBRID_COMMISSION') {
      setError('Kur aktivizohet komisioni, mënyra e cash-it duhet të jetë HYBRID_COMMISSION.');
      return;
    }
    setSaving(true);
    setError('');
    setSaved('');
    try {
      const profile = {
        salary_enabled: !!form.salary_enabled,
        salary_amount: n(form.salary_amount),
        salary_day: String(form.salary_day || '').trim(),
        meal_enabled: !!form.meal_enabled,
        meal_amount: n(form.meal_amount),
        commission_enabled: !!form.commission_enabled,
        commission_rate_m2: n(form.commission_rate_m2),
        transport_bonus_enabled: !!form.transport_bonus_enabled,
        transport_bonus_amount: n(form.transport_bonus_amount),
        ready_bonus_enabled: canReadyBonus && !!form.ready_bonus_enabled,
        cash_mode: upper(form.cash_mode || 'FULL_CASH'),
        notes: String(form.notes || '').trim(),
      };
      const { data, error: rpcError } = await supabase.rpc('save_worker_compensation_profile_v1', {
        p_actor_pin: String(actor.pin),
        p_actor_name: String(actor?.name || actor.pin),
        p_worker_pin: workerPin,
        p_profile: profile,
        p_change_note: 'PËRDITËSIM NGA STAFI / PAYROLL UI',
      });
      if (rpcError) throw rpcError;
      setSaved('U RUAJT DHE U LIDH ME ARKËN + PAYROLL-IN.');
      try { onSaved?.(data); } catch {}
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
      await load();
    } catch (err) {
      setError(String(err?.message || err?.details || err || 'NUK U RUAJT PROFILI I PAGESËS.'));
    } finally {
      setSaving(false);
    }
  }

  if (!workerPin) return null;
  if (loading && !form) return <div style={{ padding:12, color:'#64748b', fontWeight:800 }}>Duke ngarkuar opsionet e pagesës...</div>;
  if (!form) return <div style={{ padding:12, color:'#b91c1c', fontWeight:800 }}>{error || 'Nuk u ngarkua profili.'}</div>;

  return (
    <div style={{ marginTop:14, border:'1px solid #cbd5e1', borderRadius:18, background:'#f8fafc', padding:14, display:'grid', gap:11 }}>
      <div>
        <div style={{ color:'#2563eb', fontSize:10.5, fontWeight:1000, letterSpacing:'.10em' }}>KONTRATA E PAGESËS</div>
        <div style={{ marginTop:5, color:'#0f172a', fontSize:17, fontWeight:1000 }}>ÇKA I TAKON KËTIJ PUNËTORI?</div>
        <div style={{ marginTop:5, color:'#64748b', fontSize:11, lineHeight:1.4, fontWeight:700 }}>Çdo opsion i zgjedhur shfaqet njësoj në ARKË, llogarinë e punëtorit dhe PAYROLL.</div>
      </div>

      <SwitchRow label="RROGË FIKSE" description="Aktivizon rrogën bazë mujore." checked={form.salary_enabled} onChange={(checked) => setForm({ ...form, salary_enabled:checked })}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:8 }}>
          <MoneyField label="SHUMA MUJORE (€)" value={form.salary_amount} onChange={(value) => setForm({ ...form, salary_amount:value })} />
          <label style={{ display:'grid', gap:5 }}><span style={{ color:'#475569', fontSize:10.5, fontWeight:900 }}>DITA E RROGËS</span><input inputMode="numeric" value={form.salary_day} onChange={(e) => setForm({ ...form, salary_day:e.target.value.replace(/\D/g,'').slice(0,2) })} placeholder="31" style={fieldStyle} /></label>
        </div>
      </SwitchRow>

      <SwitchRow label="USHQIM / SHTESË MUJORE" description="Shton shumën e ushqimit në payroll. Ushqimi ditor në ARKË mbetet transaksion i ndarë." checked={form.meal_enabled} onChange={(checked) => setForm({ ...form, meal_enabled:checked })}>
        <MoneyField label="SHUMA MUJORE (€)" value={form.meal_amount} onChange={(value) => setForm({ ...form, meal_amount:value })} />
      </SwitchRow>

      <SwitchRow label="BONUS TRANSPORTI" description="Shtesë fikse mujore për transport." checked={form.transport_bonus_enabled} onChange={(checked) => setForm({ ...form, transport_bonus_enabled:checked })}>
        <MoneyField label="SHUMA MUJORE (€)" value={form.transport_bonus_amount} onChange={(value) => setForm({ ...form, transport_bonus_amount:value })} />
      </SwitchRow>

      <SwitchRow label="KOMISION PËR m²" description="Vetëm për punëtor hybrid. Komisioni mbahet nga cash-i; pjesa tjetër dorëzohet në bazë." checked={form.commission_enabled} onChange={(checked) => setForm({ ...form, commission_enabled:checked, cash_mode:checked ? 'HYBRID_COMMISSION' : 'FULL_CASH', commission_rate_m2:checked && n(form.commission_rate_m2)<=0 ? '0.50' : form.commission_rate_m2 })}>
        <MoneyField label="KOMISIONI €/m²" value={form.commission_rate_m2} onChange={(value) => setForm({ ...form, commission_rate_m2:value })} placeholder="0.50" />
      </SwitchRow>

      <SwitchRow label="BONUSI I BAZËS 72H" description={transportRole ? 'Ky bonus është vetëm për bazën dhe nuk lejohet për profil TRANSPORT.' : 'Aktivizon programin e bonusit të bazës.'} checked={canReadyBonus && form.ready_bonus_enabled} onChange={(checked) => setForm({ ...form, ready_bonus_enabled:canReadyBonus && checked })} />

      <label style={{ display:'grid', gap:5 }}>
        <span style={{ color:'#475569', fontSize:10.5, fontWeight:900 }}>MËNYRA E CASH-IT</span>
        <select value={form.cash_mode} onChange={(e) => setForm({ ...form, cash_mode:e.target.value, commission_enabled:e.target.value==='HYBRID_COMMISSION' ? form.commission_enabled : false })} style={fieldStyle}>
          <option value="FULL_CASH">FULL_CASH — krejt cash-i dorëzohet</option>
          <option value="HYBRID_COMMISSION">HYBRID_COMMISSION — mban komisionin</option>
          <option value="NO_CASH">NO_CASH — nuk menaxhon cash</option>
        </select>
      </label>

      <label style={{ display:'grid', gap:5 }}>
        <span style={{ color:'#475569', fontSize:10.5, fontWeight:900 }}>SHËNIM</span>
        <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes:e.target.value })} placeholder="P.sh. Rrugë fikse — krejt cash-i dorëzohet në bazë." style={{ ...fieldStyle, resize:'vertical', minHeight:78 }} />
      </label>

      <div style={{ border:'1px solid #bfdbfe', borderRadius:13, background:'#eff6ff', color:'#1e3a8a', padding:10, fontSize:11, lineHeight:1.4, fontWeight:850 }}>
        FORMULA: {formula}
      </div>
      {error ? <div style={{ border:'1px solid #fecaca', borderRadius:12, background:'#fef2f2', color:'#b91c1c', padding:9, fontSize:11, fontWeight:850 }}>{error}</div> : null}
      {saved ? <div style={{ border:'1px solid #bbf7d0', borderRadius:12, background:'#f0fdf4', color:'#166534', padding:9, fontSize:11, fontWeight:900 }}>{saved}</div> : null}
      <button type="button" onClick={save} disabled={saving} style={{ border:0, borderRadius:13, padding:'13px 14px', background:'#16a34a', color:'#fff', fontSize:12, fontWeight:1000, cursor:'pointer', opacity:saving?.65:1 }}>{saving ? 'DUKE RUAJTUR...' : 'RUAJ DHE SINKRONIZO KUDO'}</button>
    </div>
  );
}

const fieldStyle = {
  width:'100%', boxSizing:'border-box', border:'1px solid #cbd5e1', borderRadius:12, background:'#fff', color:'#0f172a', padding:'11px 12px', fontSize:13, fontWeight:800, outline:'none',
};
