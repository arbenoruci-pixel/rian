'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// ------------------------- HELPERS -------------------------

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function monthKeyFromTs(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  return `${y}-${m}`; // p.sh. 2025-12
}

// ------------------------- ARKA (PAGESAT NGA GATI) -------------------------

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

function saveArkaLocal(list) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('arka_list_v1', JSON.stringify(list || []));
  } catch (e) {
    console.error('Error saving arka_list_v1', e);
  }
}

// ------------------------- WORKERS / EXPENSES / ADVANCES / DAY -------------------------

function loadWorkersLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem('workers_v1') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveWorkersLocal(list) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('workers_v1', JSON.stringify(list || []));
  } catch (e) {
    console.error('Error saving workers_v1', e);
  }
}

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
    localStorage.setItem('arka_expenses_v1', JSON.stringify(list || []));
  } catch (e) {
    console.error('Error saving arka_expenses_v1', e);
  }
}

function loadAdvancesLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem('worker_advances_v1') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAdvancesLocal(list) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('worker_advances_v1', JSON.stringify(list || []));
  } catch (e) {
    console.error('Error saving worker_advances_v1', e);
  }
}

function loadDayOpenLocal() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('arka_day_open_v1');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveDayOpenLocal(rec) {
  if (typeof window === 'undefined') return;
  try {
    if (!rec) {
      localStorage.removeItem('arka_day_open_v1');
    } else {
      localStorage.setItem('arka_day_open_v1', JSON.stringify(rec));
    }
  } catch (e) {
    console.error('Error saving arka_day_open_v1', e);
  }
}

// ------------------------- FACTORY RESET -------------------------

