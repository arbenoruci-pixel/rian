'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// -------------------- HELPERS TË PËRGJITHSHME --------------------

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// -------------------- PAGESAT (nga GATI) --------------------

async function loadPaymentsFromSupabase() {
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

function loadPaymentsLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem('arka_list_v1') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// -------------------- DITA (HAP / MBYLL) --------------------

function loadOpenDayLocal() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('arka_open_day_v1');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.date !== todayKey()) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveOpenDayLocal(day) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('arka_open_day_v1', JSON.stringify(day));
  } catch {
    // ignore
  }
}

// -------------------- SHPENZIMET --------------------

function loadExpensesLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem('arka_expenses_v1') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveExpensesLocal(list) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('arka_expenses_v1', JSON.stringify(list));
  } catch {
    // ignore
  }
}

// -------------------- KOMPONENTA KRYESORE --------------------

export default function Page() {
  const [payments, setPayments] = useState([]);   // krejt pagesat (dita sot + të vjetrat)
  const [openDay, setOpenDay] = useState(null);   // {date, openCash, openedAt, closedAt?}
  const [expenses, setExpenses] = useState([]);   // krejt shpenzimet (të gjitha ditët)
  const [loading, setLoading] = useState(true);

  // input për shpenzim të ri
  const [expLabel, setExpLabel] = useState('');
  const [expAmount, setExpAmount] = useState('');

  async function refresh() {
    try {
      setLoading(true);

      // pagesat (nga Supabase -> fallback local)
      let online = [];
      try {
        online = await loadPaymentsFromSupabase();
      } catch (e) {
        console.error('Error loading ARKA from Supabase, fallback local', e);
      }
      if (online && online.length > 0) setPayments(online);
      else setPayments(loadPaymentsLocal());

      // dita e hapur & shpenzimet nga localStorage
      setOpenDay(loadOpenDayLocal());
      setExpenses(loadExpensesLocal());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refresh();
  }, []);

  const now = Date.now();
  const todayPayments = useMemo(
    () => payments.filter((r) => r.ts && isSameDay(r.ts, now)),
    [payments, now],
  );

  const todayExpenses = useMemo(
    () => expenses.filter((e) => e.date === todayKey()),
    [expenses],
  );

  const sumPaymentsToday = useMemo(
    () =>
      todayPayments.reduce((sum, r) => sum + (Number(r.paid) || 0), 0),
    [todayPayments],
  );

  const sumExpensesToday = useMemo(
    () =>
      todayExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
    [todayExpenses],
  );

  const openCash = openDay?.openCash ? Number(openDay.openCash) || 0 : 0;

  const closingCash = useMemo(
    () => openCash + sumPaymentsToday - sumExpensesToday,
    [openCash, sumPaymentsToday, sumExpensesToday],
  );

  // -------------------- AKSIONE --------------------

  async function handleOpenDay() {
    if (openDay && openDay.date === todayKey()) {
      alert('Dita e sotme veç është e hapur.');
      return;
    }

    const val = prompt(
      'Shuma e cash-it në arkë në fillim të ditës (€)?\n\nP.sh. 100'
    );
    if (val === null) return;

    const amt = Number(String(val).replace(',', '.')) || 0;
    const day = {
      date: todayKey(),
      openCash: Number(amt.toFixed(2)),
      openedAt: Date.now(),
      closedAt: null,
    };
    setOpenDay(day);
    saveOpenDayLocal(day);
    alert(
      `Dita u hap.\nCash në fillim: ${day.openCash.toFixed(2)} €`
    );
  }

  async function handleCloseDay() {
    if (!openDay || openDay.date !== todayKey()) {
      alert('Nuk ka ditë të hapur për sot.');
      return;
    }

    const msg =
      `Mbyllja e ditës ${openDay.date}:\n\n` +
      `HAPJA:  ${openCash.toFixed(2)} €\n` +
      `HYRJE (pagesat sot):  ${sumPaymentsToday.toFixed(2)} €\n` +
      `DALJE (shpenzimet sot):  ${sumExpensesToday.toFixed(2)} €\n` +
      '---------------------------------\n' +
      `CASH NË FUND (teorik):  ${closingCash.toFixed(2)} €\n\n` +
      'Je i sigurt që dëshiron ta mbyllësh ditën?';

    const ok = confirm(msg);
    if (!ok) return;

    const day = {
      ...openDay,
      closedAt: Date.now(),
    };
    setOpenDay(day);
    saveOpenDayLocal(day);
    alert('Dita u mbyll. Ruaje këtë shumë me arkën fizike.');
  }

  function handleAddExpense() {
    const amt = Number(String(expAmount).replace(',', '.')) || 0;
    if (!amt || amt <= 0) {
      alert('Shuma e shpenzimit duhet të jetë më e madhe se zero.');
      return;
    }

    const label = (expLabel || '').trim() || 'Shpenzim';
    const rec = {
      id: `exp_${Date.now()}`,
      date: todayKey(),
      ts: Date.now(),
      label,
      amount: Number(amt.toFixed(2)),
    };

    const next = [rec, ...expenses];
    setExpenses(next);
    saveExpensesLocal(next);
    setExpLabel('');
    setExpAmount('');
  }

  async function handleFactoryReset() {
    const ok = confirm(
      'Factory reset: do të fshihen të gjitha porositë, pagesat, arkët dhe cache lokale. Vazhdosh?'
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

    setPayments([]);
    setExpenses([]);
    setOpenDay(null);
    alert(
      'Sistemi u resetua (factory reset). Tani mund të fillosh nga zero.'
    );
  }

  // -------------------- RENDER --------------------

  return (
    <div className="wrap" style={{ paddingBottom: '80px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">Hap / mbyll ditën, pagesat & shpenzimet</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            CASH SOT (teorik):{' '}
            <strong>{closingCash.toFixed(2)} €</strong>
          </div>
          <div style={{ marginTop: 4 }}>
            <button
              type="button"
              className="btn secondary"
              style={{ padding: '4px 8px', fontSize: 10 }}
              onClick={handleFactoryReset}
            >
              RESET SISTEMIN
            </button>
          </div>
        </div>
      </header>

      {/* KARTA E DITËS SOTME */}
      <section className="card">
        <h2 className="card-title">Dita e sotme ({todayKey()})</h2>

        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <button
            type="button"
            className="btn secondary"
            style={{
              flex: 1,
              fontSize: 11,
            }}
            onClick={handleOpenDay}
          >
            HAPE DITËN
          </button>
          <button
            type="button"
            className="btn secondary"
            style={{
              flex: 1,
              fontSize: 11,
            }}
            onClick={handleCloseDay}
          >
            MBYLLE DITËN
          </button>
        </div>

        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <div>
            HAPJA:{' '}
            <strong>{openCash.toFixed(2)} €</strong>
          </div>
          <div>
            HYRJE SOT (nga GATI):{' '}
            <strong>{sumPaymentsToday.toFixed(2)} €</strong>
          </div>
          <div>
            SHPENZIME SOT:{' '}
            <strong>{sumExpensesToday.toFixed(2)} €</strong>
          </div>
          <div style={{ marginTop: 4 }}>
            CASH NË FUND (teorik):{' '}
            <strong>{closingCash.toFixed(2)} €</strong>
          </div>
          {openDay && openDay.closedAt && (
            <div style={{ marginTop: 4, fontSize: 11, color: '#f97316' }}>
              * Dita është shënuar si e mbyllur.
            </div>
          )}
        </div>
      </section>

      {/* PAGESAT SOT */}
      <section className="card">
        <h2 className="card-title">Pagesat sot nga GATI</h2>
        {loading && <p>Duke i lexuar të dhënat...</p>}
        {!loading && todayPayments.length === 0 && (
          <p>Nuk ka ende pagesa të regjistruara sot.</p>
        )}

        {!loading &&
          todayPayments.map((r) => (
            <div key={r.id} className="home-btn">
              <div className="home-btn-main">
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {r.code ? `KODI: ${r.code}` : 'PA KOD'}
                  </div>
                  <div style={{ fontSize: 12 }}>
                    {r.name || 'Klient pa emër'} • {(r.phone || '').trim()}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  <div>
                    <strong>{(Number(r.paid) || 0).toFixed(2)} €</strong>
                  </div>
                  <div>
                    {new Date(r.ts || Date.now()).toLocaleTimeString('sq-AL', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              </div>
            </div>
          ))}
      </section>

      {/* SHPENZIMET SOT */}
      <section className="card">
        <h2 className="card-title">Shpenzimet sot</h2>

        <div className="field-group">
          <label className="label">Përshkrimi i shpenzimit</label>
          <input
            className="input"
            type="text"
            placeholder="P.sh. naftë, detergjent, qira..."
            value={expLabel}
            onChange={(e) => setExpLabel(e.target.value)}
          />
        </div>
        <div className="field-group">
          <label className="label">Shuma (€)</label>
          <input
            className="input"
            type="number"
            min="0"
            step="0.1"
            value={expAmount}
            onChange={(e) => setExpAmount(e.target.value)}
          />
        </div>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="btn primary"
            onClick={handleAddExpense}
          >
            SHTO SHPENZIM
          </button>
        </div>

        {todayExpenses.length === 0 && (
          <p>Ende nuk ka shpenzime të regjistruara sot.</p>
        )}

        {todayExpenses.map((e) => (
          <div key={e.id} className="home-btn">
            <div className="home-btn-main">
              <div>
                <div style={{ fontWeight: 700 }}>{e.label}</div>
                <div style={{ fontSize: 11, opacity: 0.9 }}>
                  {new Date(e.ts).toLocaleTimeString('sq-AL', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 12 }}>
                <strong>-{e.amount.toFixed(2)} €</strong>
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