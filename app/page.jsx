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

async function fetchTransporterNameByPin(pin){
  try{
    const p = onlyDigits(pin);
    if(!p) return '';
    const { data, error } = await supabase
      .from('users')
      .select('name,pin')
      .eq('pin', p)
      .limit(1);
    if(error) return '';
    const row = Array.isArray(data) ? data[0] : null;
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

    // PWA helper: open internal pages without an address bar
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
        // Transport codes are stored as client_tcode like T352
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
        .select('id,code,code_n,status,client_name,client_phone,data,updated_at')
        .eq('code_n', n)
        .order('updated_at', { ascending: false })
        .limit(10);

      if(error) throw new Error(error.message);

      const rows = Array.isArray(data) ? data : [];
      const out = [];
      for(const r of rows){
        const transport_id = r?.data?.transport_id ?? r?.data?.transportId ?? null;
        const transporter = transport_id ? await fetchTransporterNameByPin(transport_id) : '';
        out.push({
          kind:'B',
          code: String(r?.code ?? r?.code_n ?? n),
          status: r?.status || '',
          name: r?.client_name || '',
          phone: r?.client_phone || '',
          transporter,
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
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TEPIHA • HOME</h1>
          <div className="subtitle">KOMPANIA PER LARJEN E TEPIHAVE</div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">KËRKO ME KOD</h2>

        <form className="row" onSubmit={runSearch}>
          <input
            className="inp"
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            placeholder="SHKRUAJ KODIN… (3 / T3)"
            inputMode="text"
          />
          <button className="btn" type="submit" disabled={loading}>
            {loading ? 'DUKE KËRKU…' : 'KËRKO'}
          </button>
        </form>

        {err ? <div className="warn" style={{marginTop:10}}>{err}</div> : null}

        {results?.length ? (
          <div style={{marginTop:12, display:'grid', gap:10}}>
            {results.map((r, idx) => {
              const href = (r.kind === 'T')
                ? (`${r.id ? `/transport/item?id=${encodeURIComponent(String(r.id||''))}` : `/transport/menu`}`)
                : (`${routeForStatus(r.status)}?q=${encodeURIComponent(String(r.code||''))}`);

              return (
                <Link key={r.id || idx} href={href + (href.includes('?') ? '&' : '?') + 'nogate=1&from=search'} className="order-row">
                  <div className="order-left">
                    <div className="order-code">{String(r.code||'')}</div>
                    <div className="order-sub">
                      <span className="pill">{String(r.status||'PA STATUS').toUpperCase()}</span>
                      {r.transporter ? <span className="pill pill-soft">PRU: {String(r.transporter).toUpperCase()}</span> : null}
                    </div>
                    <div className="order-name">{String(r.name||'')}</div>
                    {r.phone ? <div className="order-phone">{String(r.phone||'')}</div> : null}
                    {(r?._audit?.created_by_name || r?.created_by_name || r?.created_by || r?.created_by_pin) ? (
                      <div className="order-phone">SJELL: {String(r._audit?.created_by_name || r.created_by_name || r.created_by || r.created_by_pin)}</div>
                    ) : null}
                  </div>
                  <div className="order-go">HAP</div>
                </Link>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card-title">ZGJEDH MODULIN</h2>
        <div className="home-nav">
          <Link className="home-btn" href="/pranimi">
            <span>🧾</span>
            <div>
              <div>PRANIMI</div>
              <small>Regjistro klientin &amp; tepihat</small>
            </div>
          </Link>
          <Link className="home-btn" href="/pastrimi">
            <span>🧼</span>
            <div>
              <div>PASTRIMI</div>
              <small>Lista në pastrim + detaje</small>
            </div>
          </Link>
          <Link className="home-btn" href="/gati">
            <span>✅</span>
            <div>
              <div>GATI</div>
              <small>Gati për marrje</small>
            </div>
          </Link>
          <Link className="home-btn" href="/marrje-sot">
            <span>📦</span>
            <div>
              <div>MARRJE SOT</div>
              <small>Planifiko dorëzimet e sotme</small>
            </div>
          </Link>
          <Link className="home-btn" href="/transport">
            <span>🚚</span>
            <div>
              <div>TRANSPORT</div>
              <small>Porosi &amp; dorëzime (T-kode)</small>
            </div>
          </Link>
          <Link className="home-btn" href="/arka">
            <span>💰</span>
            <div>
              <div>ARKA</div>
              <small>CASH • HAPE / MBYLLE DITËN</small>
            </div>
          </Link>
          <Link className="home-btn" href="/fletore">
            <span>📒</span>
            <div>
              <div>FLETORJA</div>
              <small>Backup / Ledger</small>
            </div>
          </Link>
        </div>
      </section>
    </div>
  );
}
