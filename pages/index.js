export default function Home(){
  return (
    <main style={{fontFamily:'system-ui', background:'#0b0f14', color:'#e7eefc', minHeight:'100vh', padding:'24px'}}>
      <h1 style={{textAlign:'center'}}>MOZULUK • Tools</h1>
      <div style={{display:'grid', gap:'12px', maxWidth:720, margin:'24px auto'}}>
        <a href="/mozuluk_calc_leadfinder.html" style={btn}>Open Calculator + Lead Finder</a>
        <a href="/mozuluk_lead_finder_pro.html" style={btn}>Open Lead Finder PRO</a>
      </div>
      <style jsx>{`
        a:hover{opacity:.9}
      `}</style>
    </main>
  )
}
const btn = {display:'block', padding:'14px 16px', borderRadius:12, textDecoration:'none', background:'#3aa0ff', color:'#02101f', fontWeight:800, textAlign:'center'};
