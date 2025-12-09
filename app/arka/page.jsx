'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// ---------- HELPERS ----------

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isWithinLastDays(ts, days) {
  const now = Date.now();
  const diff = now - (ts || 0);
  return diff >= 0 && diff <= days * 24 * 60 * 60 * 1000;
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

// ---------- COMPONENT ----------

export default function Page() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

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
    refresh();
  }, []);

  const todayTotal = useMemo(() => {
    const now = Date.now();
    return records
      .filter((r) => r.ts && isSameDay(r.ts, now))
      .reduce((sum, r) => sum + (Number(r.paid) || 0), 0);
  }, [records]);

  const weekTotal = useMemo(() => {
    return records
      .filter((r) => r.ts && isWithinLastDays(r.ts, 7))
      .reduce((sum, r) => sum + (Number(r.paid) || 0), 0);
  }, [records]);

  const grandTotal = useMemo(
    () => records.reduce((sum, r) => sum + (Number(r.paid) || 0), 0),
    [records]
  );

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">Pagesat nga porositë GATI / MARRJE</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            SOT: <strong>{todayTotal.toFixed(2)} €</strong>
          </div>
          <div>
            7 DITËT E FUNDIT: <strong>{weekTotal.toFixed(2)} €</strong>
          </div>
          <div>
            TOTALI: <strong>{grandTotal.toFixed(2)} €</strong>
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
        <h2 className="card-title">Lista e pagesave</h2>
        {loading && <p>Duke i lexuar të dhënat...</p>}
        {!loading && records.length === 0 && <p>Nuk ka ende pagesa të regjistruara.</p>}

        {!loading &&
          records.map((r) => (
            <div key={r.id} className="home-btn">
              <div className="home-btn-main">
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {r.code ? `KODI: ${r.code}` : 'PA KOD'}
                  </div>
                  <div style={{ fontSize: 12 }}>
                    {r.name || 'Klient pa emër'} • {(r.phone || '').trim()}
                  </div>
                  {(r.worker || r.source) && (
                    <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                      {r.worker && <span>Punëtor: {r.worker}</span>}
                      {r.worker && r.source && <span> • </span>}
                      {r.source && <span>Burimi: {r.source}</span>}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  <div>
                    <strong>{(Number(r.paid) || 0).toFixed(2)} €</strong>
                  </div>
                  <div>
                    {new Date(r.ts || Date.now()).toLocaleString('sq-AL', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              </div>
            </div>
          ))}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}