'use client';
import Link from '@/lib/routerCompat.jsx';

// The action belongs next to the visible cash balance, including staff detail pages.
export default function ArkaCashHandoffAction({ actorPin, targetPin, amount, onHandoff, busy = false, blocked = false }) {
  const owner = String(actorPin || '').trim();
  if (!owner || owner !== String(targetPin || '').trim()) return null;
  const total = Number(amount);
  const disabled = busy || blocked || !Number.isFinite(total) || total <= 0;
  const label = 'DORËZO TE DISPATCH — €' + (Number.isFinite(total) ? total : 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const style = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', boxSizing: 'border-box', minHeight: 52, border: '1px solid #60a5fa', borderRadius: 12, background: '#1d4ed8', color: '#fff', padding: '12px 10px', fontSize: 15, fontWeight: 900, textAlign: 'center', textDecoration: 'none', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 };
  if (onHandoff || disabled) return <button type="button" data-arka-cash-handoff="1" style={style} disabled={disabled} onClick={onHandoff}>{busy ? 'DUKE VAZHDUAR…' : label}</button>;
  // Staff details enter the same personal cash flow used by Arka home.
  return <Link data-arka-cash-handoff="1" style={style} to="/arka?personal=1">{label}</Link>;
}
