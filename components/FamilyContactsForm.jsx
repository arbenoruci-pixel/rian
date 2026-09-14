import { useRef, useState } from 'react';
import { familyErrorText, newFamilyRequestId } from '../lib/clientFamilyClient.js';
const field = { boxSizing: 'border-box', width: '100%', minWidth: 0, padding: 12, borderRadius: 10, border: '1px solid #475569', background: '#0f172a', color: '#fff', fontSize: 16 };
export const familyButtonStyle = { border: '1px solid #475569', borderRadius: 10, padding: '11px 14px', minHeight: 44, background: '#16354c', color: '#e0f2fe', fontWeight: 700, cursor: 'pointer' };
export default function FamilyContactsForm({ onSave, onCancel }) {
  const [rows, setRows] = useState([{ name: '', phone: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const intent = useRef(null);
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const contacts = rows.map(r => ({ name: r.name.trim(), phone: r.phone.trim() }));
    const text = JSON.stringify(contacts);
    if (intent.current?.text !== text) intent.current = { text, requestId: newFamilyRequestId() };
    setBusy(true); setError('');
    try { await onSave(contacts, intent.current.requestId); }
    catch (err) { setError(familyErrorText(err)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} aria-label="Shto familjarët" style={{ display: 'grid', gap: 10 }}>
    <fieldset disabled={busy} style={{ margin: 0, padding: 0, border: 0, minWidth: 0, display: 'grid', gap: 12 }}>
      {rows.map((row, index) => <div key={index} style={{ display: 'grid', gap: 6, minWidth: 0 }}>
        <label>Emri i familjarit {index + 1}<input required maxLength={180} autoComplete="off" aria-label={`Emri i familjarit ${index + 1}`} value={row.name} onChange={e => setRows(rs => rs.map((r, i) => i === index ? { ...r, name: e.target.value } : r))} style={field} /></label>
        <label>Telefoni {index + 1}<input required type="tel" maxLength={80} autoComplete="off" placeholder="044 123 456" aria-label={`Telefoni ${index + 1}`} value={row.phone} onChange={e => setRows(rs => rs.map((r, i) => i === index ? { ...r, phone: e.target.value } : r))} style={field} /></label>
        {rows.length > 1 && <button type="button" onClick={() => setRows(rs => rs.filter((_, i) => i !== index))} style={familyButtonStyle}>Hiq familjarin {index + 1}</button>}
      </div>)}
      {rows.length < 10 && <button type="button" onClick={() => setRows(rs => [...rs, { name: '', phone: '' }])} style={familyButtonStyle}>＋ Shto edhe një familjar</button>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button type="submit" style={familyButtonStyle}>{busy ? 'Duke ruajtur…' : 'Ruaj familjarët'}</button>{onCancel && <button type="button" onClick={onCancel} style={familyButtonStyle}>Anulo</button>}</div>
    </fieldset>
    {error && <div role="alert" style={{ color: '#fda4af' }}>{error}</div>}
  </form>;
}
