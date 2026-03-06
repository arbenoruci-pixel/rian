'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { ensureBasePool, getActorPin } from '@/lib/baseCodes';

function onlyDigits(v){ return String(v ?? '').replace(/\D+/g,''); }
function normCode(v){
  const s = String(v ?? '').trim();
  if (!s) return { kind:'', raw:'' };
  if (/^t\d+/i.test(s)) return { kind:'T', raw:'T'+onlyDigits(s) };
  return { kind:'B', raw: onlyDigits(s) };
}

function routeForStatus(status){
  const s = String(status||'').toLowerCase();
  if (s === 'pastrim') return '/pastrimi';
  if (s === 'gati') return '/gati';
  if (s === 'dorzim' || s === 'dorzuar') return '/marrje-sot';
  return '/pastrimi';
}

function getStatusStyle(status) {
  const s = String(status||'').toLowerCase();
  if (s === 'gati') return { background: 'rgba(16, 185, 129, 0.15)', color: '#4ade80', border: '1px solid rgba(16, 185, 129, 0.3)' };
  if (s === 'pastrim') return { background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' };
  if (s === 'dorzim' || s === 'dorzuar') return { background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.3)' };
  return { background: 'rgba(255,255,255,0.05)', color: '#aaa', border: '1px solid rgba(255,255,255,0.1)' };
}

// Llogarit sa tepihë ka brenda porosisë
function computePieces(orderData) {
  if (!orderData) return 0;
  const t = Array.isArray(orderData.tepiha) ? orderData.tepiha : (Array.isArray(orderData.tepihaRows) ? orderData.tepihaRows : []);
  const s = Array.isArray(orderData.staza) ? orderData.staza : (Array.isArray(orderData.stazaRows) ? orderData.stazaRows : []);
  const tCope = t.reduce((a, b) => a + (Number(b.qty ?? b.pieces) || 0), 0);
  const sCope = s.reduce((a, b) => a + (Number(b.qty ?? b.pieces) || 0), 0);
  const shk = Number(orderData.shkallore?.qty) > 0 ? 1 : 0;
  return tCope + sCope + shk;
}

async function fetchTransporterNameByPin(pin){
  try{
    const p = onlyDigits(pin);
    if(!p) return '';
    const { data, error } = await supabase
      .from('tepiha_users')
      .select('name,pin')
      .eq('pin', p)
      .limit(1);
    if(error) return '';
    const row = Array.isArray(data) ? data[0] : (data || null);
    return String(row?.name || row?.pin || '');
  }catch{
    return '';
  }
}

export default function HomePage() {
  const router = useRouter();


  useEffect(() => {
    try {
      const pin = getActorPin();
      void ensureBasePool(pin, 20);
    } catch {}
  }, []);

  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [results, setResults] = useState([]);

  const parsed = useMemo(() => normCode(q), [q]);

  async function runSearch(e){
    e?.preventDefault?.();
    setErr('');
    setResults([]);

    const qRaw = String(q || '').trim();
    const qLower = qRaw.toLowerCase();
    
    if (qLower === 'doctor' || qLower === '/doctor') {
      router.push('/doctor');
      return;
    }
    if (qLower === 'offline' || qLower === '/offline' || qLower === 'offline.html' || qLower === '/offline.html') {
      router.push('/offline.html');
      return;
    }

    const kind = parsed.kind;
    const raw = parsed.raw;

    if(!raw){
      setErr('SHKRUAJ KODIN (p.sh. 3 ose T3)');
      return;
    }

    setLoading(true);
    try{
      if(kind === 'T'){
        const tcode = String(raw || '').toUpperCase();
        const { data, error } = await supabase
          .from('transport_orders')
          .select('id,client_tcode,status,transport_id,data,updated_at,created_at')
          .eq('client_tcode', tcode)
          .order('updated_at', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(10);

        if(error) throw new Error(error.message);

        const rows = Array.isArray(data) ? data : [];
        const out = [];
        for(const r of rows){
          const transport_id = r?.transport_id ?? r?.data?.transport_id ?? r?.data?.transportId ?? null;
          const transporter = transport_id ? await fetchTransporterNameByPin(transport_id) : '';
          const client = r?.data?.client || r?.data?.klienti || {};
          out.push({
            kind:'T',
            code: String(r?.client_tcode || tcode),
            status: r?.status || '',
            name: r?.data?.client_name || client?.name || r?.data?.name || '',
            phone: r?.data?.client_phone || client?.phone || r?.data?.phone || '',
            transporter,
            pieces: computePieces(r?.data),
            id: r?.id || null,
          });
        }
        setResults(out);
        return;
      }

      const n = Number(raw) || 0;
      if(!(n>0)){
        setErr('KOD I PAVLEFSHËM.');
        return;
      }

      const { data, error } = await supabase
        .from('orders')
        .select('id,code,status,client_name,client_phone,data,updated_at')
        .eq('code', n)
        .order('updated_at', { ascending: false })
        .limit(10);

      if(error) throw new Error(error.message);

      const rows = Array.isArray(data) ? data : [];
      const out = [];
      for(const r of rows){
        const transport_id = r?.data?.transport_id ?? r?.data?.transportId ?? null;
        const transporter = transport_id ? await fetchTransporterNameByPin(transport_id) : '';
        const createdBy = r?.data?._audit?.created_by_name || r?.data?.created_by_name || r?.data?.created_by || null;
        
        out.push({
          kind:'B',
          code: String(r?.code ?? n),
          status: r?.status || '',
          name: r?.client_name || '',
          phone: r?.client_phone || '',
          transporter,
          createdBy,
          pieces: computePieces(r?.data),
          id: r?.id || null,
        });
      }
      setResults(out);

    }catch(ex){
      setErr(String(ex?.message || ex || 'GABIM NE SEARCH'));
    }finally{
      setLoading(false);
    }
  }

  return (
    <div className="home-wrap">
      {/* HEADER */}
      <header className="header-pro">
        <div className="header-text">
          <h1 className="title">TEPIHA <span style={{color: '#3b82f6'}}>PRO</span></h1>
        </div>
      </header>

      {/* SEARCH SECTION */}
      <section className="search-section">
        <h2 className="section-title">🔍 KËRKO POROSINË</h2>
        <form className="search-box" onSubmit={runSearch}>
          <input
            className="search-input"
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            placeholder="Shkruaj Kodin (Psh: 3 ose T3)"
            inputMode="text"
            autoComplete="off"
          />
          <button className="search-btn" type="submit" disabled={loading}>
            {loading ? '...' : 'KËRKO'}
          </button>
        </form>

        {err && <div className="error-msg">{err}</div>}

        {/* REZULTATET E KËRKIMIT */}
        {results?.length ? (
          <div className="results-container">
            {results.map((r, idx) => {
              const href = (r.kind === 'T')
                ? (`${r.id ? `/transport/item?id=${encodeURIComponent(String(r.id||''))}` : `/transport/menu`}`)
                : (`${routeForStatus(r.status)}?q=${encodeURIComponent(String(r.code||''))}`);

              return (
                <Link key={r.id || idx} href={href + (href.includes('?') ? '&' : '?') + 'nogate=1&from=search'} className="result-card">
                  <div className="result-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {/* KODI JESHIL PA # */}
                      <span className="code-badge">{String(r.code||'')}</span>
                      <span className="status-badge" style={getStatusStyle(r.status)}>
                        {String(r.status||'PA STATUS').toUpperCase()}
                      </span>
                    </div>
                    {/* SA TEPIHA */}
                    <div className="pieces-badge">📦 {r.pieces} Copë</div>
                  </div>

                  <div className="result-body">
                    <div className="client-name">{String(r.name||'Klient i panjohur')}</div>
                    {r.phone && <div className="client-phone">📞 {String(r.phone||'')}</div>}
                  </div>

                  <div className="result-footer">
                    <div className="workers-info">
                      {r.createdBy && <div>👤 <span>SJELLË NGA:</span> {String(r.createdBy)}</div>}
                      {r.transporter && <div style={{color: '#f59e0b'}}>🚚 <span>PRU NGA:</span> {String(r.transporter).toUpperCase()}</div>}
                    </div>
                    <div className="go-btn">HAP ➔</div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : null}
      </section>

      {/* NAVIGATION GRID */}
      <section className="modules-section">
        <h2 className="section-title">⚙️ ZGJEDH MODULIN</h2>
        
        <div className="modules-grid">
          <Link href="/pranimi" className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa'}}>🧾</div>
            <div className="mod-info">
              <div className="mod-title">PRANIMI</div>
              <div className="mod-sub">Regjistro klientin</div>
            </div>
          </Link>

          <Link href="/pastrimi" className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(16, 185, 129, 0.15)', color: '#34d399'}}>🧼</div>
            <div className="mod-info">
              <div className="mod-title">PASTRIMI</div>
              <div className="mod-sub">Lista e larjes</div>
            </div>
          </Link>

          <Link href="/gati" className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24'}}>✅</div>
            <div className="mod-info">
              <div className="mod-title">GATI</div>
              <div className="mod-sub">Gati për dorëzim</div>
            </div>
          </Link>

          <Link href="/marrje-sot" className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(239, 68, 68, 0.15)', color: '#f87171'}}>📦</div>
            <div className="mod-info">
              <div className="mod-title">MARRJE SOT</div>
              <div className="mod-sub">Porositë e sotme</div>
            </div>
          </Link>

          <Link href="/transport" className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(139, 92, 246, 0.15)', color: '#a78bfa'}}>🚚</div>
            <div className="mod-info">
              <div className="mod-title">TRANSPORT</div>
              <div className="mod-sub">Porositë (T-kode)</div>
            </div>
          </Link>

          <Link href="/arka" className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(236, 72, 153, 0.15)', color: '#f472b6'}}>💰</div>
            <div className="mod-info">
              <div className="mod-title">ARKA</div>
              <div className="mod-sub">Mbyllja e ditës</div>
            </div>
          </Link>

          <Link href="/fletore" className="mod-card" style={{ gridColumn: '1 / -1' }}>
            <div className="mod-icon" style={{background: 'rgba(255, 255, 255, 0.1)', color: '#e2e8f0'}}>📒</div>
            <div className="mod-info">
              <div className="mod-title">FLETORJA</div>
              <div className="mod-sub">Arkiva e plotë e porosive dhe detajet</div>
            </div>
          </Link>
        </div>
      </section>

      {/* STYLES */}
      <style jsx>{`
        .home-wrap { padding: 16px 14px 40px; background: #070b14; min-height: 100vh; color: #fff; font-family: system-ui, -apple-system, sans-serif; }
        
        .header-pro { display: flex; justify-content: flex-start; align-items: center; margin-bottom: 24px; }
        .header-text .title { font-size: 26px; font-weight: 1000; letter-spacing: -0.5px; margin: 0; line-height: 1.1; }

        .section-title { font-size: 13px; font-weight: 900; letter-spacing: 1px; color: rgba(255,255,255,0.5); margin-bottom: 12px; margin-left: 4px; }
        
        .search-section { margin-bottom: 28px; }
        .search-box { display: flex; gap: 8px; }
        .search-input { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 14px 16px; color: #fff; font-size: 16px; font-weight: 700; outline: none; transition: 0.2s; }
        .search-input:focus { border-color: #3b82f6; background: rgba(59,130,246,0.05); }
        .search-btn { background: #3b82f6; color: #fff; border: none; border-radius: 14px; padding: 0 20px; font-weight: 900; font-size: 14px; letter-spacing: 0.5px; cursor: pointer; }
        .error-msg { margin-top: 10px; color: #fca5a5; background: rgba(239,68,68,0.15); padding: 10px; border-radius: 10px; font-size: 13px; font-weight: 800; border: 1px solid rgba(239,68,68,0.3); }

        .results-container { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
        .result-card { background: linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 16px; text-decoration: none; color: #fff; display: flex; flex-direction: column; gap: 12px; transition: transform 0.1s; }
        .result-card:active { transform: scale(0.98); background: rgba(255,255,255,0.08); }
        .result-header { display: flex; justify-content: space-between; align-items: center; }
        .code-badge { background: #10b981; color: #000; font-size: 18px; font-weight: 900; padding: 4px 12px; border-radius: 8px; letter-spacing: 0.5px; }
        .status-badge { font-size: 11px; font-weight: 900; padding: 4px 10px; border-radius: 6px; letter-spacing: 0.5px; }
        .pieces-badge { font-size: 13px; font-weight: 800; color: rgba(255,255,255,0.9); background: rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 8px; }
        
        .result-body { display: flex; flex-direction: column; gap: 4px; }
        .client-name { font-size: 17px; font-weight: 800; }
        .client-phone { font-size: 14px; color: rgba(255,255,255,0.6); font-weight: 600; }
        
        .result-footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px; }
        .workers-info { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; color: #60a5fa; }
        .workers-info span { opacity: 0.6; color: #fff; margin-right: 2px; }
        .go-btn { background: #3b82f6; color: #fff; font-weight: 900; padding: 8px 16px; border-radius: 10px; font-size: 13px; }

        .modules-section { margin-top: 10px; }
        .modules-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .mod-card { background: linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; padding: 16px; text-decoration: none; color: #fff; display: flex; flex-direction: column; gap: 14px; transition: transform 0.1s, border-color 0.2s; }
        .mod-card:active { transform: scale(0.96); border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); }
        .mod-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
        .mod-info { display: flex; flex-direction: column; gap: 4px; }
        .mod-title { font-weight: 900; font-size: 14px; letter-spacing: 0.5px; }
        .mod-sub { font-size: 11px; font-weight: 600; opacity: 0.5; line-height: 1.3; }
      `}</style>
    </div>
  );
}
