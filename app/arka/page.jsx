'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

export default function ArkaPage() {
  // -----------------------------
  // 0) SAFE helpers (NO SSR)
  // -----------------------------
  const isBrowser = typeof window !== 'undefined';

  const LS_KEYS = useMemo(
    () => ({
      USERS: 'ARKA_USERS',
      STATE: 'ARKA_STATE',
      MOVES: 'ARKA_MOVES',
      RECORDS: 'ARKA_RECORDS',
      CURRENT_USER: 'CURRENT_USER_DATA',
    }),
    []
  );

  const MASTER_PIN = '4563';
  const MASTER_PIN_HASH = '1e37bd2a0753';
  const ROLES = useMemo(() => ['ADMIN', 'PUNTOR', 'TRANSPORT', 'DISPATCH'], []);

  function hashPin(pin) {
    // minimal hashing (local only)
    if (pin === MASTER_PIN) return MASTER_PIN_HASH;
    return `hash_${String(pin || '').trim()}`;
  }

  function safeParseJSON(v, fallback) {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  function lsGetRaw(key) {
    if (!isBrowser) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function lsSet(key, val) {
    if (!isBrowser) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  }

  function lsRemove(key) {
    if (!isBrowser) return;
    try {
      window.localStorage.removeItem(key);
    } catch {}
  }

  function getData(key, fallback = null) {
    const raw = lsGetRaw(key);
    if (!raw) return fallback;
    return safeParseJSON(raw, fallback);
  }

  function formatEuro(cent) {
    const n = Number.isFinite(cent) ? cent : 0;
    return (n / 100).toFixed(2) + ' €';
  }

  function toCentFromEuroInput(v) {
    // accepts "12", "12.5", "12,5"
    const s = String(v ?? '').trim().replace(',', '.');
    const num = Number(s);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100);
  }

  function todayISO() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // -----------------------------
  // 1) Core ARKA API (client-only)
  // -----------------------------
  const apiRef = useRef(null);

  function initSystemOnce() {
    // users
    let users = getData(LS_KEYS.USERS, []);
    if (!Array.isArray(users) || users.length === 0) {
      users = [
        {
          id: 'u1',
          name: 'ADMIN',
          role: 'ADMIN',
          hashedPin: MASTER_PIN_HASH,
        },
      ];
      lsSet(LS_KEYS.USERS, users);
    }

    // state
    let state = getData(LS_KEYS.STATE, null);
    if (!state || typeof state !== 'object') {
      state = {
        COMPANY_BUDGET: 0,
        DAILY_CASH: 0,
        CASH_START_TODAY: 0,
        currentDayOpened: null, // YYYY-MM-DD
        openedBy: null,
        openedByRole: null,
        openedAt: null,
      };
      lsSet(LS_KEYS.STATE, state);
    }

    // arrays
    if (!Array.isArray(getData(LS_KEYS.MOVES, []))) lsSet(LS_KEYS.MOVES, []);
    if (!Array.isArray(getData(LS_KEYS.RECORDS, []))) lsSet(LS_KEYS.RECORDS, []);

    // api
    apiRef.current = {
      ROLES,

      getCurrentUser: () => getData(LS_KEYS.CURRENT_USER, {}) || {},

      handleLogin: (pin) => {
        const hashed = hashPin(pin);
        const u = (getData(LS_KEYS.USERS, []) || []).find((x) => x?.hashedPin === hashed);
        if (!u) return { success: false, message: 'PIN i gabuar' };
        lsSet(LS_KEYS.CURRENT_USER, { id: u.id, name: u.name, role: u.role });
        return { success: true, user: { id: u.id, name: u.name, role: u.role } };
      },

      logout: () => {
        lsRemove(LS_KEYS.CURRENT_USER);
        return { success: true };
      },

      listUsers: () => getData(LS_KEYS.USERS, []) || [],

      manageUsers: (action, data) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (me.role !== 'ADMIN') return { success: false, message: 'Nuk je ADMIN' };

        let users2 = getData(LS_KEYS.USERS, []) || [];
        if (!Array.isArray(users2)) users2 = [];

        if (action === 'ADD') {
          const name = String(data?.name || '').trim();
          const pin = String(data?.pin || '').trim();
          const role = String(data?.role || '').trim().toUpperCase();

          if (!name || !pin) return { success: false, message: 'Emri/PIN mungon' };
          if (!ROLES.includes(role)) return { success: false, message: 'Roli i pavlefshëm' };

          const newUser = {
            id: `u${Date.now()}`,
            name,
            role,
            hashedPin: hashPin(pin),
          };
          users2.push(newUser);
          lsSet(LS_KEYS.USERS, users2);
          return { success: true, users: users2 };
        }

        if (action === 'DELETE') {
          const id = String(data?.id || '');
          if (!id) return { success: false, message: 'ID mungon' };
          if (id === me.id) return { success: false, message: 'S’mund ta fshish vetën' };
          users2 = users2.filter((u) => u?.id !== id);
          lsSet(LS_KEYS.USERS, users2);
          return { success: true, users: users2 };
        }

        return { success: false, message: 'Action i panjohur' };
      },

      getState: () => getData(LS_KEYS.STATE, null),

      initializeDay: (startCashCent) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (!me?.name) return { success: false, message: 'Duhet login' };

        const state = getData(LS_KEYS.STATE, null);
        if (!state) return { success: false, message: 'State mungon' };

        const today = todayISO();
        if (state.currentDayOpened === today) {
          return { success: false, message: 'Dita tashmë e hapur' };
        }

        const sc = Math.max(0, Number(startCashCent) || 0);
        state.DAILY_CASH = sc;
        state.CASH_START_TODAY = sc;
        state.currentDayOpened = today;
        state.openedBy = me.name;
        state.openedByRole = me.role;
        state.openedAt = Date.now();
        lsSet(LS_KEYS.STATE, state);

        return { success: true, state };
      },

      closeDayAndTransfer: () => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (!me?.name) return { success: false, message: 'Duhet login' };

        const state = getData(LS_KEYS.STATE, null);
        if (!state?.currentDayOpened) return { success: false, message: 'Dita s’është hapur' };

        const profit = (Number(state.DAILY_CASH) || 0) - (Number(state.CASH_START_TODAY) || 0);
        state.COMPANY_BUDGET = (Number(state.COMPANY_BUDGET) || 0) + profit;

        // reset day
        state.currentDayOpened = null;
        state.openedBy = null;
        state.openedByRole = null;
        state.openedAt = null;
        state.DAILY_CASH = 0;
        state.CASH_START_TODAY = 0;

        lsSet(LS_KEYS.STATE, state);
        return { success: true, profit, state };
      },

      recordMove: ({ type, source, amountCent, who, note }) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (!me?.name) return { success: false, message: 'Duhet login' };

        const t = String(type || '').trim();
        const s = String(source || '').trim(); // 'arka' | 'budget' | 'external'
        const amt = Math.max(0, Number(amountCent) || 0);

        if (!['expense', 'advance', 'topup'].includes(t)) {
          return { success: false, message: 'Type i pavlefshëm' };
        }
        if (!['arka', 'budget', 'external'].includes(s)) {
          return { success: false, message: 'Source i pavlefshëm' };
        }

        // role limits:
        if (t === 'topup' && me.role !== 'ADMIN') {
          return { success: false, message: 'Vetëm ADMIN mund TOP-UP' };
        }

        const state = getData(LS_KEYS.STATE, null);
        if (!state) return { success: false, message: 'State mungon' };

        // apply money effects
        if (t === 'expense' || t === 'advance') {
          if (s === 'arka') {
            if ((Number(state.DAILY_CASH) || 0) < amt) {
              return { success: false, message: 'Nuk ka cash në ARKË' };
            }
            state.DAILY_CASH = (Number(state.DAILY_CASH) || 0) - amt;
          } else if (s === 'budget') {
            state.COMPANY_BUDGET = (Number(state.COMPANY_BUDGET) || 0) - amt;
          } else {
            // external not allowed for expense/advance
            return { success: false, message: 'External s’lejohet këtu' };
          }
        }

        if (t === 'topup') {
          if (s !== 'external') return { success: false, message: 'TOPUP duhet external' };
          state.COMPANY_BUDGET = (Number(state.COMPANY_BUDGET) || 0) + amt;
        }

        // write move
        const moves = getData(LS_KEYS.MOVES, []) || [];
        const move = {
          id: `m${Date.now()}`,
          ts: Date.now(),
          type: t,
          source: s,
          amount: amt,
          who: String(who || '').trim() || null,
          note: String(note || '').trim() || null,
          byUserName: me.name,
          byUserRole: me.role,
        };
        moves.push(move);
        lsSet(LS_KEYS.MOVES, moves);
        lsSet(LS_KEYS.STATE, state);

        return { success: true, move, state };
      },

      listMovesForToday: () => {
        const state = getData(LS_KEYS.STATE, null);
        const day = state?.currentDayOpened || todayISO();
        const moves = getData(LS_KEYS.MOVES, []) || [];
        // keep it simple: show last 200 moves; filter by ts date matches day
        const start = new Date(day + 'T00:00:00').getTime();
        const end = new Date(day + 'T23:59:59').getTime();
        return moves.filter((m) => m?.ts >= start && m?.ts <= end).slice(-200).reverse();
      },

      listMovesForMe: () => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        const moves = getData(LS_KEYS.MOVES, []) || [];
        return moves.filter((m) => m?.byUserName === me?.name).slice(-200).reverse();
      },

      resetSystemFactory: (adminPin) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (me.role !== 'ADMIN') return { success: false, message: 'Vetëm ADMIN' };

        const users = getData(LS_KEYS.USERS, []) || [];
        const admin = users.find((u) => u?.id === me.id);
        if (!admin) return { success: false, message: 'Admin missing' };

        if (hashPin(adminPin) !== admin.hashedPin) {
          return { success: false, message: 'PIN gabim' };
        }

        // wipe arka data (keep users)
        lsRemove(LS_KEYS.MOVES);
        lsRemove(LS_KEYS.RECORDS);

        const state = getData(LS_KEYS.STATE, null) || {};
        state.COMPANY_BUDGET = 0;
        state.DAILY_CASH = 0;
        state.CASH_START_TODAY = 0;
        state.currentDayOpened = null;
        state.openedBy = null;
        state.openedByRole = null;
        state.openedAt = null;
        lsSet(LS_KEYS.STATE, state);

        return { success: true };
      },
    };
  }

  // -----------------------------
  // 2) UI state
  // -----------------------------
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState({});

  const [pin, setPin] = useState('');
  const [loginError, setLoginError] = useState('');

  const [showUsers, setShowUsers] = useState(false);

  // ADMIN create user form
  const [newName, setNewName] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newRole, setNewRole] = useState('PUNTOR');

  // Day open
  const [cashStart, setCashStart] = useState('');

  // Moves forms
  const [advWho, setAdvWho] = useState('');
  const [advAmount, setAdvAmount] = useState('');
  const [advSource, setAdvSource] = useState('arka');
  const [advNote, setAdvNote] = useState('');

  const [expAmount, setExpAmount] = useState('');
  const [expSource, setExpSource] = useState('arka');
  const [expNote, setExpNote] = useState('');

  const [topAmount, setTopAmount] = useState('');
  const [topWho, setTopWho] = useState('');
  const [topNote, setTopNote] = useState('');

  const [refreshTick, setRefreshTick] = useState(0);

  const state = useMemo(() => {
    if (!ready) return null;
    return apiRef.current?.getState?.() || null;
  }, [ready, refreshTick]);

  const users = useMemo(() => {
    if (!ready) return [];
    return apiRef.current?.listUsers?.() || [];
  }, [ready, refreshTick]);

  const movesToday = useMemo(() => {
    if (!ready) return [];
    // admin sees today; others see only theirs (simple)
    if (me?.role === 'ADMIN') return apiRef.current?.listMovesForToday?.() || [];
    return apiRef.current?.listMovesForMe?.() || [];
  }, [ready, me?.role, refreshTick]);

  // init
  useEffect(() => {
    if (!isBrowser) return;
    initSystemOnce();
    const current = getData(LS_KEYS.CURRENT_USER, {}) || {};
    setMe(current);
    setReady(true);
  }, [isBrowser, LS_KEYS.CURRENT_USER]);

  function hardRefresh() {
    setRefreshTick((x) => x + 1);
    const current = getData(LS_KEYS.CURRENT_USER, {}) || {};
    setMe(current);
  }

  // -----------------------------
  // 3) Actions
  // -----------------------------
  function doLogin() {
    setLoginError('');
    const res = apiRef.current?.handleLogin?.(pin);
    if (!res?.success) {
      setLoginError(res?.message || 'PIN i gabuar');
      return;
    }
    setPin('');
    hardRefresh();
  }

  function doLogout() {
    apiRef.current?.logout?.();
    hardRefresh();
  }

  function doAddUser() {
    const res = apiRef.current?.manageUsers?.('ADD', {
      name: newName,
      pin: newPin,
      role: newRole,
    });
    if (!res?.success) {
      alert('❌ Nuk u shtua: ' + (res?.message || ''));
      return;
    }
    setNewName('');
    setNewPin('');
    setNewRole('PUNTOR');
    hardRefresh();
    alert('✅ Puntori u shtua');
  }

  function doDeleteUser(id) {
    if (!confirm('Fshi përdoruesin?')) return;
    const res = apiRef.current?.manageUsers?.('DELETE', { id });
    if (!res?.success) {
      alert('❌ S’u fshi: ' + (res?.message || ''));
      return;
    }
    hardRefresh();
  }

  function doOpenDay() {
    const cents = toCentFromEuroInput(cashStart);
    const res = apiRef.current?.initializeDay?.(cents);
    if (!res?.success) {
      alert('❌ ' + (res?.message || 'S’u hap dita'));
      return;
    }
    setCashStart('');
    hardRefresh();
  }

  function doCloseDay() {
    const res = apiRef.current?.closeDayAndTransfer?.();
    if (!res?.success) {
      alert('❌ ' + (res?.message || 'S’u mbyll dita'));
      return;
    }
    alert('✅ Dita u mbyll. Neto: ' + formatEuro(res.profit));
    hardRefresh();
  }

  function doMove(type) {
    if (type === 'advance') {
      const res = apiRef.current?.recordMove?.({
        type: 'advance',
        source: advSource,
        amountCent: toCentFromEuroInput(advAmount),
        who: advWho,
        note: advNote,
      });
      if (!res?.success) return alert('❌ ' + (res?.message || 'Gabim'));
      setAdvWho('');
      setAdvAmount('');
      setAdvNote('');
      hardRefresh();
      return;
    }

    if (type === 'expense') {
      const res = apiRef.current?.recordMove?.({
        type: 'expense',
        source: expSource,
        amountCent: toCentFromEuroInput(expAmount),
        who: null,
        note: expNote,
      });
      if (!res?.success) return alert('❌ ' + (res?.message || 'Gabim'));
      setExpAmount('');
      setExpNote('');
      hardRefresh();
      return;
    }

    if (type === 'topup') {
      const res = apiRef.current?.recordMove?.({
        type: 'topup',
        source: 'external',
        amountCent: toCentFromEuroInput(topAmount),
        who: topWho,
        note: topNote,
      });
      if (!res?.success) return alert('❌ ' + (res?.message || 'Gabim'));
      setTopAmount('');
      setTopWho('');
      setTopNote('');
      hardRefresh();
      return;
    }
  }

  function doFactoryReset() {
    if (me?.role !== 'ADMIN') return;
    const p = prompt('PIN i ADMIN për RESET');
    if (!p) return;
    const res = apiRef.current?.resetSystemFactory?.(p);
    if (!res?.success) return alert('❌ ' + (res?.message || 'Gabim'));
    alert('✅ FACTORY RESET u kry');
    hardRefresh();
  }

  // -----------------------------
  // 4) Minimal styling (safe)
  // -----------------------------
  const box = {
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 18,
    padding: 14,
    marginTop: 12,
    background: 'rgba(0,0,0,0.25)',
  };

  const input = {
    width: '100%',
    padding: '12px 12px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(0,0,0,0.25)',
    color: 'white',
    outline: 'none',
  };

  const btn = {
    padding: '10px 14px',
    borderRadius: 999,
    border: '1px solid rgba(255,255,255,0.16)',
    background: 'rgba(255,255,255,0.06)',
    color: 'white',
    fontWeight: 700,
    letterSpacing: 0.5,
  };

  const btnPrimary = {
    ...btn,
    background: 'rgba(59,130,246,0.95)',
    border: '1px solid rgba(59,130,246,1)',
  };

  // -----------------------------
  // 5) Render
  // -----------------------------
  if (!ready) {
    return (
      <div style={{ padding: 18, color: 'white' }}>
        <div style={{ fontSize: 28, fontWeight: 900 }}>ARKA</div>
        <div style={{ opacity: 0.8, marginTop: 8 }}>Duke u ngarkuar…</div>
      </div>
    );
  }

  const isAdmin = me?.role === 'ADMIN';
  const dayOpen = state?.currentDayOpened ? true : false;

  return (
    <div style={{ padding: 18, color: 'white', maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 34, fontWeight: 900 }}>ARKA</div>
          <div style={{ opacity: 0.7, marginTop: 2 }}>
            {me?.name ? (
              <>
                {me.name} · {me.role}{' '}
                <button style={{ ...btn, marginLeft: 10 }} onClick={doLogout}>
                  DIL
                </button>
              </>
            ) : (
              <>S’je kyçur</>
            )}
          </div>
        </div>

        <div style={{ textAlign: 'right', fontWeight: 800, lineHeight: 1.2 }}>
          <div style={{ opacity: 0.75 }}>SOT: {formatEuro(state?.DAILY_CASH || 0)}</div>
          {isAdmin ? (
            <div style={{ opacity: 0.75 }}>BUXHETI: {formatEuro(state?.COMPANY_BUDGET || 0)}</div>
          ) : (
            <div style={{ opacity: 0.55 }}>BUXHETI: (FSHEHUR)</div>
          )}
        </div>
      </div>

      {/* LOGIN */}
      {!me?.name && (
        <div style={box}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>LOGIN ME PIN</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              style={input}
              inputMode="numeric"
              placeholder="PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            <button style={btnPrimary} onClick={doLogin}>
              LOGIN
            </button>
          </div>
          {loginError ? <div style={{ color: '#ff8a8a', marginTop: 8 }}>{loginError}</div> : null}
        </div>
      )}

      {/* QUICK: show users */}
      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <button style={btn} onClick={() => setShowUsers((x) => !x)}>
          {showUsers ? 'MSHFEH PËRDORUESIT' : 'SHFAQ PËRDORUESIT'}
        </button>

        <button style={btn} onClick={hardRefresh}>
          RIFRESKO
        </button>

        {isAdmin ? (
          <button style={{ ...btn, borderColor: 'rgba(255,100,100,0.5)' }} onClick={doFactoryReset}>
            RESET SISTEMI
          </button>
        ) : null}
      </div>

      {/* USERS (ADMIN) */}
      {showUsers && (
        <div style={box}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>PËRDORUESIT</div>

          {isAdmin ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <input style={input} placeholder="Emri" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <input
                style={input}
                inputMode="numeric"
                placeholder="PIN"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
              />
              <select style={input} value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                {ROLES.filter((r) => r !== 'ADMIN').map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button style={btnPrimary} onClick={doAddUser}>
                ➕ SHTO PUNTOR
              </button>
            </div>
          ) : (
            <div style={{ opacity: 0.7, marginBottom: 10 }}>Vetëm ADMIN mund t’i menaxhojë përdoruesit.</div>
          )}

          <div style={{ display: 'grid', gap: 8 }}>
            {users.map((u) => (
              <div
                key={u.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: 10,
                  borderRadius: 12,
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 900 }}>{u.name}</div>
                  <div style={{ opacity: 0.75 }}>{u.role}</div>
                </div>
                {isAdmin && u.id !== me.id ? (
                  <button style={{ ...btn, borderColor: 'rgba(255,100,100,0.45)' }} onClick={() => doDeleteUser(u.id)}>
                    FSHI
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* DAY PANEL */}
      {me?.name && (
        <div style={box}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>DITA E SOTME ({todayISO()})</div>

          {!dayOpen ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                style={{ ...input, maxWidth: 220 }}
                placeholder="CASH START €"
                value={cashStart}
                onChange={(e) => setCashStart(e.target.value)}
              />
              <button style={btnPrimary} onClick={doOpenDay}>
                HAP DITËN
              </button>
            </div>
          ) : (
            <>
              <div style={{ opacity: 0.8, marginBottom: 10 }}>
                Dita është hapur nga <b>{state?.openedBy || '—'}</b> ({state?.openedByRole || '—'}).
              </div>

              <div style={{ fontWeight: 800, lineHeight: 1.5, opacity: 0.9 }}>
                CASH START: {formatEuro(state?.CASH_START_TODAY || 0)} · CASH SOT: {formatEuro(state?.DAILY_CASH || 0)}
              </div>

              <div style={{ marginTop: 10 }}>
                <button style={btnPrimary} onClick={doCloseDay}>
                  MBYLLE DITËN & TRANSFERO NË BUXHET
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* MOVES */}
      {me?.name && (
        <div style={box}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>SHPENZIME & AVANSA</div>

          {/* Advance */}
          <div style={{ marginTop: 10, fontWeight: 800, opacity: 0.9 }}>AVANS PËR PUNTOR</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <input
              style={input}
              placeholder="Emri i puntorit"
              value={advWho}
              onChange={(e) => setAdvWho(e.target.value)}
            />
            <input
              style={input}
              placeholder="Shuma €"
              value={advAmount}
              onChange={(e) => setAdvAmount(e.target.value)}
            />
            <select style={input} value={advSource} onChange={(e) => setAdvSource(e.target.value)}>
              <option value="arka">Nga ARKA</option>
              <option value="budget">Nga BUXHETI</option>
            </select>
            <input style={input} placeholder="Shënim" value={advNote} onChange={(e) => setAdvNote(e.target.value)} />
          </div>
          <div style={{ marginTop: 10 }}>
            <button style={btn} onClick={() => doMove('advance')}>
              SHTO AVANS
            </button>
          </div>

          {/* Expense */}
          <div style={{ marginTop: 18, fontWeight: 800, opacity: 0.9 }}>SHPENZIM I RI</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <input
              style={input}
              placeholder="Shuma €"
              value={expAmount}
              onChange={(e) => setExpAmount(e.target.value)}
            />
            <select style={input} value={expSource} onChange={(e) => setExpSource(e.target.value)}>
              <option value="arka">Nga ARKA</option>
              <option value="budget">Nga BUXHETI</option>
            </select>
            <input
              style={{ ...input, gridColumn: '1 / span 2' }}
              placeholder="Kategoria / shënim (p.sh. shampo, rrymë...)"
              value={expNote}
              onChange={(e) => setExpNote(e.target.value)}
            />
          </div>
          <div style={{ marginTop: 10 }}>
            <button style={btn} onClick={() => doMove('expense')}>
              SHTO SHPENZIM
            </button>
          </div>

          {/* Topup (ADMIN only) */}
          <div style={{ marginTop: 18, fontWeight: 800, opacity: 0.9 }}>
            TOP-UP PËR KOMPANI (DIKUSH I JEP PARA)
          </div>
          {isAdmin ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                <input
                  style={input}
                  placeholder="Shuma €"
                  value={topAmount}
                  onChange={(e) => setTopAmount(e.target.value)}
                />
                <input
                  style={input}
                  placeholder="Kush i dha?"
                  value={topWho}
                  onChange={(e) => setTopWho(e.target.value)}
                />
                <input
                  style={{ ...input, gridColumn: '1 / span 2' }}
                  placeholder="Shënim opsional"
                  value={topNote}
                  onChange={(e) => setTopNote(e.target.value)}
                />
              </div>
              <div style={{ marginTop: 10 }}>
                <button style={btn} onClick={() => doMove('topup')}>
                  SHTO TOP-UP
                </button>
              </div>
            </>
          ) : (
            <div style={{ marginTop: 10, opacity: 0.65 }}>Vetëm ADMIN mund të bëjë TOP-UP.</div>
          )}
        </div>
      )}

      {/* MOVES LIST */}
      {me?.name && (
        <div style={box}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>
            LËVIZJET ({me?.role === 'ADMIN' ? 'SOT' : 'VETËM TË MIAT'})
          </div>
          {movesToday.length === 0 ? (
            <div style={{ opacity: 0.7 }}>Ende nuk ka lëvizje.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {movesToday.map((m) => (
                <div
                  key={m.id}
                  style={{
                    padding: 10,
                    borderRadius: 12,
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontWeight: 900 }}>
                      {m.type.toUpperCase()} · {m.source.toUpperCase()}
                    </div>
                    <div style={{ fontWeight: 900 }}>{formatEuro(m.amount)}</div>
                  </div>
                  <div style={{ opacity: 0.75, marginTop: 4 }}>
                    {m.who ? <>👤 {m.who} · </> : null}
                    {m.note ? m.note : '—'}
                  </div>
                  <div style={{ opacity: 0.55, marginTop: 4, fontSize: 12 }}>
                    {m.byUserName} ({m.byUserRole}) · {new Date(m.ts).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ height: 40 }} />
    </div>
  );
}