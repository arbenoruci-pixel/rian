'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// -------- HELPERS --------

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function getAmount(rec) {
  // për kompatibilitet: nqs ka amount, merr atë, përndryshe paid
  if (typeof rec.amount === 'number') return Number(rec.amount) || 0;
  if (typeof rec.paid === 'number') return Number(rec.paid) || 0;
  return 0;
}

function formatType(rec) {
  const t = rec.type || 'IN_GATI';
  switch (t) {
    case 'OPEN':
      return { label: 'OPEN', color: '#0ea5e9' };
    case 'CLOSE':
      return { label: 'CLOSE', color: '#1d4ed8' };
    case 'IN_GATI':
      return { label: 'GATI', color: '#16a34a' };
    case 'IN_TRANSPORT':
      return { label: 'TRANSPORT', color: '#22c55e' };
    case 'IN_OTHER':
      return { label: 'HYRJE TJETËR', color: '#22c55e' };
    case 'OUT_SH_PENZIM':
      return { label: 'SHPENZIM', color: '#ea580c' };
    case 'OUT_TRANSFER':
      return { label: 'TRANSFER', color: '#f97316' };
    default:
      return { label: t, color: '#6b7280' };
  }
}

function formatMethod(rec) {
  const m = rec.method || 'cash';
  if (m === 'card') return 'KARTELË';
  if (m === 'bank') return 'BANKË';
  return 'CASH';
}

async function loadArkaFromSupabase() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('arka', {
    limit: 1000,
  });
  if (error || !data) return [];

  const list = [];
  for (const item of data) {
    if (!item || !item.name) continue;
    try {
      const { data: file, error: dErr } = await supabase.storage
        .from(BUCKET)
        .download(`arka/${item.name}`);
      if (dErr || !file) continue;
      const text = await file.text();
      const rec = JSON.parse(text);
      if (rec && rec.id) list.push(rec);
    } catch (e) {
      console.error('Error parsing arka record', item.name, e);
    }
  }

  list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return list;
}

function loadArkaLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem('arka_list_v1') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function factoryResetAll(setRecords) {
  const ok = confirm(
    'Factory reset: do të fshihen të gjitha porositë, pagesat dhe cache lokale. Vazhdosh?'
  );
  if (!ok) return;

  try {
    if (supabase) {
      const folders = ['orders', 'arka'];
      for (const folder of folders) {
        const { data, error } = await supabase.storage.from(BUCKET).list(folder, {
          limit: 1000,
        });
        if (!error && data && data.length > 0) {
          const paths = data.map((item) => `${folder}/${item.name}`);
          if (paths.length > 0) {
            await supabase.storage.from(BUCKET).remove(paths);
          }
        }
      }
    }
  } catch (e) {
    console.error('Error during factory reset Supabase', e);
  }

  if (typeof window !== 'undefined') {
    try {
      localStorage.clear();
    } catch (e) {
      console.error('Error clearing localStorage', e);
    }
  }

  setRecords([]);
  alert('Sistemi u resetua (factory reset). Tani mund të fillosh nga zero.');
}

// -------- COMPONENT --------

