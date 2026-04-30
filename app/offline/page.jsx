// app/offline/page.jsx
// Static offline fallback page
export const dynamic = 'force-static';

export default function Offline() {
  return (
    <div style={{minHeight:'100vh',background:'#000',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div style={{maxWidth:520,textAlign:'center'}}>
        <div style={{fontSize:24,fontWeight:900,marginBottom:10}}>JENI OFFLINE ⚠️</div>
        <div style={{opacity:0.85,marginBottom:16}}>
          Nuk ka rrjet. Aplikacioni punon me të dhënat lokale. Kur të vijë rrjeti, sync vazhdon automatikisht.
        </div>
        <div style={{fontSize:12,opacity:0.7}}>Provo prap kur të kesh internet.</div>
      </div>
    </div>
  );
}
