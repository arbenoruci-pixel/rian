
export default function Home() {
  return (
    <main style={{ padding: 24, display:'grid', gap:12 }}>
      <h1>TEPIHA • HOME</h1>

      <a href="/pranimi" style={btn}>PRANIMI</a>
      <a href="/pastrimi" style={btn}>PASTRIMI</a>
      <a href="/gati" style={btn}>GATI</a>
      <a href="/marrje-sot" style={btn}>MARRJE SOT</a>
      <a href="/transport" style={btnAlt}>TRANSPORT</a>
      <a href="/arka" style={btn}>ARKA</a>
    </main>
  );
}

const btn = {
  display:'block',
  padding:14,
  borderRadius:8,
  background:'#2563eb',
  color:'#fff',
  textAlign:'center',
  textDecoration:'none',
  fontWeight:600
};

const btnAlt = {
  ...btn,
  background:'#16a34a'
};
