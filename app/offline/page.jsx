export default function OfflinePage(){
  return (
    <main style={{padding:24, color:"#fff", fontFamily:"system-ui"}}>
      <h1 style={{fontSize:22, marginBottom:10}}>OFFLINE MODE</h1>
      <p style={{opacity:.85, lineHeight:1.5}}>
        Nuk ka internet. Aplikacioni punon normal me të dhënat lokale dhe do të bëjë SYNC sapo të kthehet rrjeti.
      </p>
      <p style={{opacity:.85, lineHeight:1.5}}>
        Nëse sapo e ke instalu app-in dhe s’ke cache ende, ky ekran mund të dalë deri sa të kesh një herë rrjet.
      </p>
    </main>
  );
}
