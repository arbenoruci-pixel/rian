'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

// Tabela të Postgres të përdorura
const ARKA_TABLE = 'arka_records';
const MOVES_TABLE = 'arka_moves';
const DAYS_TABLE = 'arka_days';
const BUCKET = 'tepiha-photos'; // Ende përdoret për Factory Reset (folderi 'orders')

// ------------- HELPERA PËR LLOGARITJET & DATËN -------------

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
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// LLOGARITJET ME CENTË
function toCents(euro) {
  return Math.round(Number(euro) * 100); 
}

function toEuros(cents) {
  return (Number(cents) / 100);
}

// ------------- NGARKIMI/RUAJTJA NGA POSTGRES (ARKA & MOVES & DAY) -------------

async function loadArkaFromPostgres() {
  if (!supabase) return [];
  
  const { data, error } = await supabase
    .from(ARKA_TABLE)
    .select('id, ts, paid, code, name, phone, byUserName')
    .limit(1000)
    .order('ts', { ascending: false });
  
  if (error) {
    console.error('Error loading ARKA records from Postgres:', error);
    return [];
  }
  
  return data || [];
}

async function loadMovesFromPostgres() {
  if (!supabase) return [];
  const today = todayKey();
  
  const { data, error } = await supabase
    .from(MOVES_TABLE)
    .select('*')
    .eq('dateKey', today)
    .order('ts', { ascending: false });
    
  if (error) {
    console.error('Error loading moves from Postgres:', error);
    return [];
  }
  
  return data || [];
}

async function saveMoveToPostgres(move) {
    if (!supabase) return { error: 'Supabase not initialized' };
    
    const moveWithKey = { ...move, dateKey: todayKey() };

    const { error } = await supabase
        .from(MOVES_TABLE)
        .insert(moveWithKey);

    return { error }; 
}

async function loadDayFromPostgres() {
  if (!supabase) return null;
  const today = todayKey();
  
  const { data, error } = await supabase
    .from(DAYS_TABLE)
    .select('*')
    .eq('dateKey', today)
    .single();
    
  if (error && error.code !== 'PGRST116') { // PGRST116 = asnjë rresht nuk u gjet
    console.error('Error loading day from Postgres:', error);
    return null;
  }
  
  return data || null;
}

async function saveDayToPostgres(dayData) {
    if (!supabase) return { error: 'Supabase not initialized' };
    
    // 1. Provo të bësh UPDATE (për mbylljen e ditës)
    const { error: updateError, count } = await supabase
        .from(DAYS_TABLE)
        .update(dayData)
        .eq('dateKey', dayData.dateKey)
        .select('*', { count: 'exact' });

    if (updateError && updateError.code !== 'PGRST103') { 
        console.error('Error updating day in Postgres:', updateError);
        return { error: updateError };
    }

    // 2. Nëse nuk u azhurnua (rekordi nuk ekziston) dhe dita nuk është e mbyllur, fut rekord të ri (Hapja e Ditës)
    if (dayData.closed === false && count === 0) {
        const { error: insertError } = await supabase
            .from(DAYS_TABLE)
            .insert(dayData)
            .select();
        
        if (insertError) {
            console.error('Error inserting day in Postgres:', insertError);
            return { error: insertError };
        }
    }
    
    return { error: null };
}

// ------------- USERS, ROLET & SIGURIA (PIN HASHING) -------------

const USERS_KEY = 'arka_users_v1';
const CURRENT_USER_KEY = 'arka_current_user_v1';
// Hash-i i '4563' (MASTER_PIN)
const MASTER_PIN_HASHED = '7c5798e8f813e3322d7d8e4125b28a9b31d8c1c54b6807865239e3f9a721d604';

const ROLE_LABELS = {
  admin: 'ADMIN',
  worker: 'PUNTOR',
  transport: 'TRANSPORT',
  dispatch: 'DISPATCH',
};

// Funksioni asinkron për Hash-imin e PIN-it (SHA-256)
async function hashPin(pin) {
  if (typeof window === 'undefined') return pin;
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(pin);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    console.error('Crypto API not available/failed', e);
    return pin; // Fallback, though unsafe
  }
}

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
          // Ruajmë HASH-in në localStorage
          pin: MASTER_PIN_HASHED, 
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
        pin: MASTER_PIN_HASHED, 
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

