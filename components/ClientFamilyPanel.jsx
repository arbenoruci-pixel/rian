import { useEffect, useRef, useState } from 'react';
import FamilyContactsForm, { familyButtonStyle as button } from './FamilyContactsForm.jsx';
import { familyRequest, familyErrorText, newFamilyRequestId } from '../lib/clientFamilyClient.js';
export default function ClientFamilyPanel({ source, clientId, onChanged }) {
  const [family, setFamily] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState([]);
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const searchGeneration = useRef(0);
  useEffect(() => {
    const gen = ++generation.current;
    const controller = new AbortController();
    setFamily(null); setMode(''); setError(''); setProposal(null); setNotice(''); setBusy(false);
    if (clientId) familyRequest({ action: 'GET_FAMILY', source, clientId }, { signal: controller.signal }).then(r => { if (generation.current === gen) setFamily(r.family); }).catch(e => { if (!controller.signal.aborted && generation.current === gen) setError(familyErrorText(e)); });
    return () => { ++generation.current; ++searchGeneration.current; controller.abort(); };
  }, [source, clientId]);
  async function refresh() {
    const gen = generation.current;
    const result = await familyRequest({ action: 'GET_FAMILY', source, clientId });
    if (gen === generation.current) { setFamily(result.family); setProposal(null); setError(''); }
  }
  async function mutate(action, fields, requestId) {
    const gen = generation.current;
    const result = await familyRequest({ action, source, clientId, expectedRoot: family.rootKey, expectedRevision: family.revision, requestId, ...fields });
    if (gen !== generation.current) return;
    setFamily(result.family); setProposal(null); setMode(''); setNotice('Kartela u përditësua.');
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('tepiha_client_profile_v1:'));
      keys.forEach(k => localStorage.removeItem(k));
      localStorage.removeItem('tepiha_clients_index_v1');
      localStorage.removeItem('tepiha_base_master_cache_v1');
    } catch {}
    window.dispatchEvent(new CustomEvent('tepiha:client-family:updated'));
    onChanged?.();
  }
  async function search(event) {
    event.preventDefault(); const gen = ++searchGeneration.current;
    setBusy(true); setError(''); setHits([]); setProposal(null);
    try { const r = await familyRequest({ action: 'SEARCH', query }); if (gen === searchGeneration.current) setHits(r.items.filter(h => h.family.rootKey !== family.rootKey)); }
    catch (e) { if (gen === searchGeneration.current) setError(familyErrorText(e)); }
    finally { if (gen === searchGeneration.current) setBusy(false); }
  }
  async function confirm() {
    if (busy || !proposal) return; setBusy(true); setError('');
    try { await mutate(proposal.action, proposal.fields, proposal.requestId); }
    catch (e) { setError(familyErrorText(e)); }
    finally { setBusy(false); }
  }
  function propose(action, fields, description) { setError(''); setProposal({ action, fields, description, requestId: newFamilyRequestId() }); }
  if (!clientId) return null;
  if (!family) return error ? <div role="alert" style={{ marginTop: 12, color: '#fda4af' }}>{error}<button type="button" onClick={() => refresh().catch(e => setError(familyErrorText(e)))} style={button}>Rifresko familjen</button></div> : null;
  return <section aria-label="Kartela familjare" style={{ marginTop: 14, padding: 12, border: '1px solid #334155', borderRadius: 16, background: '#0b1728', color: '#f1f5f9', display: 'grid', gap: 10 }}>
    <strong>FAMILJA · KODET DHE TELEFONAT</strong>
    {family.members.map(member => <div key={member.key} style={{ border: '1px solid #334155', padding: 10, borderRadius: 10, overflowWrap: 'anywhere' }}>
      <strong>{member.source === 'BASE' ? 'BAZË' : 'TRANSPORT'} {member.code}{member.key === family.rootKey ? ' · kryesor' : ''}</strong>
      <div>{member.name} · {member.phone || 'Pa telefon'}</div>
      {member.parentKey && <button disabled={busy} type="button" onClick={() => propose('UNLINK', { otherKey: member.key }, `Shkëput kodin ${member.code} dhe kodet që janë lidhur nën të nga kjo familje? Porositë dhe pagesat ruajnë lidhjet e tyre.`)} style={{ ...button, marginTop: 6 }}>Shkëput {member.code}</button>}
    </div>)}
    {family.contacts.map(contact => <div key={contact.id} style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <span style={{ overflowWrap: 'anywhere' }}>{contact.name} · {contact.phone}</span>
      <button disabled={busy} type="button" aria-label={`Hiq ${contact.name}`} onClick={() => propose('REMOVE_CONTACT', { contactId: contact.id }, `Hiq ${contact.name} (${contact.phone}) nga kontaktet e familjes?`)} style={button}>Hiq</button>
    </div>)}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button disabled={busy} type="button" onClick={() => { setMode('add'); setProposal(null); }} style={button}>＋ Shto familjar / telefon</button>
      <button disabled={busy} type="button" onClick={() => { setMode('merge'); setProposal(null); }} style={button}>Lidh / Merge kodin</button>
      <button disabled={busy} type="button" onClick={() => refresh().catch(e => setError(familyErrorText(e)))} style={button}>Rifresko familjen</button>
    </div>
    {mode === 'add' && <FamilyContactsForm onSave={(contacts, requestId) => mutate('ADD_CONTACTS', { contacts }, requestId)} onCancel={() => setMode('')} />}
    {mode === 'merge' && <div style={{ display: 'grid', gap: 8 }}><form onSubmit={search} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <input aria-label="Kërko kodin, emrin ose telefonin" required minLength={1} maxLength={180} value={query} onChange={e => { setQuery(e.target.value); setHits([]); setProposal(null); ++searchGeneration.current; setBusy(false); }} placeholder="Kodi, emri ose telefoni" style={{ flex: '1 1 180px', minWidth: 0, padding: 12, borderRadius: 10, fontSize: 16 }} />
      <button disabled={busy} type="submit" style={button}>Kërko kartelën</button></form>
      {hits.map(hit => <button disabled={busy} key={hit.key} type="button" onClick={() => propose('MERGE', { otherKey: hit.key, otherRoot: hit.family.rootKey, otherRevision: hit.family.revision }, `Lidhi këto kontakte me kartelën aktuale: ${hit.family.members.map(m => `${m.code} — ${m.name} (${m.phone || 'pa telefon'})`).join('; ')}. Kodet aktuale: ${family.members.map(m => m.code).join(', ')}.`)} style={{ ...button, textAlign: 'left', overflowWrap: 'anywhere' }}>{hit.source === 'BASE' ? 'BAZË' : 'TRANSPORT'} {hit.code} · {hit.name}<br />{hit.phone}<br />Kodet: {hit.family.members.map(m => m.code).join(', ')}</button>)}
    </div>}
    {proposal && <div aria-label="Konfirmo lidhjen e familjes" style={{ padding: 12, border: '1px solid #d97706', borderRadius: 10 }}><p>{proposal.description}</p><div style={{ display: 'flex', gap: 8 }}><button disabled={busy} type="button" onClick={confirm} style={button}>{busy ? 'Duke ruajtur…' : 'Konfirmo'}</button><button disabled={busy} type="button" onClick={() => setProposal(null)} style={button}>Anulo</button></div></div>}
    {notice && <div role="status" style={{ color: '#86efac' }}>{notice}</div>}
    {error && <div role="alert" style={{ color: '#fda4af' }}>{error}</div>}
  </section>;
}
