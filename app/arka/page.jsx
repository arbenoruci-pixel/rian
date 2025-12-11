'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// MASTER PIN – vetem ti e din
const MASTER_PIN = '4563';

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// -------- ARKA RECORDS (pagesat) --------

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

// -------- USERS (MASTER / ADMIN / WORKER) --------

function loadUsersLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem('arka_users_v1') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveUsersLocal(users) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('arka_users_v1', JSON.stringify(users || []));
  } catch (e) {
    console.error('Error saving arka_users_v1', e);
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

export default function Page() {
  // ARKA data
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  // USERS / AUTH
  const [users, setUsers] = useState([]);
  const [authUser, setAuthUser] = useState(null); // {id?, name, role: 'master'|'admin'|'worker'}
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');

  // add user form (vetem per MASTER)
  const [newUserName, setNewUserName] = useState('');
  const [newUserRole, setNewUserRole] = useState('worker');
  const [newUserPin, setNewUserPin] = useState('');

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
    // load users
    const u = loadUsersLocal();
    setUsers(u);
    // optional: load last session
    try {
      const rawSession = localStorage.getItem('arka_session_user');
      if (rawSession) {
        const parsed = JSON.parse(rawSession);
        if (parsed && parsed.role) setAuthUser(parsed);
      }
    } catch {
      // ignore
    }
    // load arka
    refresh();
  }, []);

  // Totali i dites
  const todayTotal = useMemo(() => {
    const now = Date.now();
    return records
      .filter((r) => r.ts && isSameDay(r.ts, now))
      .reduce((sum, r) => sum + (Number(r.paid) || 0), 0);
  }, [records]);

  // ---------- AUTH / PIN LOGIC ----------

  function handleLogin(e) {
    e.preventDefault();
    setPinError('');
    const pin = (pinInput || '').trim();

    if (!pin) {
      setPinError('Shkruaj PIN-in.');
      return;
    }

    // MASTER PIN
    if (pin === MASTER_PIN) {
      const masterUser = { name: 'MASTER', role: 'master', isMaster: true };
      setAuthUser(masterUser);
      if (typeof window !== 'undefined') {
        localStorage.setItem('arka_session_user', JSON.stringify(masterUser));
      }
      setPinInput('');
      return;
    }

    // kontrollo tek users
    const found = users.find((u) => String(u.pin || '').trim() === pin);
    if (!found) {
      setPinError('PIN i pasaktë.');
      return;
    }

    const sessionUser = {
      id: found.id,
      name: found.name,
      role: found.role,
      isMaster: false,
    };
    setAuthUser(sessionUser);
    if (typeof window !== 'undefined') {
      localStorage.setItem('arka_session_user', JSON.stringify(sessionUser));
    }
    setPinInput('');
  }

  function handleLogout() {
    setAuthUser(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('arka_session_user');
    }
  }

  const isMaster = authUser?.role === 'master';
  const isAdmin = authUser?.role === 'admin';
  const isWorker = authUser?.role === 'worker';

  // ---------- USER MANAGEMENT (ONLY MASTER) ----------

  function handleAddUser(e) {
    e.preventDefault();
    if (!isMaster) return;

    const name = newUserName.trim();
    const pin = newUserPin.trim();
    const role = newUserRole === 'admin' ? 'admin' : 'worker';

    if (!name || !pin) {
      alert('Shkruaj emrin dhe PIN-in për përdoruesin e ri.');
      return;
    }

    // mos lejo PIN qe eshte si MASTER_PIN
    if (pin === MASTER_PIN) {
      alert('Ky PIN është i rezervuar për MASTER. Zgjedh një tjetër.');
      return;
    }

    // mos lejo PIN të dubluar mes përdoruesve
    const exists = users.some((u) => String(u.pin || '').trim() === pin);
    if (exists) {
      alert('Ky PIN tashmë ekziston. Zgjedh një tjetër.');
      return;
    }

    const newUser = {
      id: Date.now(),
      name,
      role,
      pin,
    };

    const next = [newUser, ...users];
    setUsers(next);
    saveUsersLocal(next);

    setNewUserName('');
    setNewUserPin('');
    setNewUserRole('worker');
  }

  function handleDeleteUser(id) {
    if (!isMaster) return;
    const ok = confirm('A je i sigurt që dëshiron ta fshish këtë përdorues?');
    if (!ok) return;
    const next = users.filter((u) => u.id !== id);
    setUsers(next);
    saveUsersLocal(next);
  }

  // ---------- RENDER ----------

  // Së pari – nëse s’ka user të loguar, trego PIN ekranin
  if (!authUser) {
    return (
      <div className="wrap" style={{ paddingTop: '40px' }}>
        <header className="header-row">
          <div>
            <h1 className="title">ARKA</h1>
            <div className="subtitle">KYÇU ME PIN</div>
          </div>
        </header>

        <section className="card">
          <h2 className="card-title">HYRJE NË SISTEM</h2>
          <form onSubmit={handleLogin}>
            <div className="field-group">
              <label className="label">PIN</label>
              <input
                className="input"
                type="password"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="Shkruaj PIN-in"
              />
            </div>
            {pinError && (
              <p style={{ color: '#f87171', fontSize: 12, marginTop: 4 }}>{pinError}</p>
            )}
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button type="submit" className="btn primary">
                HYR
              </button>
            </div>
          </form>

          <p style={{ fontSize: 11, opacity: 0.7, marginTop: 16 }}>
            * Vetëm pronari e di PIN-in master. Përdoruesit tjerë hyjnë me PIN-in e tyre
            personal.
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

  // Nese useri eshte i kycur – trego ARKA-n
  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">
            Pagesat nga porositë GATI
            <br />
            <span style={{ fontSize: 11, opacity: 0.8 }}>
              LLOGARI: {authUser.name} ({authUser.role.toUpperCase()})
            </span>
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            SOT: <strong>{todayTotal.toFixed(2)} €</strong>
          </div>
          {isMaster && (
            <button
              type="button"
              className="btn secondary"
              style={{ marginTop: 8, padding: '4px 8px', fontSize: 10 }}
              onClick={() => factoryResetAll(setRecords)}
            >
              RESET SISTEMIN
            </button>
          )}
          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 8, padding: '4px 8px', fontSize: 10 }}
            onClick={handleLogout}
          >
            DALJE
          </button>
        </div>
      </header>

      {/* VETEM MASTER e sheh menaxhimin e përdoruesve */}
      {isMaster && (
        <section className="card">
          <h2 className="card-title">MENAXHO PËRDORUESIT</h2>

          <form onSubmit={handleAddUser} style={{ marginBottom: 16 }}>
            <div className="field-group">
              <label className="label">Emri i përdoruesit</label>
              <input
                className="input"
                type="text"
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                placeholder="P.sh. Ardi, Blerim..."
              />
            </div>
            <div className="field-group">
              <label className="label">Roli</label>
              <select
                className="input"
                value={newUserRole}
                onChange={(e) => setNewUserRole(e.target.value)}
              >
                <option value="worker">PUNËTOR</option>
                <option value="admin">ADMINISTRATOR</option>
              </select>
            </div>
            <div className="field-group">
              <label className="label">PIN i përdoruesit</label>
              <input
                className="input"
                type="password"
                value={newUserPin}
                onChange={(e) => setNewUserPin(e.target.value)}
                placeholder="P.sh. 1234"
              />
            </div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button type="submit" className="btn primary">
                SHTO PËRDORUES
              </button>
            </div>
          </form>

          {users.length === 0 && (
            <p style={{ fontSize: 12, opacity: 0.8 }}>
              Nuk ka ende përdorues. Shto punëtorë / administratorë me PIN.
            </p>
          )}

          {users.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {users.map((u) => (
                <div
                  key={u.id}
                  className="home-btn"
                  style={{
                    marginBottom: 6,
                    padding: '6px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      {u.name} • {u.role.toUpperCase()}
                    </div>
                    <div style={{ opacity: 0.7 }}>PIN: {u.pin}</div>
                  </div>
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => handleDeleteUser(u.id)}
                  >
                    FSHI
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* LISTA E PAGESAVE – e shohin te gjitha rolet */}
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

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}