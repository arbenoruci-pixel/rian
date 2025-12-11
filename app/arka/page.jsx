'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// ----------------- HELPERS TË VJETRA (ARKA) -----------------

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

// ----------------- USERS & ROLES (LOKALE) -----------------

const USERS_KEY = 'arka_users_v1';
const CURRENT_USER_KEY = 'arka_current_user_v1';
const MASTER_PIN = '4563'; // master admin PIN – veç ti e din

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
    // Nëse s’ka user fare, krijo ADMIN default me PIN 4563
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

// ----------------- FACTORY RESET (TANI ME PIN ADMIN) -----------------

async function factoryResetAll(currentUser, setRecords) {
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
    'Factory reset: do të fshihen të gjitha POROSITË dhe PAGESAT (ARKA), por PËRDORUESIT do të mbesin. Vazhdon?'
  );
  if (!ok) return;

  // 1) Fshijmë nga Supabase: orders + arka
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

  // 2) Fshijmë vetëm cache-in për porosi & arka, jo user-at
  if (typeof window !== 'undefined') {
    try {
      // heqim listat e orderave dhe arka-s
      localStorage.removeItem('order_list_v1');
      localStorage.removeItem('arka_list_v1');
      // i fshijmë edhe order_* lokalisht
      const keys = Object.keys(localStorage);
      for (const k of keys) {
        if (k.startsWith('order_')) {
          localStorage.removeItem(k);
        }
      }
      // NUK prek: arka_users_v1, arka_current_user_v1
    } catch (e) {
      console.error('Error removing localStorage items for reset', e);
    }
  }

  setRecords([]);
  alert('Sistemi u resetua (porosi + arka). Përdoruesit dhe PIN-at mbetën.');
}

// ----------------- KOMPONENTI KRYESOR -----------------

export default function Page() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [pinInput, setPinInput] = useState('');

  const [newUserName, setNewUserName] = useState('');
  const [newUserPin, setNewUserPin] = useState('');
  const [newUserRole, setNewUserRole] = useState('worker');

  // --- ngarkojmë user-at & current user ---
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = loadUsers();
    setUsers(u);
    const cu = loadCurrentUser(u);
    if (cu) setCurrentUser(cu);
  }, []);

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

  // ----------------- LOGIN / LOGOUT -----------------

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

  // ----------------- ADMIN: MENAXHIM USER-ASH -----------------

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
      alert('Ky PIN tashmë ekziston për një përdorues tjetër.');
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
      u.id === userId
        ? {
            ...u,
            role: newRole,
          }
        : u,
    );
    setUsers(updated);
    saveUsers(updated);
    // nëse po e ndryshon rolin e vet, updato currentUser
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
      alert('Nuk rekomandohet me fshi admin-in ekzistues.');
      return;
    }
    const ok = confirm(`Me fshi përdoruesin "${u.name}"?`);
    if (!ok) return;
    const updated = users.filter((x) => x.id !== userId);
    setUsers(updated);
    saveUsers(updated);
  }

  // ----------------- RENDER -----------------

  // 1) NËSE SKA USER TË LOGUAR → LOGIN ME PIN
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
            * PIN-i i parë default është <strong>4563</strong> (ADMIN). Më pas mund të
            shtosh puntorë tjerë.
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

  // 2) NËSE KA USER TË LOGUAR → SHFAQ ARKËN SIPAS ROLIT

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
          {isAdmin() && (
            <button
              type="button"
              className="btn secondary"
              style={{ marginTop: 8, padding: '4px 8px', fontSize: 10 }}
              onClick={() => factoryResetAll(currentUser, setRecords)}
            >
              RESET SISTEMIN
            </button>
          )}
          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 8, marginLeft: 8, padding: '4px 8px', fontSize: 10 }}
            onClick={handleLogout}
          >
            DALJE
          </button>
        </div>
      </header>

      {/* LISTA E PAGESAVE NGA POROSITË GATI */}
      <section className="card">
        <h2 className="card-title">LISTA E PAGESAVE</h2>
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

      {/* ADMIN – MENAXHIM PËRDORUESISH */}
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

          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            * ADMIN-i sheh gjithë bugjetin, resetin dhe listën e plotë. PUNTOR / TRANSPORT /
            DISPATCH do i kufizojmë hap pas hapi sipas logjikës që po ndërtojmë.
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