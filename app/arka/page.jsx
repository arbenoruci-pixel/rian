'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// ----------------- KONFIGURIMI / KONSTANTET -----------------

const MASTER_PIN = '4563';

const ROLE_ADMIN = 'ADMIN';
const ROLE_WORKER = 'PUNTOR';
const ROLE_TRANSPORT = 'TRANSPORT';
const ROLE_DISPATCH = 'DISPATCH'; // ROL I RI

const ARKA_CONFIG_KEY = 'arka_config_v1';
const ARKA_USER_KEY = 'arka_current_user_v1';
const ARKA_TX_CACHE_KEY = 'arka_list_v1';

// llojet e transaksioneve
const TX_ORDER_PAYMENT = 'ORDER_PAYMENT';
const TX_ADVANCE = 'ADVANCE';
const TX_EXPENSE = 'EXPENSE';
const TX_BUDGET_IN = 'BUDGET_IN';
const TX_BUDGET_OUT = 'BUDGET_OUT';
const TX_OPEN_DAY = 'OPEN_DAY';
const TX_CLOSE_DAY = 'CLOSE_DAY';

// ----------------- HELPERS TË PËRGJITHSHME -----------------

function isSameDay(tsA, tsB) {
  if (!tsA || !tsB) return false;
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatDateTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleString('sq-AL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function genId(prefix = 'tx') {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

// ----------------- LEXIMI / SHKRIMI KONFIGUT -----------------

async function loadConfigFromSupabase() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download('arka/config_v1.json');
    if (error || !data) return null;
    const text = await data.text();
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object') return null;
    return json;
  } catch (e) {
    console.error('Error loading ARKA config from Supabase', e);
    return null;
  }
}

async function saveConfigToSupabase(config) {
  if (!supabase) return;
  try {
    const blob =
      typeof Blob !== 'undefined'
        ? new Blob([JSON.stringify(config)], {
            type: 'application/json',
          })
        : null;
    if (!blob) return;
    await supabase.storage
      .from(BUCKET)
      .upload('arka/config_v1.json', blob, { upsert: true });
  } catch (e) {
    console.error('Error saving ARKA config to Supabase', e);
  }
}

function loadConfigLocal() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ARKA_CONFIG_KEY);
    if (!raw) return null;
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return null;
    return json;
  } catch {
    return null;
  }
}

function saveConfigLocal(config) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ARKA_CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    console.error('Error saving ARKA config local', e);
  }
}

// ----------------- LEXIMI / SHKRIMI TRANSAKSIONEVE -----------------

async function loadArkaTxFromSupabase() {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.storage.from(BUCKET).list('arka', {
      limit: 1000,
    });
    if (error || !data) return [];

    const list = [];
    for (const item of data) {
      if (!item || !item.name) continue;
      // mos lexojmë config-in si transaksion
      if (item.name === 'config_v1.json') continue;

      try {
        const { data: file, error: dErr } = await supabase.storage
          .from(BUCKET)
          .download(`arka/${item.name}`);
        if (dErr || !file) continue;
        const text = await file.text();
        const rec = JSON.parse(text);
        if (!rec || !rec.id) continue;

        // kompatibilitet me versionin e vjetër
        if (!rec.kind) {
          rec.kind = TX_ORDER_PAYMENT;
        }
        list.push(rec);
      } catch (e) {
        console.error('Error parsing ARKA record', item.name, e);
      }
    }

    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return list;
  } catch (e) {
    console.error('Error listing ARKA folder', e);
    return [];
  }
}

async function saveArkaTxToSupabase(tx) {
  if (!supabase || !tx || !tx.id) return;
  try {
    const path = `arka/${tx.id}.json`;
    const blob =
      typeof Blob !== 'undefined'
        ? new Blob([JSON.stringify(tx)], {
            type: 'application/json',
          })
        : null;
    if (!blob) return;
    await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
  } catch (e) {
    console.error('Error saving ARKA tx to Supabase', e);
  }
}

function loadArkaTxLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ARKA_TX_CACHE_KEY);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveArkaTxLocal(list) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ARKA_TX_CACHE_KEY, JSON.stringify(list || []));
  } catch (e) {
    console.error('Error saving ARKA tx local', e);
  }
}