async function factoryResetAll(setRecords, setWorkers, setExpenses, setAdvances, setDayOpen) {
  const ok = confirm(
    'Factory reset: do të fshihen të gjitha porositë, pagesat, puntorët dhe cache lokale. Vazhdosh?'
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
  setWorkers([]);
  setExpenses([]);
  setAdvances([]);
  setDayOpen(null);

  alert('Sistemi u resetua (factory reset). Tani mund të fillosh nga zero.');
}

// ------------------------- COMPONENT -------------------------

export default function Page() {
  const [records, setRecords] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [dayOpen, setDayOpen] = useState(null);

  const [loading, setLoading] = useState(true);

  // Form state për hapjen e ditës
  const [openAmount, setOpenAmount] = useState('');

  // Form state për shpenzime
  const [expLabel, setExpLabel] = useState('');
  const [expAmount, setExpAmount] = useState('');

  // Form state për puntorë
  const [workerName, setWorkerName] = useState('');
  const [workerSalary, setWorkerSalary] = useState('');

  // Form state për avans puntori
  const [selectedWorkerId, setSelectedWorkerId] = useState('');
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [advanceNote, setAdvanceNote] = useState('');

  // Muaji për payroll
  const [selectedMonth, setSelectedMonth] = useState(() => monthKeyFromTs(Date.now()));

  async function refreshArka() {
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
        saveArkaLocal(online);
      } else {
        setRecords(loadArkaLocal());
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refreshArka();
    setWorkers(loadWorkersLocal());
    setExpenses(loadExpensesLocal());
    setAdvances(loadAdvancesLocal());
    setDayOpen(loadDayOpenLocal());
  }, []);

  // ------------------------- DERIVED VALUES -------------------------

  const todayTotalPaid = useMemo(() => {
    const now = Date.now();
    return records
      .filter((r) => r.ts && isSameDay(r.ts, now))
      .reduce((sum, r) => sum + (Number(r.paid) || 0), 0);
  }, [records]);

  const todayExpenses = useMemo(() => {
    const now = Date.now();
    return expenses.filter((e) => e.ts && isSameDay(e.ts, now));
  }, [expenses]);

  const todayExpensesSum = useMemo(() => {
    return todayExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  }, [todayExpenses]);

  const todayNetCash = useMemo(() => {
    const base = Number(dayOpen?.amount || 0);
    return base + todayTotalPaid - todayExpensesSum;
  }, [dayOpen, todayTotalPaid, todayExpensesSum]);

  const payrollSummary = useMemo(() => {
    const month = selectedMonth || monthKeyFromTs(Date.now());
    const perWorker = workers.map((w) => {
      const salary = Number(w.salary) || 0;
      const totalAdvForMonth = advances
        .filter(
          (a) =>
            a.workerId === w.id &&
            monthKeyFromTs(a.ts || Date.now()) === month
        )
        .reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
      const toPay = salary - totalAdvForMonth;
      return {
        worker: w,
        salary,
        totalAdvForMonth,
        toPay,
      };
    });
    return perWorker;
  }, [workers, advances, selectedMonth]);

  // ------------------------- ACTIONS -------------------------

  function handleOpenDay() {
    const amt = Number(openAmount || 0);
    const now = Date.now();
    const rec = {
      date: monthKeyFromTs(now) + '-DAY', // thjesht simbolik
      ts: now,
      amount: amt,
      closed: false,
    };
    setDayOpen(rec);
    saveDayOpenLocal(rec);
    alert('Dita u hap me sukses.');
  }

  function handleCloseDay() {
    if (!dayOpen) {
      alert('S’ka ditë të hapur.');
      return;
    }
    const now = Date.now();
    const updated = {
      ...dayOpen,
      closed: true,
      closedAt: now,
      closedNet: todayNetCash,
    };
    setDayOpen(updated);
    saveDayOpenLocal(updated);
    alert(
      `Dita u mbyll.\nCash neto: ${todayNetCash.toFixed(2)} €`
    );
  }

  function handleAddExpense(isWorkerExpense = false, workerId = null, noteOverride = null, amountOverride = null) {
    const now = Date.now();

    let label = expLabel.trim();
    let amount = Number(expAmount || 0);

    if (isWorkerExpense) {
      amount = Number(amountOverride || 0);
      const w = workers.find((w) => w.id === workerId);
      const workerNameSafe = w ? w.name : 'Puntor';
      label = noteOverride || `Avans ${workerNameSafe}`;
    }

    if (!label || amount <= 0) {
      if (!isWorkerExpense) {
        alert('Shëno përshkrimin dhe shumën e shpenzimit.');
      }
      return;
    }

    const newRec = {
      id: `exp_${now}_${Math.random().toString(16).slice(2)}`,
      ts: now,
      label,
      amount,
      type: isWorkerExpense ? 'worker' : 'normal',
      workerId: isWorkerExpense ? workerId : null,
    };

    const updated = [newRec, ...expenses];
    setExpenses(updated);
    saveExpensesLocal(updated);

    if (!isWorkerExpense) {
      setExpLabel('');
      setExpAmount('');
    }
  }

  function handleAddWorker() {
    const name = workerName.trim();
    const salary = Number(workerSalary || 0);
    if (!name || salary <= 0) {
      alert('Shkruaj emrin e puntorit dhe pagën mujore (>0).');
      return;
    }
    const now = Date.now();
    const newWorker = {
      id: `w_${now}_${Math.random().toString(16).slice(2)}`,
      name,
      salary,
      active: true,
    };
    const updated = [...workers, newWorker];
    setWorkers(updated);
    saveWorkersLocal(updated);
    setWorkerName('');
    setWorkerSalary('');
  }

  function handleToggleWorkerActive(id) {
    const updated = workers.map((w) =>
      w.id === id ? { ...w, active: !w.active } : w
    );
    setWorkers(updated);
    saveWorkersLocal(updated);
  }

  function handleAddAdvance() {
    if (!selectedWorkerId) {
      alert('Zgjedh puntorin.');
      return;
    }
    const amount = Number(advanceAmount || 0);
    if (amount <= 0) {
      alert('Shkruaj shumën e avansit (>0).');
      return;
    }

    const now = Date.now();
    const note = advanceNote.trim() || 'Avans';

    // 1) Regjistrojmë avansin te tabela worker_advances_v1
    const newAdv = {
      id: `adv_${now}_${Math.random().toString(16).slice(2)}`,
      workerId: selectedWorkerId,
      amount,
      note,
      ts: now,
    };
    const updatedAdv = [newAdv, ...advances];
    setAdvances(updatedAdv);
    saveAdvancesLocal(updatedAdv);

    // 2) Shtojmë edhe si shpenzim në ARKA
    handleAddExpense(true, selectedWorkerId, note, amount);

    setAdvanceAmount('');
    setAdvanceNote('');
    alert('Avansi u regjistrua dhe u llogarit si shpenzim.');
  }

  function handleChangeMonth(e) {
    setSelectedMonth(e.target.value);
  }

  // ------------------------- RENDER -------------------------

  const today = new Date();
  const thisMonthKey = monthKeyFromTs(Date.now());
  const nextMonths = [0, 1, 2].map((offset) => {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const key = monthKeyFromTs(d.getTime());
    return key;
  });

  return (
    <div className="wrap" style={{ paddingBottom: '80px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">Pagesat, shpenzimet & PAYROLL</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            SOT PAGUAN NGA GATI: <strong>{todayTotalPaid.toFixed(2)} €</strong>
          </div>
          <div>
            SHPENZIME SOT: <strong>{todayExpensesSum.toFixed(2)} €</strong>
          </div>
          <div>
            CASH NETO SOT: <strong>{todayNetCash.toFixed(2)} €</strong>
          </div>
          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 8, padding: '4px 8px', fontSize: 10 }}
            onClick={() =>
              factoryResetAll(
                setRecords,
                setWorkers,
                setExpenses,
                setAdvances,
                setDayOpen
              )
            }
          >
            RESET SISTEMIN
          </button>
        </div>
      </header>

      {/* HAP / MBYLL DITËN */}
      <section className="card">
        <h2 className="card-title">DITA E SOTME</h2>
        {dayOpen && !isSameDay(dayOpen.ts, Date.now()) && (
          <p style={{ fontSize: 12, color: '#f97316' }}>
            Ditë e hapur më herët ({new Date(dayOpen.ts).toLocaleDateString('sq-AL')}). 
            Mund të mbyllet ose të hapet e re duke bërë reset total.
          </p>
        )}
        {!dayOpen && (
          <div className="field-group">
            <label className="label">HAPE DITËN ME CASH</label>
            <div className="row">
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                placeholder="p.sh. 50 €"
                value={openAmount}
                onChange={(e) => setOpenAmount(e.target.value)}
              />
              <button
                type="button"
                className="btn primary"
                onClick={handleOpenDay}
              >
                HAP DITËN
              </button>
            </div>
          </div>
        )}
        {dayOpen && (
          <div style={{ fontSize: 12, marginTop: 4 }}>
            <div>
              HAPUR ME: <strong>{Number(dayOpen.amount || 0).toFixed(2)} €</strong> në{' '}
              {new Date(dayOpen.ts).toLocaleDateString('sq-AL')}{' '}
              {new Date(dayOpen.ts).toLocaleTimeString('sq-AL', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
            {dayOpen.closed ? (
              <div style={{ marginTop: 4, color: '#22c55e' }}>
                DITA U MBYLL NË:{' '}
                {new Date(dayOpen.closedAt || Date.now()).toLocaleTimeString('sq-AL', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                • CASH NETO: <strong>{Number(dayOpen.closedNet || 0).toFixed(2)} €</strong>
              </div>
            ) : (
              <button
                type="button"
                className="btn secondary"
                style={{ marginTop: 8 }}
                onClick={handleCloseDay}
              >
                MBYLLE DITËN
              </button>
            )}
          </div>
        )}
      </section>

      {/* LISTA E PAGESAVE NGA GATI */}
      <section className="card">
        <h2 className="card-title">PAGESAT NGA GATI</h2>
        {loading && <p>Duke i lexuar të dhënat...</p>}
        {!loading && records.length === 0 && (
          <p>Nuk ka ende pagesa të regjistruara nga GATI.</p>
        )}

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

      {/* SHPENZIMET */}
      <section className="card">
        <h2 className="card-title">SHPENZIME</h2>
        <div className="field-group">
          <label className="label">SHTO SHPENZIM</label>
          <div className="row">
            <input
              className="input"
              type="text"
              placeholder="P.sh. detergjent, naftë, qira..."
              value={expLabel}
              onChange={(e) => setExpLabel(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <input
              className="input small"
              type="number"
              min="0"
              step="0.1"
              placeholder="Shuma (€)"
              value={expAmount}
              onChange={(e) => setExpAmount(e.target.value)}
            />
            <button
              type="button"
              className="btn secondary"
              onClick={() => handleAddExpense(false)}
            >
              SHTO SHPENZIM
            </button>
          </div>
        </div>

        {todayExpenses.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>SHPENZIMET SOT:</div>
            {todayExpenses.map((e) => (
              <div key={e.id} style={{ marginBottom: 2 }}>
                • {e.label} — {Number(e.amount || 0).toFixed(2)} €{' '}
                {e.type === 'worker' && (
                  <span style={{ color: '#f97316' }}>(AVANS PUNTOR)</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* PUNTORËT */}
      <section className="card">
        <h2 className="card-title">PUNTORËT</h2>
        <div className="field-group">
          <label className="label">SHTO PUNTOR</label>
          <div className="row">
            <input
              className="input"
              type="text"
              placeholder="Emri i puntorit"
              value={workerName}
              onChange={(e) => setWorkerName(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <input
              className="input small"
              type="number"
              min="0"
              step="1"
              placeholder="Paga mujore (€)"
              value={workerSalary}
              onChange={(e) => setWorkerSalary(e.target.value)}
            />
            <button
              type="button"
              className="btn secondary"
              onClick={handleAddWorker}
            >
              SHTO
            </button>
          </div>
        </div>

        {workers.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>LISTA E PUNTORËVE:</div>
            {workers.map((w) => (
              <div
                key={w.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 4,
                }}
              >
                <div>
                  <strong>{w.name}</strong> • {Number(w.salary || 0).toFixed(2)} €/muaj{' '}
                  {!w.active && (
                    <span style={{ color: '#f97316', marginLeft: 4 }}> (JO AKTIV)</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ padding: '2px 8px', fontSize: 10 }}
                  onClick={() => handleToggleWorkerActive(w.id)}
                >
                  {w.active ? 'DEAKTIVO' : 'AKTIVO'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* AVANS PËR PUNTOR */}
      <section className="card">
        <h2 className="card-title">AVANS PËR PUNTOR</h2>
        <div className="field-group">
          <label className="label">ZGJEDH PUNTORIN</label>
          <select
            className="input"
            value={selectedWorkerId}
            onChange={(e) => setSelectedWorkerId(e.target.value)}
          >
            <option value="">— ZGJEDH —</option>
            {workers
              .filter((w) => w.active)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({Number(w.salary || 0).toFixed(2)} €/muaj)
                </option>
              ))}
          </select>
        </div>
        <div className="field-group">
          <label className="label">SHUMA & SHËNIMI</label>
          <div className="row">
            <input
              className="input small"
              type="number"
              min="0"
              step="0.1"
              placeholder="P.sh. 3 €"
              value={advanceAmount}
              onChange={(e) => setAdvanceAmount(e.target.value)}
            />
            <input
              className="input"
              type="text"
              placeholder="P.sh. kafe, ushqim..."
              value={advanceNote}
              onChange={(e) => setAdvanceNote(e.target.value)}
            />
          </div>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn primary"
            onClick={handleAddAdvance}
          >
            JEP AVANS
          </button>
        </div>
      </section>

      {/* PAYROLL MUJOR */}
      <section className="card">
        <h2 className="card-title">PAYROLL MUJOR</h2>
        <div className="field-group">
          <label className="label">MUUJI</label>
          <select
            className="input"
            value={selectedMonth}
            onChange={handleChangeMonth}
          >
            {nextMonths.map((m) => (
              <option key={m} value={m}>
                {m === thisMonthKey ? `${m} (aktual)` : m}
              </option>
            ))}
          </select>
        </div>

        {payrollSummary.length === 0 && (
          <p style={{ fontSize: 12 }}>Nuk ka puntor për payroll.</p>
        )}

        {payrollSummary.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            {payrollSummary.map(({ worker, salary, totalAdvForMonth, toPay }) => (
              <div
                key={worker.id}
                style={{
                  marginBottom: 6,
                  padding: '4px 6px',
                  borderRadius: 4,
                  border: '1px solid #374151',
                }}
              >
                <div style={{ fontWeight: 600 }}>{worker.name}</div>
                <div>
                  PAGA: <strong>{salary.toFixed(2)} €</strong> • AVANS:{' '}
                  <strong>{totalAdvForMonth.toFixed(2)} €</strong> • PËR T'U PAGU:{' '}
                  <strong
                    style={{
                      color: toPay <= 0 ? '#22c55e' : '#e5e7eb',
                    }}
                  >
                    {toPay.toFixed(2)} €
                  </strong>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}