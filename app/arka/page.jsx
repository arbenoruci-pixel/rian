'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// ------------- HELPERS PËR PAGESA (ARKA E VJETËR) -------------

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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

// ------------- USERS & ROLET (LOKALE) -------------

const USERS_KEY = 'arka_users_v1';
const CURRENT_USER_KEY = 'arka_current_user_v1';
const MASTER_PIN = '4563';

const ROLE_LABELS = {
  admin: 'ADMIN',
  worker: 'PUNTOR',
  transport: 'TRANSPORT',
  dispatch: 'DISPATCH',
};

function loadUsers() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
    let users = Array.isArray(raw) ? raw : [];
    if (!users.length) {
      users = [
        {
          id: 'admin-1',
          name: 'ADMIN',
          pin: MASTER_PIN,
          role: 'admin',
        },
      ];
      localStorage.setItem(USERS_KEY, JSON.stringify(users));
    }
    return users;
  } catch {
    const users = [
      {
        id: 'admin-1',
        name: 'ADMIN',
        pin: MASTER_PIN,
        role: 'admin',
      },
    ];
    if (typeof window !== 'undefined') {
      localStorage.setItem(USERS_KEY, JSON.stringify(users));
    }
    return users;
  }
}

function saveUsers(users) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function findUserByPin(users, pin) {
  return users.find((u) => u.pin === pin);
}

function loadCurrentUser(users) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || 'null');
    if (!raw || !raw.id) return null;
    const found = users.find((u) => u.id === raw.id);
    return found || null;
  } catch {
    return null;
  }
}

function saveCurrentUser(user) {
  if (typeof window === 'undefined') return;
  if (user) {
    localStorage.setItem(
      CURRENT_USER_KEY,
      JSON.stringify({ id: user.id, role: user.role }),
    );
  } else {
    localStorage.removeItem(CURRENT_USER_KEY);
  }
}

// ------------- DITA E SOTME, BUXHETI & LËVIZJET -------------

const BUDGET_KEY = 'arka_budget_total_v1';

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayStorageKey() {
  return `arka_day_${todayKey()}`;
}
function movesStorageKey() {
  return `arka_moves_${todayKey()}`;
}

function loadBudget() {
  if (typeof window === 'undefined') return 0;
  try {
    const v = Number(localStorage.getItem(BUDGET_KEY));
    return isNaN(v) ? 0 : v;
  } catch {
    return 0;
  }
}

function saveBudget(v) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(BUDGET_KEY, String(v));
}

function loadDay() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = JSON.parse(localStorage.getItem(dayStorageKey()) || 'null');
    return raw;
  } catch {
    return null;
  }
}

function saveDay(day) {
  if (typeof window === 'undefined') return;
  if (!day) {
    localStorage.removeItem(dayStorageKey());
  } else {
    localStorage.setItem(dayStorageKey(), JSON.stringify(day));
  }
}

function loadMoves() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(movesStorageKey()) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveMoves(moves) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(movesStorageKey(), JSON.stringify(moves));
}

// movement: { id, ts, type: 'expense'|'advance'|'topup', source:'arka'|'budget'|'external', amount, who?, note?, byUserName, byUserRole }

async function factoryResetAll(currentUser, setRecords, setDay, setMoves, setBudget) {
  if (!currentUser || currentUser.role !== 'admin') {
    alert('Vetëm ADMINI mund ta përdor reset-in.');
    return;
  }
  const pin = prompt('Shkruaj PIN-in e ADMINIT për reset:');
  if (pin !== currentUser.pin) {
    alert('PIN i gabuar. Reset u anullua.');
    return;
  }
  const ok = confirm(
    'Factory reset: do të fshihen të gjitha POROSITË dhe PAGESAT (ARKA), si dhe të dhënat ditore. PËRDORUESIT do të mbesin. Vazhdon?',
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
      localStorage.removeItem('order_list_v1');
      localStorage.removeItem('arka_list_v1');
      localStorage.removeItem(BUDGET_KEY);

      const keys = Object.keys(localStorage);
      for (const k of keys) {
        if (k.startsWith('order_')) localStorage.removeItem(k);
        if (k.startsWith('arka_day_')) localStorage.removeItem(k);
        if (k.startsWith('arka_moves_')) localStorage.removeItem(k);
      }
    } catch (e) {
      console.error('Error clearing localStorage for reset', e);
    }
  }

  setRecords([]);
  setDay(null);
  setMoves([]);
  setBudget(0);

  alert('Sistemi u resetua. Përdoruesit dhe PIN-at mbetën.');
}