// ----------------- LEXIMI / SHKRIMI USER-IT AKTIV -----------------

function loadCurrentUser() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ARKA_USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (!u || !u.role) return null;
    return u;
  } catch {
    return null;
  }
}

function saveCurrentUser(user) {
  if (typeof window === 'undefined') return;
  if (!user) {
    localStorage.removeItem(ARKA_USER_KEY);
    return;
  }
  localStorage.setItem(ARKA_USER_KEY, JSON.stringify(user));
}

// ----------------- FACTORY RESET -----------------

async function factoryResetArkaOnly(setTx, setConfig, setUser) {
  const ok = confirm(
    'Factory reset: do të fshihen të gjitha të dhënat e ARKËS (transaksionet + config). Vazhdosh?'
  );
  if (!ok) return;

  try {
    if (supabase) {
      const { data, error } = await supabase.storage.from(BUCKET).list('arka', {
        limit: 1000,
      });
      if (!error && data && data.length > 0) {
        const paths = data.map((item) => `arka/${item.name}`);
        if (paths.length > 0) {
          await supabase.storage.from(BUCKET).remove(paths);
        }
      }
    }
  } catch (e) {
    console.error('Error during ARKA-only reset Supabase', e);
  }

  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(ARKA_TX_CACHE_KEY);
      localStorage.removeItem(ARKA_CONFIG_KEY);
      localStorage.removeItem(ARKA_USER_KEY);
    } catch (e) {
      console.error('Error clearing ARKA localStorage', e);
    }
  }

  setTx([]);
  setConfig(null);
  setUser(null);
  alert('ARKA u resetua. Duhet ta konfigurosh nga fillimi.');
}

// ----------------- KOMPONENTA KRYESORE -----------------