export default function Page() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workerName, setWorkerName] = useState('');

  async function refresh() {
    try {
      setLoading(true);
      let online = [];
      try {
        online = await loadArkaFromSupabase();
      } catch (e) {
        console.error('Error loading ARKA from Supabase, fallback local', e);
      }
      if (online && online.length > 0) {
        setRecords(online);
      } else {
        setRecords(loadArkaLocal());
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // lexojmë punëtorin aktiv nga localStorage
    try {
      const w = localStorage.getItem('arka_worker_name') || '';
      setWorkerName(w);
    } catch {
      setWorkerName('');
    }
    refresh();
  }, []);

  function handleWorkerChange(e) {
    const v = e.target.value;
    setWorkerName(v);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('arka_worker_name', v);
      } catch {
        // ignore
      }
    }
  }

  const now = Date.now();

  const todayTotal = useMemo(() => {
    return records
      .filter((r) => r.ts && isSameDay(r.ts, now))
      .reduce((sum, r) => {
        const amt = getAmount(r);
        const t = r.type || 'IN_GATI';
        if (t.startsWith('OUT_')) return sum - amt;
        return sum + amt;
      }, 0);
  }, [records, now]);

  const todayIn = useMemo(() => {
    return records
      .filter((r) => r.ts && isSameDay(r.ts, now) && !(r.type || '').startsWith('OUT_'))
      .reduce((sum, r) => sum + getAmount(r), 0);
  }, [records, now]);

  const todayOut = useMemo(() => {
    return records
      .filter((r) => r.ts && isSameDay(r.ts, now) && (r.type || '').startsWith('OUT_'))
      .reduce((sum, r) => sum + getAmount(r), 0);
  }, [records, now]);

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">Pagesat & shpenzimet nga porositë GATI / TRANSPORT</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            HYRJE SOT: <strong>{todayIn.toFixed(2)} €</strong>
          </div>
          <div>
            DALJE SOT: <strong>{todayOut.toFixed(2)} €</strong>
          </div>
          <div>
            BALANC SOT: <strong>{todayTotal.toFixed(2)} €</strong>
          </div>

          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 10, opacity: 0.8, display: 'block' }}>
              PUNËTORI AKTIV (ruhet në këtë pajisje)
            </label>
            <input
              className="input"
              style={{ fontSize: 11, padding: '4px 6px' }}
              type="text"
              value={workerName}
              onChange={handleWorkerChange}
              placeholder="p.sh. Ardi, Narta..."
            />
          </div>

          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 8, padding: '4px 8px', fontSize: 10 }}
            onClick={() => factoryResetAll(setRecords)}
          >
            RESET SISTEMIN
          </button>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Lista e lëvizjeve në ARKË</h2>
        {loading && <p>Duke i lexuar të dhënat...</p>}
        {!loading && records.length === 0 && <p>Nuk ka ende lëvizje të regjistruara.</p>}

        {!loading &&
          records.map((r) => {
            const amt = getAmount(r);
            const typeInfo = formatType(r);
            const dt = new Date(r.ts || Date.now());

            return (
              <div key={r.id} className="home-btn" style={{ marginBottom: 6 }}>
                <div className="home-btn-main" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          backgroundColor: typeInfo.color,
                          color: '#fff',
                        }}
                      >
                        {typeInfo.label}
                      </span>
                      {r.source && (
                        <span
                          style={{
                            fontSize: 10,
                            opacity: 0.8,
                            borderRadius: 4,
                            padding: '1px 4px',
                            border: '1px solid rgba(255,255,255,0.1)',
                          }}
                        >
                          {r.source}
                        </span>
                      )}
                      {r.method && (
                        <span style={{ fontSize: 10, opacity: 0.8 }}>
                          {formatMethod(r)}
                        </span>
                      )}
                    </div>

                    <div style={{ fontWeight: 700, marginTop: 4 }}>
                      {r.code ? `KODI: ${r.code}` : r.orderId ? `ORDER: ${r.orderId}` : 'PA KOD'}
                    </div>
                    <div style={{ fontSize: 12 }}>
                      {r.name || 'Klient pa emër'} • {(r.phone || '').trim()}
                    </div>
                    {r.user && (
                      <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                        nga: <strong>{r.user}</strong>
                      </div>
                    )}
                    {r.note && (
                      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
                        {r.note}
                      </div>
                    )}
                  </div>

                  <div style={{ textAlign: 'right', fontSize: 12 }}>
                    <div>
                      <strong>
                        {(typeInfo.label.startsWith('SHPENZIM') ||
                        (r.type || '').startsWith('OUT_')
                          ? '-'
                          : '+')}
                        {amt.toFixed(2)} €
                      </strong>
                    </div>
                    <div>
                      {dt.toLocaleDateString('sq-AL', {
                        day: '2-digit',
                        month: '2-digit',
                      })}{' '}
                      {dt.toLocaleTimeString('sq-AL', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}