// ------------- KOMPONENTI KRYESOR -------------

export default function Page() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [pinInput, setPinInput] = useState('');

  const [newUserName, setNewUserName] = useState('');
  const [newUserPin, setNewUserPin] = useState('');
  const [newUserRole, setNewUserRole] = useState('worker');

  const [day, setDay] = useState(null);
  const [budget, setBudget] = useState(0);
  const [moves, setMoves] = useState([]);

  const [openCashInput, setOpenCashInput] = useState('');

  const [expAmount, setExpAmount] = useState('');
  const [expSource, setExpSource] = useState('arka'); // arka | budget
  const [expNote, setExpNote] = useState('');

  const [advAmount, setAdvAmount] = useState('');
  const [advSource, setAdvSource] = useState('arka');
  const [advWho, setAdvWho] = useState('');
  const [advNote, setAdvNote] = useState('');

  const [topAmount, setTopAmount] = useState('');
  const [topWho, setTopWho] = useState('');
  const [topNote, setTopNote] = useState('');

  // ngarkojmë user-at dhe currentUser
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = loadUsers();
    setUsers(u);
    const cu = loadCurrentUser(u);
    if (cu) setCurrentUser(cu);
  }, []);

  async function refreshRecords() {
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
    refreshRecords();
  }, []);

  // ngarkojmë buxhetin / ditën / lëvizjet kur ka user
  useEffect(() => {
    if (!currentUser) return;
    if (typeof window === 'undefined') return;
    setBudget(loadBudget());
    setDay(loadDay());
    setMoves(loadMoves());
  }, [currentUser]);

  const todayTotal = useMemo(() => {
    const now = Date.now();
    return records
      .filter((r) => r.ts && isSameDay(r.ts, now))
      .reduce((sum, r) => sum + (Number(r.paid) || 0), 0);
  }, [records]);

  const cashOutFromArka = useMemo(
    () =>
      moves
        .filter(
          (m) =>
            (m.type === 'expense' || m.type === 'advance') &&
            m.source === 'arka',
        )
        .reduce((sum, m) => sum + (Number(m.amount) || 0), 0),
    [moves],
  );

  const cashStart = Number(day?.cashStart || 0) || 0;
  const cashEndCalc = useMemo(
    () => Number((cashStart + todayTotal - cashOutFromArka).toFixed(2)),
    [cashStart, todayTotal, cashOutFromArka],
  );

  // ---------- LOGIN ----------

  function handleLogin(e) {
    e?.preventDefault?.();
    const pin = (pinInput || '').trim();
    if (!pin) {
      alert('Shkruaj PIN-in.');
      return;
    }
    const u = findUserByPin(users, pin);
    if (!u) {
      alert('PIN i gabuar.');
      return;
    }
    setCurrentUser(u);
    saveCurrentUser(u);
    setPinInput('');
  }

  function handleLogout() {
    setCurrentUser(null);
    saveCurrentUser(null);
  }

  // ---------- ADMIN USER MANAGEMENT ----------

  function isAdmin() {
    return currentUser && currentUser.role === 'admin';
  }

  function handleAddUser(e) {
    e?.preventDefault?.();
    const name = newUserName.trim();
    const pin = newUserPin.trim();
    if (!name || !pin) {
      alert('Emri dhe PIN-i janë të detyrueshëm.');
      return;
    }
    if (pin.length < 4) {
      alert('PIN rekomandohet të ketë së paku 4 shifra.');
      return;
    }
    if (findUserByPin(users, pin)) {
      alert('Ky PIN tashmë ekziston.');
      return;
    }

    const user = {
      id: `u-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      name,
      pin,
      role: newUserRole,
    };
    const updated = [user, ...users];
    setUsers(updated);
    saveUsers(updated);
    setNewUserName('');
    setNewUserPin('');
    setNewUserRole('worker');
  }

  function handleChangeRole(userId, newRole) {
    const updated = users.map((u) =>
      u.id === userId ? { ...u, role: newRole } : u,
    );
    setUsers(updated);
    saveUsers(updated);
    if (currentUser && currentUser.id === userId) {
      const me = updated.find((u) => u.id === userId);
      setCurrentUser(me || null);
      saveCurrentUser(me || null);
    }
  }

  function handleDeleteUser(userId) {
    const u = users.find((x) => x.id === userId);
    if (!u) return;
    if (u.role === 'admin') {
      alert('Mos e fshij admin-in bazë.');
      return;
    }
    const ok = confirm(`Me fshi përdoruesin "${u.name}"?`);
    if (!ok) return;
    const updated = users.filter((x) => x.id !== userId);
    setUsers(updated);
    saveUsers(updated);
  }

  // ---------- DITA E SOTME & BUXHET ----------

  function handleOpenDay() {
    const val = Number(openCashInput || 0);
    if (isNaN(val) || val < 0) {
      alert('Shkruaj një shumë valide për CASH START.');
      return;
    }
    const d = {
      dateKey: todayKey(),
      openedByName: currentUser?.name || 'ADMIN',
      openedByRole: currentUser?.role || 'admin',
      openedTs: Date.now(),
      cashStart: val,
      closed: false,
      closedTs: null,
      transferred: 0,
    };
    setDay(d);
    saveDay(d);
    setOpenCashInput('');
  }

  function handleCloseDay() {
    if (!day) {
      alert('Së pari hape ditën.');
      return;
    }
    if (day.closed) {
      alert('Dita tashmë është e mbyllur.');
      return;
    }
    const msg =
      `Cash në fund të ditës: ${cashEndCalc.toFixed(2)} €.\n` +
      `Dëshiron ta mbyllësh ditën dhe ta shtosh këtë shumë në BUXHETIN e kompanisë?`;
    const ok = confirm(msg);
    if (!ok) return;
    const newBudget = Number((budget + cashEndCalc).toFixed(2));
    setBudget(newBudget);
    saveBudget(newBudget);

    const d = {
      ...day,
      closed: true,
      closedTs: Date.now(),
      transferred: cashEndCalc,
    };
    setDay(d);
    saveDay(d);
    alert('Dita u mbyll dhe shuma u shtua në buxhet.');
  }

  // ---------- SHPENZIM I RI ----------

  function addMove(m) {
    const updated = [m, ...moves];
    setMoves(updated);
    saveMoves(updated);
  }

  function handleAddExpense() {
    const amount = Number(expAmount || 0);
    if (!amount || amount <= 0) {
      alert('Shkruaj shumën e shpenzimit.');
      return;
    }
    const m = {
      id: `m-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      ts: Date.now(),
      type: 'expense',
      source: expSource, // arka/budget
      amount,
      note: expNote.trim(),
      byUserName: currentUser?.name || '',
      byUserRole: currentUser?.role || '',
    };
    addMove(m);

    if (expSource === 'budget') {
      const nb = Number((budget - amount).toFixed(2));
      setBudget(nb);
      saveBudget(nb);
    }
    setExpAmount('');
    setExpNote('');
    setExpSource('arka');
  }

  // ---------- AVANS PËR PUNTOR ----------

  function handleAddAdvance() {
    const amount = Number(advAmount || 0);
    if (!advWho.trim()) {
      alert('Shkruaj emrin e puntorit.');
      return;
    }
    if (!amount || amount <= 0) {
      alert('Shkruaj shumën e avansit.');
      return;
    }
    const m = {
      id: `m-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      ts: Date.now(),
      type: 'advance',
      source: advSource,
      amount,
      who: advWho.trim(),
      note: advNote.trim(),
      byUserName: currentUser?.name || '',
      byUserRole: currentUser?.role || '',
    };
    addMove(m);

    if (advSource === 'budget') {
      const nb = Number((budget - amount).toFixed(2));
      setBudget(nb);
      saveBudget(nb);
    }
    setAdvAmount('');
    setAdvWho('');
    setAdvNote('');
    setAdvSource('arka');
  }

  // ---------- TOP-UP BUXHETI (DIKUSH I JEP PARA KOMPANIS) ----------

  function handleAddTopup() {
    const amount = Number(topAmount || 0);
    if (!amount || amount <= 0) {
      alert('Shkruaj shumën e top-up-it.');
      return;
    }
    const m = {
      id: `m-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      ts: Date.now(),
      type: 'topup',
      source: 'external',
      amount,
      who: topWho.trim(),
      note: topNote.trim(),
      byUserName: currentUser?.name || '',
      byUserRole: currentUser?.role || '',
    };
    addMove(m);

    const nb = Number((budget + amount).toFixed(2));
    setBudget(nb);
    saveBudget(nb);

    setTopAmount('');
    setTopWho('');
    setTopNote('');
  }

  // ---------- LOGIN SCREEN NËSE S'KA USER ----------

  if (!currentUser) {
    return (
      <div className="wrap">
        <header className="header-row">
          <div>
            <h1 className="title">ARKA</h1>
            <div className="subtitle">HYRJE ME PIN</div>
          </div>
        </header>

        <section className="card">
          <h2 className="card-title">SHKRUJ PIN-IN</h2>
          <form
            onSubmit={handleLogin}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <input
              className="input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="PIN (p.sh. 4563)"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
            />
            <button type="submit" className="btn primary">
              HYR NË ARKË
            </button>
          </form>
          <p style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>
            * PIN-i i parë default është <strong>4563</strong> (ADMIN).
          </p>
        </section>

        <footer className="footer-bar">
          <Link className="btn secondary" href="/">
            🏠 HOME
          </Link>
        </footer>
      </div>
    );
  }

  // ---------- MAIN ARKA SCREEN ----------

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">
            {currentUser.name} • {ROLE_LABELS[currentUser.role] || currentUser.role}
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            SOT: <strong>{todayTotal.toFixed(2)} €</strong>
          </div>
          <div>
            BUXHETI: <strong>{budget.toFixed(2)} €</strong>
          </div>
          {isAdmin() && (
            <button
              type="button"
              className="btn secondary"
              style={{ marginTop: 6, padding: '4px 8px', fontSize: 10 }}
              onClick={() =>
                factoryResetAll(currentUser, setRecords, setDay, setMoves, setBudget)
              }
            >
              RESET SISTEMIN
            </button>
          )}
          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 6, marginLeft: 6, padding: '4px 8px', fontSize: 10 }}
            onClick={handleLogout}
          >
            DALJE
          </button>
        </div>
      </header>

      {/* DITA E SOTME */}

      <section className="card">
        <h2 className="card-title">DITA E SOTME ({todayKey()})</h2>
        {day ? (
          <>
            <p style={{ fontSize: 12, marginBottom: 4 }}>
              Dita është hapur nga{' '}
              <strong>
                {day.openedByName} ({ROLE_LABELS[day.openedByRole] || day.openedByRole})
              </strong>{' '}
              në{' '}
              {new Date(day.openedTs).toLocaleTimeString('sq-AL', {
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </p>
            <p style={{ fontSize: 12 }}>
              CASH START: <strong>{cashStart.toFixed(2)} €</strong> · NETO SOT (ARKA):{' '}
              <strong>{todayTotal.toFixed(2)} €</strong> · SHPENZIME NGA ARKA:{' '}
              <strong>{cashOutFromArka.toFixed(2)} €</strong>
            </p>
            <p style={{ fontSize: 12, marginTop: 4 }}>
              CASH NË FUND DITE:{' '}
              <strong>{day.closed ? day.transferred.toFixed(2) : cashEndCalc.toFixed(2)} €</strong>
            </p>
            {!day.closed && (
              <button
                type="button"
                className="btn primary"
                style={{ marginTop: 10 }}
                onClick={handleCloseDay}
              >
                MBYLLE DITËN & TRANSFERO NË BUXHET
              </button>
            )}
            {day.closed && (
              <p style={{ fontSize: 11, marginTop: 6, opacity: 0.8 }}>
                Dita është e mbyllur. U transferuan{' '}
                <strong>{day.transferred.toFixed(2)} €</strong> në buxhet në{' '}
                {new Date(day.closedTs).toLocaleTimeString('sq-AL', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                .
              </p>
            )}
          </>
        ) : (
          <>
            <p style={{ fontSize: 12, marginBottom: 6 }}>
              Hape ditën me shumë fillestare në arkë (cash fizik).
            </p>
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                placeholder="CASH START €"
                value={openCashInput}
                onChange={(e) => setOpenCashInput(e.target.value)}
              />
              <button type="button" className="btn primary" onClick={handleOpenDay}>
                HAP DITËN
              </button>
            </div>
          </>
        )}
      </section>

      {/* SHPENZIME & AVANSA */}

      <section className="card">
        <h2 className="card-title">SHPENZIME & AVANSA</h2>

        {/* PUNTOR / AVANS */}
        <div style={{ marginBottom: 16 }}>
          <div className="subtitle" style={{ marginBottom: 6 }}>
            AVANS PËR PUNTOR
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <input
              className="input small"
              type="text"
              placeholder="Emri i puntorit"
              value={advWho}
              onChange={(e) => setAdvWho(e.target.value)}
            />
            <input
              className="input small"
              type="number"
              min="0"
              step="0.1"
              placeholder="Shuma €"
              value={advAmount}
              onChange={(e) => setAdvAmount(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <select
              className="input small"
              value={advSource}
              onChange={(e) => setAdvSource(e.target.value)}
            >
              <option value="arka">Nga ARKA</option>
              <option value="budget">Nga BUXHETI</option>
            </select>
            <input
              className="input small"
              type="text"
              placeholder="Shënim (p.sh. rrogë, avans)"
              value={advNote}
              onChange={(e) => setAdvNote(e.target.value)}
            />
          </div>
          <button type="button" className="btn secondary" onClick={handleAddAdvance}>
            SHTO AVANS
          </button>
        </div>

        {/* SHPENZIM I RI */}
        <div style={{ marginBottom: 16 }}>
          <div className="subtitle" style={{ marginBottom: 6 }}>
            SHPENZIM I RI
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <input
              className="input small"
              type="number"
              min="0"
              step="0.1"
              placeholder="Shuma €"
              value={expAmount}
              onChange={(e) => setExpAmount(e.target.value)}
            />
            <select
              className="input small"
              value={expSource}
              onChange={(e) => setExpSource(e.target.value)}
            >
              <option value="arka">Nga ARKA</option>
              <option value="budget">Nga BUXHETI</option>
            </select>
          </div>
          <input
            className="input"
            type="text"
            placeholder="Kategoria / shënim (p.sh. shampo, rrymë...)"
            value={expNote}
            onChange={(e) => setExpNote(e.target.value)}
          />
          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 6 }}
            onClick={handleAddExpense}
          >
            SHTO SHPENZIM
          </button>
        </div>

        {/* TOP-UP PËR BUXHETIN */}
        <div>
          <div className="subtitle" style={{ marginBottom: 6 }}>
            TOP-UP PËR KOMPANI (DIKUSH I JEP PARA)
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <input
              className="input small"
              type="number"
              min="0"
              step="0.1"
              placeholder="Shuma €"
              value={topAmount}
              onChange={(e) => setTopAmount(e.target.value)}
            />
            <input
              className="input small"
              type="text"
              placeholder="Kush i dha? (p.sh. Arben)"
              value={topWho}
              onChange={(e) => setTopWho(e.target.value)}
            />
          </div>
          <input
            className="input"
            type="text"
            placeholder="Shënim opsional (p.sh. hua, investim)"
            value={topNote}
            onChange={(e) => setTopNote(e.target.value)}
          />
          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 6 }}
            onClick={handleAddTopup}
          >
            SHTO TOP-UP
          </button>
        </div>
      </section>

      {/* LËVIZJET E DITËS */}

      <section className="card">
        <h2 className="card-title">Lëvizjet e ditës</h2>
        {moves.length === 0 && (
          <p style={{ fontSize: 12 }}>Ende nuk ka lëvizje për sot.</p>
        )}
        {moves.map((m) => (
          <div key={m.id} className="home-btn" style={{ marginBottom: 6 }}>
            <div className="home-btn-main" style={{ alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  {m.type === 'expense'
                    ? 'SHPENZIM'
                    : m.type === 'advance'
                    ? 'AVANS'
                    : 'TOP-UP BUXHETI'}
                  {' • '}
                  {m.source === 'arka'
                    ? 'NGA ARKA'
                    : m.source === 'budget'
                    ? 'NGA BUXHETI'
                    : 'EKSTERNE'}
                </div>
                <div style={{ fontSize: 12 }}>
                  {m.who ? `${m.who}: ` : ''}
                  {m.note || ''}
                </div>
                <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                  {m.byUserName && (
                    <>
                      Regjistroi: {m.byUserName}{' '}
                      {m.byUserRole && `(${ROLE_LABELS[m.byUserRole] || m.byUserRole})`}
                      {' • '}
                    </>
                  )}
                  {new Date(m.ts).toLocaleTimeString('sq-AL', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 13 }}>
                <strong>
                  {m.type === 'topup' ? '+' : '-'}
                  {Number(m.amount || 0).toFixed(2)} €
                </strong>
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* LISTA E PAGESAVE NGA GATI */}

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
                  {r.byUserName && (
                    <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                      Regjistroi: {r.byUserName}
                    </div>
                  )}
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

      {/* ADMIN – PËRDORUESIT */}

      {isAdmin() && (
        <section className="card">
          <h2 className="card-title">PËRDORUESIT & ROLET</h2>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginBottom: 12,
            }}
          >
            <label className="label">SHTO PËRDORUES</label>
            <input
              className="input"
              type="text"
              placeholder="Emri (p.sh. Ardi)"
              value={newUserName}
              onChange={(e) => setNewUserName(e.target.value)}
            />
            <input
              className="input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="PIN (p.sh. 1234)"
              value={newUserPin}
              onChange={(e) => setNewUserPin(e.target.value)}
            />
            <select
              className="input"
              value={newUserRole}
              onChange={(e) => setNewUserRole(e.target.value)}
            >
              <option value="worker">PUNTOR</option>
              <option value="transport">TRANSPORT</option>
              <option value="dispatch">DISPATCH</option>
              <option value="admin">ADMIN</option>
            </select>
            <button type="button" className="btn primary" onClick={handleAddUser}>
              SHTO PËRDORUES
            </button>
          </div>

          {users.map((u) => (
            <div
              key={u.id}
              className="home-btn"
              style={{ marginBottom: 6, padding: '6px 8px' }}
            >
              <div className="home-btn-main" style={{ alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{u.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.8 }}>
                    PIN: **** ({ROLE_LABELS[u.role] || u.role})
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11 }}>
                  <select
                    className="input"
                    value={u.role}
                    style={{ padding: '2px 4px', fontSize: 11, marginBottom: 4 }}
                    onChange={(e) => handleChangeRole(u.id, e.target.value)}
                  >
                    <option value="worker">PUNTOR</option>
                    <option value="transport">TRANSPORT</option>
                    <option value="dispatch">DISPATCH</option>
                    <option value="admin">ADMIN</option>
                  </select>
                  {u.id !== 'admin-1' && (
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ padding: '2px 6px', fontSize: 10 }}
                      onClick={() => handleDeleteUser(u.id)}
                    >
                      FSHI
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}