// Tani kërkon PIN-in e hash-uar
function findUserByHashedPin(users, hashedPin) {
  return users.find((u) => u.pin === hashedPin);
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

// ------------- BUXHETI (Mbetet Lokale për Thjeshtësi) -------------

const BUDGET_KEY = 'arka_budget_total_v1';

function loadBudget() {
  if (typeof window === 'undefined') return 0;
  try {
    // Kthen Centë
    const v = Number(localStorage.getItem(BUDGET_KEY)); 
    return isNaN(v) ? 0 : v;
  } catch {
    return 0;
  }
}

function saveBudget(v) {
  if (typeof window === 'undefined') return;
  // Ruhet si Centë
  localStorage.setItem(BUDGET_KEY, String(v));
}

// ------------- FACTORY RESET ALL -------------

async function factoryResetAll(currentUser, setRecords, setDay, setMoves, setBudget) {
  // Përdorni PIN-in default për konfirmim
  const MASTER_PIN = '4563'; 
  
  if (!currentUser || currentUser.role !== 'admin') {
    alert('Vetëm ADMINI mund ta përdor reset-in.');
    return;
  }
  const pin = prompt('Shkruaj PIN-in e ADMINIT për reset:');
  
  // Kontrolli i PIN-it me hash-ing
  const hashedPin = await hashPin(pin); 
  if (hashedPin !== MASTER_PIN_HASHED) { 
    alert('PIN i gabuar. Reset u anullua.');
    return;
  }
  
  const ok = confirm(
    'Factory reset: do të fshihen të gjitha POROSITË, PAGESAT (ARKA), LËVIZJET dhe gjendja ditore. PËRDORUESIT do të mbesin. Vazhdon?',
  );
  if (!ok) return;

  try {
    if (supabase) {
      // 1. Fshirja nga Supabase Storage (vetëm 'orders')
      const folders = ['orders']; 
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

      // 2. Fshirja nga Tabela e Postgres (Historiku i Arkës)
      await supabase.from(ARKA_TABLE).delete().not('id', 'is', null);
      
      // 3. Fshirja nga Tabela e Postgres (Lëvizjet Ditore)
      await supabase.from(MOVES_TABLE).delete().not('id', 'is', null);
      
      // 4. Fshirja nga Tabela e Postgres (Gjendja e Ditës)
      await supabase.from(DAYS_TABLE).delete().not('dateKey', 'is', null);

    }
  } catch (e) {
    console.error('Error during factory reset Supabase', e);
  }

  // 5. Fshirja nga LocalStorage (cache/buxheti)
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
  const [budget, setBudget] = useState(0); // Në centë
  const [moves, setMoves] = useState([]);

  const [openCashInput, setOpenCashInput] = useState(''); // Input në Euro

  const [expAmount, setExpAmount] = useState(''); // Input në Euro
  const [expSource, setExpSource] = useState('arka');
  const [expNote, setExpNote] = useState('');

  const [advAmount, setAdvAmount] = useState(''); // Input në Euro
  const [advSource, setAdvSource] = useState('arka');
  const [advWho, setAdvWho] = useState('');
  const [advNote, setAdvNote] = useState('');

  const [topAmount, setTopAmount] = useState(''); // Input në Euro
  const [topWho, setTopWho] = useState('');
  const [topNote, setTopNote] = useState('');

  // Ngarkojmë user-at dhe currentUser
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
      // Ngarkojmë direkt nga Postgres
      const onlineRecords = await loadArkaFromPostgres();
      setRecords(onlineRecords);
      // Nuk ka më fallback lokal, përveç nëse e ruajmë cache-in nga Postgres.
    } catch (e) {
      console.error('Error loading ARKA records', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refreshRecords();
  }, []);

  // Ngarkojmë buxhetin / ditën / lëvizjet kur ka user
  useEffect(() => {
    if (!currentUser) return;
    if (typeof window === 'undefined') return;
    setBudget(loadBudget());
    
    // Ngarkojmë nga Postgres
    loadDayFromPostgres().then(setDay);
    loadMovesFromPostgres().then(setMoves);
  }, [currentUser]);

  // LLOGARITJET ME CENTË
  const todayTotalCents = useMemo(() => {
    const now = Date.now();
    return records
      .filter((r) => r.ts && isSameDay(r.ts, now))
      // Supozojmë se r.paid është Euro nga sistemi tjetër (e konvertojmë në Centë)
      .reduce((sum, r) => sum + toCents(r.paid), 0);
  }, [records]);

  const cashOutFromArkaCents = useMemo(
    () =>
      moves
        .filter(
          (m) =>
            (m.type === 'expense' || m.type === 'advance') &&
            m.source === 'arka',
        )
        // Lëvizjet e ruajtura në moves tashmë janë në Centë
        .reduce((sum, m) => sum + (Number(m.amount) || 0), 0),
    [moves],
  );

  // CashStart është në Centë nga objekti Day (i marrë nga DB)
  const cashStartCents = Number(day?.cashStart || 0) || 0; 
  
  const cashEndCalcCents = useMemo(
    () => cashStartCents + todayTotalCents - cashOutFromArkaCents,
    [cashStartCents, todayTotalCents, cashOutFromArkaCents],
  );

  // ---------- LOGIN ----------

  async function handleLogin(e) { // ASYNCHRONOUS
    e?.preventDefault?.();
    const pin = (pinInput || '').trim();
    if (!pin) {
      alert('Shkruaj PIN-in.');
      return;
    }
    
    const hashedPin = await hashPin(pin);

    const u = findUserByHashedPin(users, hashedPin);
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

  async function handleAddUser(e) { // ASYNCHRONOUS
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
    
    const hashedPin = await hashPin(pin);

    if (findUserByHashedPin(users, hashedPin)) {
      alert('Ky PIN tashmë ekziston.');
      return;
    }

    const user = {
      id: `u-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      name,
      pin: hashedPin, // Ruajmë Hash-in
      role: newUserRole,
    };
    const updated = [user, ...users];
    setUsers(updated);
    saveUsers(updated);
    setNewUserName('');
    setNewUserPin('');
    setNewUserRole('worker');
  }
  // ... handleChangeRole dhe handleDeleteUser mbeten pothuajse të njëjta ...

  // ---------- DITA E SOTME & BUXHET ----------

  async function handleOpenDay() { // ASYNCHRONOUS
    if (day) {
        alert('Dita është hapur tashmë.');
        return;
    }
    const valEuro = Number(openCashInput || 0);
    if (isNaN(valEuro) || valEuro < 0) {
      alert('Shkruaj një shumë valide për CASH START.');
      return;
    }
    const valCents = toCents(valEuro); // Konverto në centë

    const d = {
      dateKey: todayKey(),
      openedByName: currentUser?.name || 'ADMIN',
      openedByRole: currentUser?.role || 'admin',
      openedTs: Date.now(),
      cashStart: valCents, // Ruaj Centët
      closed: false,
      closedTs: null,
      transferred: 0,
    };
    
    const { error } = await saveDayToPostgres(d);

    if (error) {
        alert('Gabim gjatë hapjes së ditës: ' + error.message);
        return;
    }

    setDay(d);
    setOpenCashInput('');
  }

  async function handleCloseDay() { // ASYNCHRONOUS
    if (!day) {
      alert('Së pari hape ditën.');
      return;
    }
    if (day.closed) {
      alert('Dita tashmë është e mbyllur.');
      return;
    }
    
    const transferredCents = cashEndCalcCents;
    const transferredEuros = toEuros(transferredCents); // Për shfaqje

    const msg =
      `Cash në fund të ditës: ${transferredEuros.toFixed(2)} €.\n` +
      `Dëshiron ta mbyllësh ditën dhe ta shtosh këtë shumë në BUXHETIN e kompanisë?`;
    const ok = confirm(msg);
    if (!ok) return;
    
    // Llogaritjet në Centë
    const newBudgetCents = budget + transferredCents;
    
    const d = {
      ...day,
      closed: true,
      closedTs: Date.now(),
      transferred: transferredCents, // Ruaj Centët
    };
    
    const { error } = await saveDayToPostgres(d);

    if (error) {
        alert('Gabim gjatë mbylljes së ditës: ' + error.message);
        return;
    }

    setBudget(newBudgetCents);
    saveBudget(newBudgetCents); 
    setDay(d);
    
    alert('Dita u mbyll dhe shuma u shtua në buxhet.');
  }

  // ---------- SHPENZIM I RI (ADD MOVE) ----------
  
  // addMove tani bën saveMoveToPostgres
  async function addMove(m) {
    const { error } = await saveMoveToPostgres(m);
    
    if (error) {
        alert('Gabim gjatë ruajtjes së lëvizjes në databazë: ' + error.message);
        return; 
    }
    
    // Përditësoni gjendjen lokale
    const updated = [m, ...moves];
    setMoves(updated);
  }

  async function handleAddExpense() { // ASYNCHRONOUS
    const amountEuro = Number(expAmount || 0);
    if (!amountEuro || amountEuro <= 0) {
      alert('Shkruaj shumën e shpenzimit.');
      return;
    }
    const amountCents = toCents(amountEuro); // Konverto në Centë
    
    const m = {
      id: `m-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      ts: Date.now(),
      type: 'expense',
      source: expSource, // arka/budget
      amount: amountCents, // Ruaj Centët
      note: expNote.trim(),
      byUserName: currentUser?.name || '',
      byUserRole: currentUser?.role || '',
    };
    
    await addMove(m);

    if (expSource === 'budget') {
      const nbCents = budget - amountCents; // Llogaritje e saktë në Centë
      setBudget(nbCents);
      saveBudget(nbCents);
    }
    setExpAmount('');
    setExpNote('');
    setExpSource('arka');
  }

  // ---------- AVANS PËR PUNTOR ----------

  async function handleAddAdvance() { // ASYNCHRONOUS
    const amountEuro = Number(advAmount || 0);
    if (!advWho.trim()) {
      alert('Shkruaj emrin e puntorit.');
      return;
    }
    if (!amountEuro || amountEuro <= 0) {
      alert('Shkruaj shumën e avansit.');
      return;
    }
    const amountCents = toCents(amountEuro); // Konverto në Centë

    const m = {
      id: `m-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      ts: Date.now(),
      type: 'advance',
      source: advSource,
      amount: amountCents, // Ruaj Centët
      who: advWho.trim(),
      note: advNote.trim(),
      byUserName: currentUser?.name || '',
      byUserRole: currentUser?.role || '',
    };
    
    await addMove(m);

    if (advSource === 'budget') {
      const nbCents = budget - amountCents; // Llogaritje e saktë në Centë
      setBudget(nbCents);
      saveBudget(nbCents);
    }
    setAdvAmount('');
    setAdvWho('');
    setAdvNote('');
    setAdvSource('arka');
  }

  // ---------- TOP-UP BUXHETI (DIKUSH I JEP PARA KOMPANIS) ----------

  async function handleAddTopup() { // ASYNCHRONOUS
    const amountEuro = Number(topAmount || 0);
    if (!amountEuro || amountEuro <= 0) {
      alert('Shkruaj shumën e top-up-it.');
      return;
    }
    const amountCents = toCents(amountEuro); // Konverto në Centë

    const m = {
      id: `m-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      ts: Date.now(),
      type: 'topup',
      source: 'external',
      amount: amountCents, // Ruaj Centët
      who: topWho.trim(),
      note: topNote.trim(),
      byUserName: currentUser?.name || '',
      byUserRole: currentUser?.role || '',
    };
    
    await addMove(m);

    const nbCents = budget + amountCents; // Llogaritje e saktë në Centë
    setBudget(nbCents);
    saveBudget(nbCents);

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
            SOT: <strong>{toEuros(todayTotalCents).toFixed(2)} €</strong>
          </div>
          <div>
            BUXHETI: <strong>{toEuros(budget).toFixed(2)} €</strong>
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
              CASH START: <strong>{toEuros(cashStartCents).toFixed(2)} €</strong> · NETO SOT (ARKA):{' '}
              <strong>{toEuros(todayTotalCents).toFixed(2)} €</strong> · SHPENZIME NGA ARKA:{' '}
              <strong>{toEuros(cashOutFromArkaCents).toFixed(2)} €</strong>
            </p>
            <p style={{ fontSize: 12, marginTop: 4 }}>
              CASH NË FUND DITE:{' '}
              <strong>
                {day.closed
                  ? toEuros(day.transferred).toFixed(2)
                  : toEuros(cashEndCalcCents).toFixed(2)}{' '}
                €
              </strong>
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
                <strong>{toEuros(day.transferred).toFixed(2)} €</strong> në buxhet në{' '}
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
                  {toEuros(Number(m.amount || 0)).toFixed(2)} €
                </strong>
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* LISTA E PAGESAVE NGA GATI */}

      <section className="card">
        <h2 className="card-title">Lista e pagesave (Historiku)</h2>
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
                    {/* Shuma e pagesës ruhet si Euro (NUMERIC) në arka_records */}
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
