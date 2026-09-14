import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route} from 'react-router-dom';
import ClientFamilyPanel from '../../components/ClientFamilyPanel.jsx';
import ClientProfileSheet from '../../components/ClientProfileSheet.jsx';
import SmartSmsModal from '../../components/SmartSmsModal.jsx';
import DispatchClientContact from '../../components/DispatchClientContact.jsx';
import TrackingPage from '../../app/k/[id]/page.jsx';
import FamilySearchResults from '../../components/FamilySearchResults.jsx';
function Staff(){const transport=location.pathname.includes('transport');const[sms,setSms]=useState(false),[profile,setProfile]=useState(false),[q,setQ]=useState('');
return <main style={{maxWidth:560,margin:'auto',padding:12,color:'#f1f5f9',fontFamily:'sans-serif'}}><h1>Kartela testuese</h1>
<button onClick={()=>setSms(true)}>Smart Mesazh test</button><button onClick={()=>setProfile(true)}>Hap historikun</button>
<label>Kërko familjen<input aria-label="Kërko familjen" value={q} onChange={e=>setQ(e.target.value)} /></label><FamilySearchResults query={q}/>
<ClientFamilyPanel source={transport ? "TRANSPORT" : "BASE"} clientId={transport ? "33333333-3333-4333-8333-333333333333" : "11111111-1111-4111-8111-111111111111"} />
<ClientProfileSheet open={profile} onClose={()=>setProfile(false)} anchor={{source:'BASE',client_id:'11111111-1111-4111-8111-111111111111',id:10,code:123}}/>
<SmartSmsModal isOpen={sms} onClose={()=>setSms(false)} phone="044111222" messageText={transport ? 'Porosia juaj: https://tepiha.vercel.app/k/66666666-6666-4666-8666-666666666666?src=transport' : 'Porosia juaj: https://tepiha.vercel.app/k/10?src=base'} />
</main>}
createRoot(document.getElementById('root')).render(<BrowserRouter><Routes><Route path="/k/:id" element={<TrackingPage/>}/><Route path="/test-dispatch" element={<DispatchClientContact orderId="66666666-6666-4666-8666-666666666666" name="Agron transport" phone="045111222" code="T123"/>}/><Route path="*" element={<Staff/>}/></Routes></BrowserRouter>);
