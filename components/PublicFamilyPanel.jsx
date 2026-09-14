import { useEffect, useState } from 'react';
import FamilyContactsForm from './FamilyContactsForm.jsx';
import { familyRequest, familyErrorText } from '../lib/clientFamilyClient.js';
import PublicClientLocation from './PublicClientLocation.jsx';
import { CustomerIcon, portal } from './CustomerPortalUi.jsx';
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
  return <>
    <section aria-label="Familjarët tuaj" className="portal-card" style={portal.card}>
      <div style={portal.heading}><span style={portal.icon}><CustomerIcon name="family" /></span><h2 style={portal.title}>Familjarët tuaj</h2></div>
      <p style={portal.copy}>Shtoni emrat dhe telefonat e familjarëve që mund të na telefonojnë ose t’i sjellin tepihat në bazë. Kështu i gjejmë te e njëjta kartelë, shmangim ngatërrimet dhe <strong style={{ color: '#19334a', fontWeight: 600 }}>kodi juaj permanent mbetet i njëjtë.</strong></p>
      {info && <p style={{ margin: '0 0 14px', color: '#64798a', fontSize: 12 }}>Kodet tuaja: {info.codes.map(c => `${c.source === 'BASE' ? 'Bazë' : 'Transport'} ${c.code}`).join(' · ')}</p>}
      {info && !open && <button style={{ ...portal.button, ...portal.secondary }} type="button" onClick={() => { setOpen(true); setSaved(false); }}><CustomerIcon name="plus" size={18} />Shto familjarët</button>}
      {info && open && <div className="customer-family-form"><FamilyContactsForm onCancel={() => setOpen(false)} onSave={async (contacts, requestId) => { await familyRequest({ action: 'PUBLIC_ADD', token, source, orderId: String(orderId), contacts, requestId }); setSaved(true); setOpen(false); }} /></div>}
      {saved && <p role="status" style={portal.success}><CustomerIcon name="check" size={18} />Familjarët u ruajtën.</p>}
      {error && <p role="alert" style={portal.error}>{error}</p>}
    </section>
    {info && <PublicClientLocation key={`${source}:${orderId}:${token}`} token={token} source={source} orderId={orderId} />}
  </>;
}