export default function Page() {
  const [config, setConfig] = useState(null);
  const [txList, setTxList] = useState([]);
  const [loading, setLoading] = useState(true);

  const [currentUser, setCurrentUser] = useState(null);

  // login form
  const [pinInput, setPinInput] = useState('');

  // modal i ri transaksioni
  const [showTxModal, setShowTxModal] = useState(false);
  const [txKind, setTxKind] = useState(TX_ORDER_PAYMENT);
  const [txAmount, setTxAmount] = useState('');
  const [txSource, setTxSource] = useState('ARKA'); // ARKA / BUDGET / OTHER
  const [txOrderCode, setTxOrderCode] = useState('');
  const [txClientName, setTxClientName] = useState('');
  const [txWorkerId, setTxWorkerId] = useState('');
  const [txNote, setTxNote] = useState('');

  // modal OPEN DAY
  const [openDayAmount, setOpenDayAmount] = useState('');

  // modal RESET
  const [showReset, setShowReset] = useState(false);
  const [resetPin, setResetPin] = useState('');

  // shtimi i puntorëve (vetëm ADMIN)
  const [newWorkerName, setNewWorkerName] = useState('');
  const [newWorkerRole, setNewWorkerRole] = useState(ROLE_WORKER);
  const [newWorkerPin, setNewWorkerPin] = useState('');

  // ----------------- INIT / LOAD -----------------

  async function initialLoad() {
    setLoading(true);
    try {
      // 1) config
      let cfg = loadConfigLocal();
      if (!cfg) {
        cfg = await loadConfigFromSupabase();
      }
      if (!cfg) {
        cfg = {
          // buxheti i kompanisë (manual plus/minus)
          companyBudget: 0,
          // asnjë punëtor i ruajtur – ADMIN master është me PIN 4563
          workers: [],
        };
      }

      setConfig(cfg);

      // 2) tx
      let tx = loadArkaTxLocal();
      if (!tx || tx.length === 0) {
        tx = await loadArkaTxFromSupabase();
      }
      setTxList(tx || []);

      // 3) user
      const u = loadCurrentUser();
      setCurrentUser(u);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    initialLoad();
  }, []);

  // sa euro në ARKË sipas transaksioneve
  const arkaBalance = useMemo(() => {
    let total = 0;
    for (const tx of txList) {
      const amt = safeNumber(tx.amount);
      if (!amt) continue;

      if (tx.kind === TX_OPEN_DAY) {
        total += amt;
        continue;
      }

      if (tx.source === 'ARKA') {
        if (tx.direction === 'IN') total += amt;
        else if (tx.direction === 'OUT') total -= amt;
      }
    }
    return total;
  }, [txList]);

  // buxheti i kompanisë sipas config + transaksioneve
  const companyBudget = useMemo(() => {
    if (!config) return 0;
    let total = safeNumber(config.companyBudget);
    for (const tx of txList) {
      const amt = safeNumber(tx.amount);
      if (!amt) continue;
      if (tx.source === 'BUDGET') {
        if (tx.direction === 'IN') total += amt;
        else if (tx.direction === 'OUT') total -= amt;
      }
    }
    return total;
  }, [config, txList]);

  const today = useMemo(() => Date.now(), []);
  const todayOpen = useMemo(
    () => txList.find((tx) => tx.kind === TX_OPEN_DAY && isSameDay(tx.ts, today)),
    [txList, today],
  );

  const todayTotalCash = useMemo(() => {
    return txList
      .filter((tx) => tx.kind !== TX_OPEN_DAY && isSameDay(tx.ts, today))
      .reduce(
        (sum, tx) =>
          sum +
          (tx.direction === 'IN' ? safeNumber(tx.amount) : -safeNumber(tx.amount)),
        0,
      );
  }, [txList, today]);

  const userTodayTotal = useMemo(() => {
    if (!currentUser) return 0;
    return txList
      .filter(
        (tx) => tx.workerId === currentUser.id && isSameDay(tx.ts, today),
      )
      .reduce(
        (sum, tx) =>
          sum +
          (tx.direction === 'IN' ? safeNumber(tx.amount) : -safeNumber(tx.amount)),
        0,
      );
  }, [txList, currentUser, today]);

  const isAdmin = currentUser?.role === ROLE_ADMIN;

  // lista e punëtorëve nga config
  const workers = config?.workers || [];

  function getWorkerNameById(id) {
    if (!config || !config.workers) return '';
    const w = config.workers.find((x) => x.id === id);
    return w ? w.name : '';
  }

  // ----------------- LOGIN / LOGOUT -----------------

  function handleLogin(e) {
    e.preventDefault();
    const pin = (pinInput || '').trim();
    if (!pin) return;

    // 1) MASTER PIN
    if (pin === MASTER_PIN) {
      const user = {
        id: 'MASTER',
        name: 'MASTER ADMIN',
        role: ROLE_ADMIN,
      };
      setCurrentUser(user);
      saveCurrentUser(user);
      setPinInput('');
      return;
    }

    // 2) kërko tek workers
    const cfg = config || { workers: [] };
    const match = (cfg.workers || []).find((w) => String(w.pin) === pin);
    if (!match) {
      alert('PIN i pasaktë.');
      return;
    }

    const user = {
      id: match.id,
      name: match.name,
      role: match.role,
    };
    setCurrentUser(user);
    saveCurrentUser(user);
    setPinInput('');
  }

  function handleLogout() {
    setCurrentUser(null);
    saveCurrentUser(null);
  }

  // ----------------- SHTO PUNTOR (ADMIN) -----------------

  async function handleAddWorker(e) {
    e.preventDefault();
    if (!isAdmin) return;
    const name = newWorkerName.trim();
    const pin = newWorkerPin.trim();
    if (!name || !pin) {
      alert('Shkruaj emrin dhe PIN-in për puntorin.');
      return;
    }
    const role = newWorkerRole || ROLE_WORKER;

    const newWorker = {
      id: genId('worker'),
      name,
      role,
      pin,
    };

    const newCfg = {
      ...(config || { companyBudget: 0, workers: [] }),
      workers: [...(config?.workers || []), newWorker],
    };

    setConfig(newCfg);
    saveConfigLocal(newCfg);
    await saveConfigToSupabase(newCfg);

    setNewWorkerName('');
    setNewWorkerPin('');
    setNewWorkerRole(ROLE_WORKER);
    alert('Përdoruesi u shtua.');
  }

  // ----------------- OPEN DAY -----------------

  async function handleOpenDay(e) {
    e.preventDefault();
    const amt = safeNumber(openDayAmount);
    if (!amt && amt !== 0) return;

    const workerId = currentUser?.id || 'SYSTEM';
    const workerName = currentUser?.name || 'SYSTEM';
    const workerRole = currentUser?.role || ROLE_ADMIN;

    const tx = {
      id: genId('open'),
      ts: Date.now(),
      kind: TX_OPEN_DAY,
      direction: 'IN',
      source: 'ARKA',
      amount: amt,
      workerId,
      workerName,
      workerRole,
      note: 'Hapja e ditës',
    };

    const newList = [tx, ...txList];
    setTxList(newList);
    saveArkaTxLocal(newList);
    await saveArkaTxToSupabase(tx);
    setOpenDayAmount('');
    alert('Dita u hap në ARKË.');
  }

  // ----------------- MODAL I RI TRANSAKSIONI -----------------

  function resetTxModalFields() {
    setTxKind(TX_ORDER_PAYMENT);
    setTxAmount('');
    setTxSource('ARKA');
    setTxOrderCode('');
    setTxClientName('');
    setTxWorkerId('');
    setTxNote('');
  }

  function openNewTxModal(kind = TX_ORDER_PAYMENT) {
    setTxKind(kind);
    resetTxModalFields();
    setShowTxModal(true);
  }

  function closeTxModal() {
    setShowTxModal(false);
  }

  async function handleSaveTx(e) {
    e.preventDefault();
    const amt = safeNumber(txAmount);
    if (!amt) {
      alert('Shkruaj shumën.');
      return;
    }

    const workerId = currentUser?.id || 'UNKNOWN';
    const workerName = currentUser?.name || 'UNKNOWN';
    const workerRole = currentUser?.role || ROLE_WORKER;

    let direction = 'IN';

    if (txKind === TX_ORDER_PAYMENT) {
      direction = 'IN';
    } else if (txKind === TX_ADVANCE || txKind === TX_EXPENSE || txKind === TX_BUDGET_OUT) {
      direction = 'OUT';
    } else if (txKind === TX_BUDGET_IN) {
      direction = 'IN';
    }

    const tx = {
      id: genId('tx'),
      ts: Date.now(),
      kind: txKind,
      direction,
      source: txSource, // ARKA / BUDGET / OTHER
      amount: amt,
      orderCode: txOrderCode || undefined,
      clientName: txClientName || undefined,
      workerId,
      workerName,
      workerRole,
      workerFor: txWorkerId || undefined,
      note: txNote || undefined,
    };

    const newList = [tx, ...txList];
    setTxList(newList);
    saveArkaTxLocal(newList);
    await saveArkaTxToSupabase(tx);

    if (txSource === 'BUDGET') {
      const base = config || { companyBudget: 0, workers: [] };
      let cb = safeNumber(base.companyBudget || 0);
      if (direction === 'IN') cb += amt;
      else cb -= amt;

      const newCfg = { ...base, companyBudget: cb };
      setConfig(newCfg);
      saveConfigLocal(newCfg);
      await saveConfigToSupabase(newCfg);
    }

    setShowTxModal(false);
    alert('Transaksioni u regjistrua.');
  }

  // ----------------- RESET SISTEMI (VETËM ADMIN) -----------------

  function askReset() {
    setResetPin('');
    setShowReset(true);
  }

  async function handleDoReset(option) {
    if (resetPin !== MASTER_PIN) {
      alert('PIN i gabuar. Vetëm master mund të bëjë reset.');
      return;
    }

    if (option === 'ARKA_ONLY') {
      await factoryResetArkaOnly(setTxList, setConfig, setCurrentUser);
      setShowReset(false);
      return;
    }

    if (option === 'ALL') {
      const ok = confirm(
        'KUJDES: Kjo do t’i fshijë edhe POROSITË edhe ARKËN. Vazhdosh?'
      );
      if (!ok) return;

      try {
        if (supabase) {
          const folders = ['orders', 'arka'];
          for (const folder of folders) {
            const { data, error } = await supabase.storage
              .from(BUCKET)
              .list(folder, { limit: 1000 });
            if (!error && data && data.length > 0) {
              const paths = data.map((item) => `${folder}/${item.name}`);
              if (paths.length > 0) {
                await supabase.storage.from(BUCKET).remove(paths);
              }
            }
          }
        }
      } catch (e) {
        console.error('Error during FULL reset Supabase', e);
      }

      if (typeof window !== 'undefined') {
        try {
          localStorage.clear();
        } catch (e) {
          console.error('Error clearing localStorage FULL', e);
        }
      }

      setTxList([]);
      setConfig(null);
      setCurrentUser(null);
      setShowReset(false);
      alert('KREJT SISTEMI u resetua.');
    }
  }

  // ----------------- RENDER LOGIN -----------------

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
          <h2 className="card-title">Shkruaj PIN-in</h2>
          <form
            onSubmit={handleLogin}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <input
              className="input"
              type="password"
              inputMode="numeric"
              placeholder="PIN"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
            />
            <button type="submit" className="btn primary">
              HYR NË ARKË
            </button>
          </form>
          {loading && <p style={{ marginTop: 12 }}>Duke lexuar të dhënat...</p>}
        </section>

        <footer className="footer-bar">
          <Link className="btn secondary" href="/">
            🏠 HOME
          </Link>
        </footer>
      </div>
    );
  }

  // ----------------- RENDER KRYESOR -----------------

  return (
    <div className="wrap" style={{ paddingBottom: '80px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">
            {currentUser.name} • {currentUser.role}
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          {isAdmin && (
            <>
              <div>
                BUGJET KOMPANI: <strong>{companyBudget.toFixed(2)} €</strong>
              </div>
              <div>
                ARKA TOTAL: <strong>{arkaBalance.toFixed(2)} €</strong>
              </div>
            </>
          )}
          {!isAdmin && (
            <div>
              SOT ({currentUser.name}):{' '}
              <strong>{userTodayTotal.toFixed(2)} €</strong>
            </div>
          )}
          {todayOpen ? (
            <div style={{ marginTop: 4, fontSize: 11 }}>
              HAPJA SOT: <strong>{todayOpen.amount.toFixed(2)} €</strong> • Lëvizje
              sot: <strong>{todayTotalCash.toFixed(2)} €</strong>
            </div>
          ) : (
            <div style={{ marginTop: 4, fontSize: 11 }}>
              DITA NUK ËSHTË HAPUR NË ARKË.
            </div>
          )}
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
            }}
          >
            {isAdmin && (
              <button
                type="button"
                className="btn secondary"
                style={{ padding: '4px 8px', fontSize: 10 }}
                onClick={askReset}
              >
                RESET SISTEMIN
              </button>
            )}
            <button
              type="button"
              className="btn secondary"
              style={{ padding: '4px 8px', fontSize: 10 }}
              onClick={handleLogout}
            >
              DALJE
            </button>
          </div>
        </div>
      </header>

      {/* HAPJA E DITËS */}
      {!todayOpen && (
        <section className="card">
          <h2 className="card-title">Hapja e ditës</h2>
          <form
            onSubmit={handleOpenDay}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <label className="label">
              Sa para ke sot në arkë në fillim të ditës?
            </label>
            <input
              className="input"
              type="number"
              step="0.01"
              inputMode="decimal"
              value={openDayAmount}
              onChange={(e) => setOpenDayAmount(e.target.value)}
              placeholder="p.sh. 50.00"
            />
            <button type="submit" className="btn primary">
              HAP DITËN
            </button>
          </form>
        </section>
      )}

      {/* PUNËTORËT (ADMIN) */}
      {isAdmin && (
        <section className="card">
          <h2 className="card-title">Përdoruesit (PUNTOR / TRANSPORT / DISPATCH / ADMIN)</h2>
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            Përdor PIN-e të thjeshta për puntorët. Master PIN **4563** është vetëm
            për ty (ADMIN).
          </div>

          <form
            onSubmit={handleAddWorker}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              marginBottom: 12,
            }}
          >
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input"
                style={{ flex: 2 }}
                type="text"
                placeholder="Emri i puntorit"
                value={newWorkerName}
                onChange={(e) => setNewWorkerName(e.targetValue || e.target.value)}
              />
              <select
                className="input"
                style={{ flex: 1 }}
                value={newWorkerRole}
                onChange={(e) => setNewWorkerRole(e.target.value)}
              >
                <option value={ROLE_WORKER}>PUNTOR</option>
                <option value={ROLE_TRANSPORT}>TRANSPORT</option>
                <option value={ROLE_DISPATCH}>DISPATCH</option>
                <option value={ROLE_ADMIN}>ADMIN</option>
              </select>
              <input
                className="input"
                style={{ flex: 1 }}
                type="password"
                inputMode="numeric"
                placeholder="PIN"
                value={newWorkerPin}
                onChange={(e) => setNewWorkerPin(e.target.value)}
              />
            </div>
            <button type="submit" className="btn secondary">
              + SHTO PËRDORUES
            </button>
          </form>

          {workers.length === 0 && (
            <p style={{ fontSize: 12 }}>Ende nuk ka përdorues të ruajtur.</p>
          )}
          {workers.map((w) => (
            <div key={w.id} className="home-btn" style={{ marginBottom: 6 }}>
              <div className="home-btn-main">
                <div>
                  <div style={{ fontWeight: 700 }}>{w.name}</div>
                  <div style={{ fontSize: 11 }}>
                    ROLI: {w.role} • PIN: {w.pin}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* BUTONAT KRYESORË TË TRANSAKSIONEVE */}
      <section className="card">
        <h2 className="card-title">Transaksione të reja</h2>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <button
            type="button"
            className="btn primary"
            onClick={() => openNewTxModal(TX_ORDER_PAYMENT)}
          >
            PAGUAR POROSINË
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => openNewTxModal(TX_ADVANCE)}
          >
            AVANS PUNTORI
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => openNewTxModal(TX_EXPENSE)}
          >
            SHPENZIM
          </button>
          {isAdmin && (
            <>
              <button
                type="button"
                className="btn secondary"
                onClick={() => openNewTxModal(TX_BUDGET_IN)}
              >
                + BUGJET KOMPANIE
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => openNewTxModal(TX_BUDGET_OUT)}
              >
                - BUGJET KOMPANIE
              </button>
            </>
          )}
        </div>
      </section>

      {/* LISTA E TRANSAKSIONEVE */}
      <section className="card">
        <h2 className="card-title">Lëvizjet e fundit</h2>
        {loading && <p>Duke i lexuar të dhënat...</p>}
        {!loading && txList.length === 0 && <p>Ende nuk ka transaksione në ARKË.</p>}

        {!loading &&
          txList.slice(0, 80).map((tx) => (
            <div key={tx.id} className="home-btn" style={{ marginBottom: 6 }}>
              <div className="home-btn-main">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {tx.kind === TX_ORDER_PAYMENT && 'PAGESË POROSIE'}
                    {tx.kind === TX_ADVANCE && 'AVANS PUNTORI'}
                    {tx.kind === TX_EXPENSE && 'SHPENZIM'}
                    {tx.kind === TX_BUDGET_IN && 'BUGJET IN'}
                    {tx.kind === TX_BUDGET_OUT && 'BUGJET OUT'}
                    {tx.kind === TX_OPEN_DAY && 'HAPJA E DITËS'}
                    {tx.kind === TX_CLOSE_DAY && 'MBYLLJA E DITËS'}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.9 }}>
                    {tx.orderCode && <>KODI: {tx.orderCode} • </>}
                    {tx.clientName && <>Klienti: {tx.clientName} • </>}
                    {tx.note && <>{tx.note} • </>}
                    {tx.workerName && <>Nga: {tx.workerName}</>}
                    {tx.workerFor && (
                      <> • Për: {getWorkerNameById(tx.workerFor) || tx.workerFor}</>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  <div>
                    <strong
                      style={{
                        color:
                          tx.direction === 'IN'
                            ? '#22c55e'
                            : '#ef4444',
                      }}
                    >
                      {tx.direction === 'IN' ? '+' : '-'}
                      {safeNumber(tx.amount).toFixed(2)} €
                    </strong>
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.8 }}>
                    {formatDateTime(tx.ts)}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.7 }}>
                    {tx.source === 'ARKA' && 'ARKA'}
                    {tx.source === 'BUDGET' && 'BUGJET KOMPANIE'}
                    {tx.source === 'OTHER' && 'TJETER'}
                  </div>
                </div>
              </div>
            </div>
          ))}
      </section>

      {/* MODAL – TRANSACION I RI */}
      {showTxModal && (
        <div className="modal-backdrop">
          <div className="card" style={{ maxWidth: 480, margin: '40px auto' }}>
            <h2 className="card-title">Transaksion i ri</h2>
            <form
              onSubmit={handleSaveTx}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div className="field-group">
                <label className="label">Lloji</label>
                <div style={{ fontSize: 12 }}>
                  {txKind === TX_ORDER_PAYMENT && 'PAGESË POROSIE (nga klienti)'}
                  {txKind === TX_ADVANCE && 'AVANS PUNTORI'}
                  {txKind === TX_EXPENSE && 'SHPENZIM'}
                  {txKind === TX_BUDGET_IN && 'BUGJET IN (shto bugjet kompanie)'}
                  {txKind === TX_BUDGET_OUT && 'BUGJET OUT (heq bugjet kompanie)'}
                </div>
              </div>

              {txKind === TX_ORDER_PAYMENT && (
                <>
                  <div className="field-group">
                    <label className="label">KODI I POROSISË</label>
                    <input
                      className="input"
                      type="text"
                      value={txOrderCode}
                      onChange={(e) => setTxOrderCode(e.target.value)}
                      placeholder="p.sh. 0123"
                    />
                  </div>
                  <div className="field-group">
                    <label className="label">EMRI I KLIENTIT</label>
                    <input
                      className="input"
                      type="text"
                      value={txClientName}
                      onChange={(e) => setTxClientName(e.target.value)}
                      placeholder="Opsionale"
                    />
                  </div>
                </>
              )}

              {(txKind === TX_ADVANCE || txKind === TX_EXPENSE) && (
                <div className="field-group">
                  <label className="label">
                    Për kë (puntori / transportusi / dispatch)? (opsionale)
                  </label>
                  <select
                    className="input"
                    value={txWorkerId}
                    onChange={(e) => setTxWorkerId(e.target.value)}
                  >
                    <option value="">(asnjë)</option>
                    {workers.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} • {w.role}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="field-group">
                <label className="label">SHUMA</label>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={txAmount}
                  onChange={(e) => setTxAmount(e.target.value)}
                  placeholder="p.sh. 10.00"
                />
              </div>

              <div className="field-group">
                <label className="label">Prej ku / te ku shkon paraja?</label>
                <div className="chip-row">
                  <button
                    type="button"
                    className={`chip ${txSource === 'ARKA' ? 'chip-active' : ''}`}
                    onClick={() => setTxSource('ARKA')}
                  >
                    ARKA
                  </button>
                  <button
                    type="button"
                    className={`chip ${txSource === 'BUDGET' ? 'chip-active' : ''}`}
                    onClick={() => setTxSource('BUDGET')}
                  >
                    BUGJET KOMPANIE
                  </button>
                  <button
                    type="button"
                    className={`chip ${txSource === 'OTHER' ? 'chip-active' : ''}`}
                    onClick={() => setTxSource('OTHER')}
                  >
                    TJETER
                  </button>
                </div>
              </div>

              <div className="field-group">
                <label className="label">SHËNIM / ARSYE</label>
                <textarea
                  className="input"
                  rows={2}
                  value={txNote}
                  onChange={(e) => setTxNote(e.target.value)}
                  placeholder="p.sh. avans dite, shampo, rrymë, etj."
                />
              </div>

              <div className="btn-row">
                <button type="button" className="btn secondary" onClick={closeTxModal}>
                  ANULO
                </button>
                <button type="submit" className="btn primary">
                  RUAJ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL – RESET SISTEMI */}
      {showReset && (
        <div className="modal-backdrop">
          <div className="card" style={{ maxWidth: 380, margin: '40px auto' }}>
            <h2 className="card-title">RESET SISTEMIN</h2>
            <p style={{ fontSize: 12, marginBottom: 8 }}>
              Shkruaj PIN-in MASTER (4563) dhe zgjidh çka dëshiron të fshish.
            </p>
            <input
              className="input"
              type="password"
              inputMode="numeric"
              placeholder="PIN MASTER"
              value={resetPin}
              onChange={(e) => setResetPin(e.target.value)}
            />
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setShowReset(false)}
              >
                ANULO
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => handleDoReset('ARKA_ONLY')}
              >
                RESET VEÇ ARKËN
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => handleDoReset('ALL')}
              >
                RESET KREJT SISTEMIN
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}