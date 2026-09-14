import { useEffect, useState } from 'react';
import FamilyContactsForm, { familyButtonStyle as button } from './FamilyContactsForm.jsx';
import { familyRequest, familyErrorText } from '../lib/clientFamilyClient.js';
export default function PublicFamilyPanel({ token, source, orderId }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setInfo(null); setOpen(false); setSaved(false); setError('');
    if (token && orderId) familyRequest({ action: 'PUBLIC_INFO', token, source, orderId: String(orderId) }, { signal: controller.signal }).then(r => { if (active) setInfo(r); }).catch(e => { if (active && !controller.signal.aborted) setError(familyErrorText(e)); });
    return () => { active = false; controller.abort(); };
  }, [token, source, orderId]);
  if (!token) return null;
  return <section aria-label="Familjarët tuaj" style={{ padding: 18, marginTop: 16, borderRadius: 18, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9' }}>
    <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Tepihat e familjes suaj</h2>
    <p>Shtoni emrat dhe telefonat e familjarëve që mund t’i sjellin tepihat, që t’i gjejmë në të njëjtën kartelë.</p>
    {info && <p>Kodet tuaja: {info.codes.map(c => `${c.source === 'BASE' ? 'Bazë' : 'Transport'} ${c.code}`).join(' · ')}</p>}
    {info && !open && <button style={button} type="button" onClick={() => { setOpen(true); setSaved(false); }}>＋ Shto familjarët</button>}
    {info && open && <FamilyContactsForm onCancel={() => setOpen(false)} onSave={async (contacts, requestId) => { await familyRequest({ action: 'PUBLIC_ADD', token, source, orderId: String(orderId), contacts, requestId }); setSaved(true); setOpen(false); }} />}
    {saved && <p role="status" style={{ color: '#86efac' }}>Familjarët u ruajtën dhe u lidhën me kartelën tuaj.</p>}
    {error && <p role="alert" style={{ color: '#fda4af' }}>{error}</p>}
  </section>;
}
