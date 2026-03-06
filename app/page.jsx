'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { ensureBasePool, getActorPin } from '@/lib/baseCodes';
import { getActor } from '@/lib/actorSession';

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
  if (s === 'gati') return { background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0' };
  if (s === 'pastrim') return { background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' };
  if (s === 'dorzim' || s === 'dorzuar') return { background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa' };
  return { background: '#f8fafc', color: '#64748b', border: '1px solid #e2e8f0' };
}

function computePieces(orderData) {
  if (!orderData) return 0;
  const t = Array.isArray(orderData.tepiha) ? orderData.tepiha : (Array.isArray(orderData.tepihaRows) ? orderData.tepihaRows : []);
  const s = Array.isArray(orderData.staza) ? orderData.staza : (Array.isArray(orderData.stazaRows) ? orderData.stazaRows : []);
  const tCope = t.reduce((a, b) => a + (Number(b.qty ?? b.pieces) || 0), 0);
  const sCope = s.reduce((a, b) => a + (Number(b.qty ?? b.pieces) || 0), 0);
  const shk = Number(orderData.shkallore?.qty) > 0 ? 1 : 0;
  return tCope + sCope + shk;
}

function initials(name){
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'U';
  return parts.slice(0,2).map(x => x[0]).join('').toUpperCase();
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

  const actor = useMemo(() => {
    try { return getActor(); } catch { return null; }
  }, []);

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
      setErr('SHKRUAJ KODIN');
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
        setErr('KOD I PAVLEFSHËM');
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
      setErr(String(ex?.message || ex || 'GABIM NË KËRKIM'));
    }finally{
      setLoading(false);
    }
  }

  function openProfile(){
    const id = actor?.id ? String(actor.id) : '';
    if (id) {
      router.push(`/arka/puntoret/${encodeURIComponent(id)}`);
      return;
    }
    router.push('/arka/staff');
  }

  return (
    <div className="home-wrap">
      <header className="header-pro">
        <div className="brand-block">
          <h1 className="title">TEPIHA</h1>
        </div>

        <div className="header-actions">
          {actor?.role === 'ADMIN' ? (
            <button className="device-btn" onClick={()=>router.push('/admin/devices')}>
              PAJISJET
            </button>
          ) : null}

          <button className="avatar-btn" type="button" onClick={openProfile} aria-label="KARTELA E PUNËTORIT">
            <span className="avatar-circle">{initials(actor?.name || actor?.role || 'U')}</span>
          </button>
        </div>
      </header>

      <section className="search-section">
        <div className="section-head">KËRKO</div>
        <form className="search-box" onSubmit={runSearch}>
          <input
            className="search-input"
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            placeholder="KODI"
            inputMode="text"
            autoComplete="off"
          />
          <button className="search-btn" type="submit" disabled={loading}>
            {loading ? '...' : 'HAP'}
          </button>
        </form>

        {err && <div className="error-msg">{err}</div>}

        {results?.length ? (
          <div className="results-container">
            {results.map((r, idx) => {
              const href = (r.kind === 'T')
                ? (`${r.id ? `/transport/item?id=${encodeURIComponent(String(r.id||''))}` : `/transport/menu`}`)
                : (`${routeForStatus(r.status)}?q=${encodeURIComponent(String(r.code||''))}`);

              return (
                <Link key={r.id || idx} href={href + (href.includes('?') ? '&' : '?') + 'nogate=1&from=search'} className="result-card">
                  <div className="result-header">
                    <div className="result-top-left">
                      <span className="code-badge">{String(r.code||'')}</span>
                      <span className="status-badge" style={getStatusStyle(r.status)}>
                        {String(r.status||'PA STATUS').toUpperCase()}
                      </span>
                    </div>
                    <div className="pieces-badge">{r.pieces} COPË</div>
                  </div>

                  <div className="result-body">
                    <div className="client-name">{String(r.name||'KLIENT')}</div>
                    {r.phone && <div className="client-phone">{String(r.phone||'')}</div>}
                  </div>

                  <div className="result-footer">
                    <div className="workers-info">
                      {r.createdBy && <div>{String(r.createdBy)}</div>}
                      {r.transporter && <div>{String(r.transporter).toUpperCase()}</div>}
                    </div>
                    <div className="go-btn">➔</div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="modules-section">
        <div className="section-head">MODULET</div>

        <div className="modules-grid">
          <Link href="/pranimi" className="mod-card">
            <div className="mod-icon mod-blue">🧾</div>
            <div className="mod-title">PRANIMI</div>
          </Link>

          <Link href="/pastrimi" className="mod-card">
            <div className="mod-icon mod-green">🧼</div>
            <div className="mod-title">PASTRIMI</div>
          </Link>

          <Link href="/gati" className="mod-card">
            <div className="mod-icon mod-amber">✅</div>
            <div className="mod-title">GATI</div>
          </Link>

          <Link href="/marrje-sot" className="mod-card">
            <div className="mod-icon mod-red">📦</div>
            <div className="mod-title">MARRJE SOT</div>
          </Link>

          <Link href="/transport" className="mod-card">
            <div className="mod-icon mod-purple">🚚</div>
            <div className="mod-title">TRANSPORT</div>
          </Link>

          <Link href="/arka" className="mod-card">
            <div className="mod-icon mod-pink">💰</div>
            <div className="mod-title">ARKA</div>
          </Link>

          <Link href="/fletore" className="mod-card mod-wide">
            <div className="mod-icon mod-slate">📒</div>
            <div className="mod-title">FLETORJA</div>
          </Link>
        </div>
      </section>

      <style jsx>{`        .home-wrap { padding: 18px 14px 40px; background: #f8fafc; min-height: 100vh; color: #0f172a; font-family: system-ui, -apple-system, sans-serif; }
        .header-pro { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; gap: 12px; }
        .brand-block { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .title { font-size: 28px; font-weight: 1000; letter-spacing: -0.7px; margin: 0; line-height: 1; }
        .header-actions { display: flex; align-items: center; gap: 10px; }
        .device-btn { background: #ffffff; border: 1px solid #e2e8f0; color: #0f172a; padding: 10px 14px; border-radius: 999px; font-weight: 900; font-size: 12px; cursor: pointer; box-shadow: 0 8px 24px rgba(15,23,42,0.06); }
        .avatar-btn { background: transparent; border: 0; padding: 0; cursor: pointer; }
        .avatar-circle { width: 44px; height: 44px; border-radius: 999px; display: grid; place-items: center; background: linear-gradient(135deg, #111827 0%, #334155 100%); color: #fff; font-size: 13px; font-weight: 900; letter-spacing: 0.5px; box-shadow: 0 10px 28px rgba(15,23,42,0.18); }
        .section-head { font-size: 12px; font-weight: 900; letter-spacing: 1px; color: #64748b; margin: 0 0 10px 4px; }
        .search-section { margin-bottom: 28px; }
        .search-box { display: flex; gap: 8px; }
        .search-input { flex: 1; background: #fff; border: 1px solid #dbe2ea; border-radius: 16px; padding: 14px 16px; color: #0f172a; font-size: 16px; font-weight: 700; outline: none; transition: 0.2s; box-shadow: 0 8px 24px rgba(15,23,42,0.05); }
        .search-input:focus { border-color: #93c5fd; box-shadow: 0 0 0 4px rgba(59,130,246,0.12); }
        .search-btn { background: #0f172a; color: #fff; border: none; border-radius: 16px; padding: 0 18px; font-weight: 900; font-size: 13px; letter-spacing: 0.5px; cursor: pointer; }
        .error-msg { margin-top: 10px; color: #b91c1c; background: #fef2f2; padding: 10px 12px; border-radius: 12px; font-size: 13px; font-weight: 800; border: 1px solid #fecaca; }
        .results-container { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
        .result-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 16px; text-decoration: none; color: #0f172a; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 10px 28px rgba(15,23,42,0.05); }
        .result-card:active { transform: scale(0.985); }
        .result-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        .result-top-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .code-badge { background: #10b981; color: #03291e; font-size: 18px; font-weight: 900; padding: 4px 12px; border-radius: 10px; letter-spacing: 0.5px; }
        .status-badge { font-size: 11px; font-weight: 900; padding: 4px 10px; border-radius: 999px; letter-spacing: 0.5px; }
        .pieces-badge { font-size: 12px; font-weight: 900; color: #475569; background: #f8fafc; padding: 6px 10px; border-radius: 999px; border: 1px solid #e2e8f0; }
        .result-body { display: flex; flex-direction: column; gap: 4px; }
        .client-name { font-size: 17px; font-weight: 800; }
        .client-phone { font-size: 14px; color: #64748b; font-weight: 700; }
        .result-footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 2px; border-top: 1px solid #f1f5f9; padding-top: 12px; gap: 10px; }
        .workers-info { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 800; color: #475569; }
        .go-btn { background: #f8fafc; color: #0f172a; font-weight: 900; padding: 8px 14px; border-radius: 12px; font-size: 13px; border: 1px solid #e2e8f0; }
        .modules-section { margin-top: 10px; }
        .modules-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .mod-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 16px; text-decoration: none; color: #0f172a; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 10px 28px rgba(15,23,42,0.05); }
        .mod-card:active { transform: scale(0.97); }
        .mod-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
        .mod-title { font-weight: 900; font-size: 14px; letter-spacing: 0.4px; }
        .mod-wide { grid-column: 1 / -1; }
        .mod-blue { background: #eff6ff; color: #2563eb; }
        .mod-green { background: #ecfdf5; color: #059669; }
        .mod-amber { background: #fff7ed; color: #d97706; }
        .mod-red { background: #fef2f2; color: #dc2626; }
        .mod-purple { background: #f5f3ff; color: #7c3aed; }
        .mod-pink { background: #fdf2f8; color: #db2777; }
        .mod-slate { background: #f8fafc; color: #334155; }
      `}</style>
    </div>
  );
}
