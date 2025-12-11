'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

const LS_USERS = 'arka_users_v1';
const LS_CURRENT_USER = 'arka_current_user_v1';
const LS_RECORDS = 'arka_records_v1';
const LS_DAYS = 'arka_days_v1';
const LS_BUDGET = 'arka_company_budget_v1';
const LS_WORKERS = 'arka_workers_v1';

const RECORD_TYPES = {
  PAY_CLIENT: 'PAGESË KLIENTI',
  EXPENSE: 'SHPENZIM',
  ADVANCE: 'AVANS PUNTORI',
  TOPUP: 'TOP-UP BUXHETI',
};

const SOURCES = {
  ARKA: 'ARKA',
  BUXHET: 'BUXHET KOMPANIE',
  EXTERNAL: 'EKSTERNE / BORXH',
};

// ----------------- HELPERS -----------------

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayKeyFromTs(ts) {
  const d = new Date(ts || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadState(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val == null ? fallback : val;
  } catch {
    return fallback;
  }
}

function saveState(key, value) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

// ----------------- SUPABASE HELPERS -----------------

async function loadArkaStateOnline() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download('arka/state.json');
    if (error || !data) return null;
    const text = await data.text();
    const json = JSON.parse(text);
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

// Lexon pagesat ekzistuese nga MARRJE SOT (skedarët e vjetër në bucket/arka/)
async function loadMarrjeSotPaymentsOnline() {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.storage.from(BUCKET).list('arka', {
      limit: 1000,
    });
    if (error || !data) return [];

    const list = [];
    for (const item of data) {
      if (!item || !item.name) continue;
      if (item.name === 'state.json') continue;

      const { data: file, error: dErr } = await supabase.storage
        .from(BUCKET)
        .download(`arka/${item.name}`);
      if (dErr || !file) continue;

      try {
        const text = await file.text();
        const rec = JSON.parse(text);
        if (!rec || !rec.id) continue;
        if (typeof rec.paid === 'undefined') continue;
        list.push(rec);
      } catch {
        // skip
      }
    }
    return list;
  } catch {
    return [];
  }
}

async function saveArkaStateOnline(state) {
  if (!supabase) return;
  try {
    const blob =
      typeof Blob !== 'undefined'
        ? new Blob([JSON.stringify(state)], { type: 'application/json' })
        : null;
    if (!blob) return;
    await supabase.storage
      .from(BUCKET)
      .upload('arka/state.json', blob, { upsert: true });
  } catch (e) {
    console.error('Error saving ARKA state online', e);
  }
}

// ----------------- DEFAULT DATA -----------------

function ensureDefaultUsers() {
  let users = loadState(LS_USERS, null);
  if (!users || !Array.isArray(users) || users.length === 0) {
    users = [
      {
        id: 'admin',
        name: 'ADMIN',
        role: 'ADMIN',
        pin: '1234',
      },
      {
        id: 'worker1',
        name: 'PUNTOR 1',
        role: 'WORKER',
        pin: '1111',
      },
    ];
    saveState(LS_USERS, users);
  }
  return users;
}

function initialBudget() {
  const b = loadState(LS_BUDGET, null);
  if (typeof b === 'number') return b;
  return 0;
}

// ----------------- MAIN COMPONENT -----------------

export default function ArkaPage() {
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);

  const [records, setRecords] = useState([]);
  const [days, setDays] = useState([]);
  const [companyBudget, setCompanyBudget] = useState(0);
  const [workers, setWorkers] = useState([]);

  const [loading, setLoading] = useState(true);
  const [loginPin, setLoginPin] = useState('');
  const [loginError, setLoginError] = useState('');

  // forma për ditën
  const [openingAmount, setOpeningAmount] = useState('');
  // forma shpenzim
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseSource, setExpenseSource] = useState('ARKA');
  const [expenseCategory, setExpenseCategory] = useState('');
  const [expenseNote, setExpenseNote] = useState('');
  // forma avans
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [advanceSource, setAdvanceSource] = useState('ARKA');
  const [advanceWorkerId, setAdvanceWorkerId] = useState('');
  const [advanceNote, setAdvanceNote] = useState('');
  // forma topup
  const [topupAmount, setTopupAmount] = useState('');
  const [topupFrom, setTopupFrom] = useState('');
  const [topupNote, setTopupNote] = useState('');

  // forma worker
  const [newWorkerName, setNewWorkerName] = useState('');
  const [newWorkerSalary, setNewWorkerSalary] = useState('');

  // forma buxhet
  const [budgetInput, setBudgetInput] = useState('');

  // *** PANELI I RI PAGUAJ ***
  const [payMode, setPayMode] = useState('WORKER'); // WORKER | EXPENSE
  const [payWorkerId, setPayWorkerId] = useState('');
  const [payWorkerAmount, setPayWorkerAmount] = useState('');
  const [payWorkerSource, setPayWorkerSource] = useState('ARKA');
  const [payWorkerNote, setPayWorkerNote] = useState('');

  const [payExpAmount, setPayExpAmount] = useState('');
  const [payExpSource, setPayExpSource] = useState('ARKA'); // ARKA | BUXHET | EXTERNAL
  const [payExpCategory, setPayExpCategory] = useState('');
  const [payExpFrom, setPayExpFrom] = useState('');
  const [payExpNote, setPayExpNote] = useState('');

  // ----------------- LOAD INITIAL -----------------

  useEffect(() => {
    if (typeof window === 'undefined') return;

    async function init() {
      setLoading(true);
      // 1) LOCAL DEFAULTS
      let localUsers = ensureDefaultUsers();
      let localCurrent = loadState(LS_CURRENT_USER, null);
      let localRecords = loadState(LS_RECORDS, []);
      let localDays = loadState(LS_DAYS, []);
      let localBudget = initialBudget();
      let localWorkers = loadState(LS_WORKERS, []);

      if (!Array.isArray(localRecords)) localRecords = [];
      if (!Array.isArray(localDays)) localDays = [];
      if (!Array.isArray(localWorkers)) localWorkers = [];

      // 2) ONLINE STATE
      let online = null;
      try {
        online = await loadArkaStateOnline();
      } catch (e) {
        console.error('Error loading ARKA state online', e);
      }

      let mergedUsers = localUsers;
      let mergedRecords = localRecords;
      let mergedDays = localDays;
      let mergedBudget = localBudget;
      let mergedWorkers = localWorkers;

      if (online) {
        if (Array.isArray(online.users) && online.users.length > 0) {
          mergedUsers = online.users;
        }
        if (Array.isArray(online.records)) {
          mergedRecords = online.records;
        }
        if (Array.isArray(online.days)) {
          mergedDays = online.days;
        }
        if (typeof online.companyBudget === 'number') {
          mergedBudget = online.companyBudget;
        }
        if (Array.isArray(online.workers)) {
          mergedWorkers = online.workers;
        }
      }

      // 3) PAGESAT NGA MARRJE SOT
      try {
        const pays = await loadMarrjeSotPaymentsOnline();
        if (pays && pays.length > 0) {
          const existingExternalIds = new Set(
            mergedRecords
              .filter((r) => r.externalSource === 'MARRJE_SOT' && r.externalId)
              .map((r) => r.externalId),
          );

          const converted = pays
            .filter((p) => !existingExternalIds.has(p.id))
            .map((p) => {
              const amt = Number(p.paid) || 0;
              const ts = p.ts || Date.now();
              return {
                id: generateId('pay'),
                type: 'PAY_CLIENT',
                dayKey: dayKeyFromTs(ts),
                amount: amt,
                direction: 'IN',
                source: 'ARKA',
                externalSource: 'MARRJE_SOT',
                externalId: p.id,
                orderCode: p.code || '',
                orderName: p.name || '',
                byUser: p.byUser || '',
                note: `Pagesë klienti (kodi ${p.code || '??'})`,
                ts,
              };
            });

          if (converted.length > 0) {
            mergedRecords = [...converted, ...mergedRecords];
          }
        }
      } catch (e) {
        console.error('Error importing payments from MARRJE SOT', e);
      }

      // 4) SET STATE
      setUsers(mergedUsers);
      setCurrentUser(localCurrent);
      setRecords(mergedRecords);
      setDays(mergedDays);
      setCompanyBudget(mergedBudget);
      setWorkers(mergedWorkers);
      setBudgetInput(String(mergedBudget || ''));

      // 5) CACHE LOCAL
      saveState(LS_USERS, mergedUsers);
      saveState(LS_RECORDS, mergedRecords);
      saveState(LS_DAYS, mergedDays);
      saveState(LS_BUDGET, mergedBudget);
      saveState(LS_WORKERS, mergedWorkers);

      setLoading(false);
    }

    init();
  }, []);

  // PERSIST LOCAL
  useEffect(() => {
    if (loading) return;
    saveState(LS_RECORDS, records);
  }, [records, loading]);

  useEffect(() => {
    if (loading) return;
    saveState(LS_DAYS, days);
  }, [days, loading]);

  useEffect(() => {
    if (loading) return;
    saveState(LS_BUDGET, companyBudget);
  }, [companyBudget, loading]);

  useEffect(() => {
    if (loading) return;
    saveState(LS_WORKERS, workers);
  }, [workers, loading]);

  useEffect(() => {
    if (loading) return;
    saveState(LS_CURRENT_USER, currentUser);
  }, [currentUser, loading]);

  // PERSIST ONLINE
  useEffect(() => {
    if (loading) return;
    const state = {
      users,
      records,
      days,
      companyBudget,
      workers,
    };
    saveArkaStateOnline(state);
  }, [users, records, days, companyBudget, workers, loading]);

  const today = todayKey();
  const todayDay = useMemo(
    () => days.find((d) => d.dayKey === today) || null,
    [days, today],
  );

  const todaysRecords = useMemo(
    () => records.filter((r) => r.dayKey === today),
    [records, today],
  );

  const todayTotals = useMemo(() => {
    if (!todayDay) return { in: 0, out: 0, net: 0, closing: 0 };
    let inSum = 0;
    let outSum = 0;
    for (const r of todaysRecords) {
      if (r.direction === 'IN' && r.source === 'ARKA') inSum += Number(r.amount) || 0;
      if (r.direction === 'OUT' && r.source === 'ARKA') outSum += Number(r.amount) || 0;
    }
    const net = inSum - outSum;
    const closing = (Number(todayDay.openingCash) || 0) + net;
    return {
      in: Number(inSum.toFixed(2)),
      out: Number(outSum.toFixed(2)),
      net: Number(net.toFixed(2)),
      closing: Number(closing.toFixed(2)),
    };
  }, [todaysRecords, todayDay]);

  // payroll për muaj
  const payrollSummary = useMemo(() => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const isSameMonth = (ts) => {
      const d = new Date(ts);
      return (
        d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      );
    };

    const map = {};
    for (const w of workers) {
      map[w.id] = {
        worker: w,
        advances: 0,
      };
    }

    for (const r of records) {
      if (r.type === 'ADVANCE' && r.workerId && isSameMonth(r.ts)) {
        if (!map[r.workerId]) continue;
        map[r.workerId].advances += Number(r.amount) || 0;
      }
    }

    const list = Object.values(map).map((entry) => {
      const salary = Number(entry.worker.salary) || 0;
      const advances = Number(entry.advances.toFixed(2));
      const remaining = Number((salary - advances).toFixed(2));
      return {
        id: entry.worker.id,
        name: entry.worker.name,
        salary,
        advances,
        remaining,
      };
    });

    return { ym, list };
  }, [workers, records]);

  const getWorkerRemaining = (workerId) => {
    const p = payrollSummary.list.find((x) => x.id === workerId);
    return p ? p.remaining : 0;
  };

  // ----------------- AUTH -----------------

  function handleLogin(e) {
    e.preventDefault();
    setLoginError('');
    const pin = (loginPin || '').trim();
    if (!pin) {
      setLoginError('Shkruaj PIN-in.');
      return;
    }
    const u = users.find((u) => String(u.pin) === pin);
    if (!u) {
      setLoginError('PIN i pasaktë.');
      return;
    }
    setCurrentUser(u);
    setLoginPin('');
  }

  function handleLogout() {
    setCurrentUser(null);
  }

  const isAdmin = currentUser && currentUser.role === 'ADMIN';

  // ----------------- ACTIONS -----------------

  function openDay() {
    if (!isAdmin) {
      alert('Vetëm ADMIN mund ta hapë ditën.');
      return;
    }
    const v = Number(openingAmount);
    if (Number.isNaN(v) || v < 0) {
      alert('Shkruaj një shumë të vlefshme për hapjen e ditës.');
      return;
    }
    if (todayDay) {
      alert('Dita është e hapur tashmë.');
      return;
    }
    const day = {
      dayKey: today,
      openingCash: v,
      openedBy: currentUser?.name || 'ADMIN',
      tsOpen: Date.now(),
      closed: false,
    };
    setDays((prev) => [...prev, day]);
    setOpeningAmount('');
  }

  function closeDay() {
    if (!isAdmin) {
      alert('Vetëm ADMIN mund ta mbyllë ditën.');
      return;
    }
    if (!todayDay) {
      alert('Së pari hape ditën.');
      return;
    }
    if (todayDay.closed) {
      alert('Dita është e mbyllur tashmë.');
      return;
    }

    const { closing } = todayTotals;
    const ok = confirm(
      `Do ta mbyllësh ditën me CASH NË ARKË: ${closing.toFixed(
        2,
      )} €.\nKjo shumë do t'i shtohet buxhetit të kompanisë.\nVazhdosh?`,
    );
    if (!ok) return;

    const newDay = {
      ...todayDay,
      closed: true,
      closingCash: closing,
      tsClose: Date.now(),
    };
    setDays((prev) => prev.map((d) => (d.dayKey === today ? newDay : d)));
    setCompanyBudget((prev) => Number((prev + closing).toFixed(2)));
  }

  function addExpense() {
    if (!todayDay) {
      alert('Së pari hape ditën në ARKË.');
      return;
    }
    const amt = Number(expenseAmount);
    if (Number.isNaN(amt) || amt <= 0) {
      alert('Shkruaj shumën e shpenzimit.');
      return;
    }
    const src = expenseSource;
    if (!['ARKA', 'BUXHET'].includes(src)) {
      alert('Zgjidh burimin (ARKA ose BUXHET).');
      return;
    }

    const rec = {
      id: generateId('exp'),
      type: 'EXPENSE',
      dayKey: today,
      amount: amt,
      direction: 'OUT',
      source: src,
      category: expenseCategory || '',
      note: expenseNote || '',
      byUser: currentUser?.name || '',
      ts: Date.now(),
    };

    setRecords((prev) => [rec, ...prev]);

    if (src === 'BUXHET') {
      setCompanyBudget((prev) => Number((prev - amt).toFixed(2)));
    }

    setExpenseAmount('');
    setExpenseCategory('');
    setExpenseNote('');
  }

  function addAdvance() {
    if (!todayDay) {
      alert('Së pari hape ditën në ARKË.');
      return;
    }
    const amt = Number(advanceAmount);
    if (Number.isNaN(amt) || amt <= 0) {
      alert('Shkruaj shumën e avansit.');
      return;
    }
    if (!advanceWorkerId) {
      alert('Zgjidh puntorin.');
      return;
    }
    const src = advanceSource;
    if (!['ARKA', 'BUXHET'].includes(src)) {
      alert('Zgjidh burimin (ARKA ose BUXHET).');
      return;
    }

    const rec = {
      id: generateId('adv'),
      type: 'ADVANCE',
      dayKey: today,
      amount: amt,
      direction: 'OUT',
      source: src,
      workerId: advanceWorkerId,
      note: advanceNote || '',
      byUser: currentUser?.name || '',
      ts: Date.now(),
    };

    setRecords((prev) => [rec, ...prev]);

    if (src === 'BUXHET') {
      setCompanyBudget((prev) => Number((prev - amt).toFixed(2)));
    }

    setAdvanceAmount('');
    setAdvanceWorkerId('');
    setAdvanceNote('');
  }

  function addTopup() {
    if (!todayDay) {
      alert('Së pari hape ditën në ARKË.');
      return;
    }
    const amt = Number(topupAmount);
    if (Number.isNaN(amt) || amt <= 0) {
      alert('Shkruaj shumën e top-up.');
      return;
    }
    const from = (topupFrom || '').trim();
    if (!from) {
      alert('Shkruaj kush i dha paratë (p.sh. Arben).');
      return;
    }

    const rec = {
      id: generateId('top'),
      type: 'TOPUP',
      dayKey: today,
      amount: amt,
      direction: 'IN',
      source: 'EXTERNAL',
      note: `${from}: ${topupNote || ''}`,
      byUser: currentUser?.name || '',
      ts: Date.now(),
    };

    setRecords((prev) => [rec, ...prev]);

    setTopupAmount('');
    setTopupFrom('');
    setTopupNote('');
  }

  function addWorker() {
    const name = (newWorkerName || '').trim();
    if (!name) {
      alert('Shkruaj emrin e puntorit.');
      return;
    }
    const sal = Number(newWorkerSalary);
    if (Number.isNaN(sal) || sal < 0) {
      alert('Shkruaj pagën mujore (mund edhe 0).');
      return;
    }
    const w = {
      id: generateId('w'),
      name,
      salary: sal,
    };
    setWorkers((prev) => [...prev, w]);
    setNewWorkerName('');
    setNewWorkerSalary('');
  }

  function updateBudget() {
    const v = Number(budgetInput);
    if (Number.isNaN(v) || v < 0) {
      alert('Shkruaj buxhet valid.');
      return;
    }
    setCompanyBudget(v);
  }

  // *** BUTONI I RI PAGUAJ ***
  function handleUnifiedPay() {
    if (!todayDay) {
      alert('Së pari hape ditën në ARKË.');
      return;
    }

    if (payMode === 'WORKER') {
      if (!payWorkerId) {
        alert('Zgjedh puntorin që po e paguan.');
        return;
      }
      const remaining = getWorkerRemaining(payWorkerId);
      let amt = payWorkerAmount ? Number(payWorkerAmount) : remaining;
      if (Number.isNaN(amt) || amt <= 0) {
        alert('Shkruaj shumën për pagesën e puntorit.');
        return;
      }
      const src = payWorkerSource;
      if (!['ARKA', 'BUXHET'].includes(src)) {
        alert('Zgjidh burimin (ARKA ose BUXHET).');
        return;
      }

      const rec = {
        id: generateId('adv'),
        type: 'ADVANCE',
        dayKey: today,
        amount: amt,
        direction: 'OUT',
        source: src,
        workerId: payWorkerId,
        note: payWorkerNote || 'Pagesë paga / borxh puntori',
        byUser: currentUser?.name || '',
        ts: Date.now(),
      };

      setRecords((prev) => [rec, ...prev]);
      if (src === 'BUXHET') {
        setCompanyBudget((prev) => Number((prev - amt).toFixed(2)));
      }

      setPayWorkerAmount('');
      setPayWorkerNote('');

      alert('Pagesa e puntorit u regjistrua.');
      return;
    }

    // MODE EXPENSE / BORXH
    const amt = Number(payExpAmount);
    if (Number.isNaN(amt) || amt <= 0) {
      alert('Shkruaj shumën e pagesës.');
      return;
    }
    const src = payExpSource;
    if (!['ARKA', 'BUXHET', 'EXTERNAL'].includes(src)) {
      alert('Zgjidh burimin.');
      return;
    }

    let note = payExpNote || '';
    const cat = payExpCategory || '';

    if (src === 'EXTERNAL') {
      const from = (payExpFrom || '').trim();
      if (!from) {
        alert('Shkruaj kush e pagoi shpenzimin (dikush tjetër).');
        return;
      }
      note = `Borxh ndaj ${from}. ${note}`;
    }

    const rec = {
      id: generateId('exp'),
      type: 'EXPENSE',
      dayKey: today,
      amount: amt,
      direction: 'OUT',
      source: src === 'EXTERNAL' ? 'EXTERNAL' : src,
      category: cat,
      note,
      byUser: currentUser?.name || '',
      ts: Date.now(),
    };

    setRecords((prev) => [rec, ...prev]);

    if (src === 'BUXHET') {
      setCompanyBudget((prev) => Number((prev - amt).toFixed(2)));
    }
    // ARKA ndryshon vetëm arken e dites (totali), EXTERNAL vetëm regjistron borxh

    setPayExpAmount('');
    setPayExpCategory('');
    setPayExpFrom('');
    setPayExpNote('');

    alert('Pagesa / borxhi u regjistrua.');
  }

  // ----------------- RESET -----------------

  function handleReset() {
    if (!isAdmin) {
      alert('Vetëm ADMIN mund ta bëjë reset.');
      return;
    }
    const pin = prompt('Shkruaj PIN-in ADMIN për RESET:');
    if (!pin || !currentUser || String(currentUser.pin) !== String(pin)) {
      alert('PIN i pasaktë. RESET u anullua.');
      return;
    }

    const choice = prompt(
      'Zgjedh çka don me resetu:\n' +
        '1 = FACTORY RESET (krejt sistemi)\n' +
        '2 = VETËM ARKA (pagesa, shpenzime, avansa, ditë)\n' +
        '3 = VETËM DITËN E SOTME\n' +
        '4 = VETËM LOGIN & PREFERENCA',
    );
    if (!choice) return;

    if (choice === '1') {
      const ok = confirm(
        'FACTORY RESET: do të fshihen të gjitha porositë, ARKA, buxhet, puntorë, etj.\nJe i sigurt?',
      );
      if (!ok) return;

      if (typeof window !== 'undefined') {
        localStorage.clear();
      }
      setRecords([]);
      setDays([]);
      setCompanyBudget(0);
      setWorkers([]);
      setCurrentUser(null);
      const u = ensureDefaultUsers();
      setUsers(u);
      saveArkaStateOnline({
        users: u,
        records: [],
        days: [],
        companyBudget: 0,
        workers: [],
      });
      alert('FACTORY RESET u krye. Sistemi u kthye në zero.');
      return;
    }

    if (choice === '2') {
      const ok = confirm(
        'RESET ARKA: do të fshihen pagesat, shpenzimet, avanset dhe ditët në ARKA.\nPorositë nuk preken.\nJe i sigurt?',
      );
      if (!ok) return;

      setRecords([]);
      setDays([]);
      saveState(LS_RECORDS, []);
      saveState(LS_DAYS, []);
      saveArkaStateOnline({
        users,
        records: [],
        days: [],
        companyBudget,
        workers,
      });
      alert('ARKA u resetua. Porositë mbetën të paprekura.');
      return;
    }

    if (choice === '3') {
      if (!todayDay) {
        alert('Nuk ka ditë të hapur për sot.');
        return;
      }
      const ok = confirm(
        'RESET VETËM DITËN E SOTME: do të fshihen hyrje/daljet e ditës së sotme.\nJe i sigurt?',
      );
      if (!ok) return;

      const newRecords = records.filter((r) => r.dayKey !== today);
      const newDays = days.filter((d) => d.dayKey !== today);
      setRecords(newRecords);
      setDays(newDays);
      saveArkaStateOnline({
        users,
        records: newRecords,
        days: newDays,
        companyBudget,
        workers,
      });
      alert('Dita e sotme në ARKA u fshi.');
      return;
    }

    if (choice === '4') {
      const ok = confirm(
        'RESET LOGIN & PREFERENCA: do të fshihen user-i aktual dhe disa preferenca, por ARKA dhe porositë nuk preken.\nJe i sigurt?',
      );
      if (!ok) return;

      setCurrentUser(null);
      saveState(LS_CURRENT_USER, null);
      alert('Login u resetua. Duhet të hysh përsëri me PIN.');
      return;
    }

    alert('Opsion i panjohur. RESET u anullua.');
  }

  // ----------------- RENDER -----------------

  if (loading) {
    return (
      <div className="wrap">
        <header className="header-row">
          <h1 className="title">ARKA</h1>
        </header>
        <p>Duke i lexuar të dhënat...</p>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="wrap" style={{ maxWidth: 420, margin: '0 auto' }}>
        <header className="header-row">
          <h1 className="title">ARKA</h1>
          <div className="subtitle">HYRJE ME PIN</div>
        </header>
        <section className="card">
          <h2 className="card-title">Vendos PIN</h2>
          <form onSubmit={handleLogin}>
            <div className="field-group">
              <label className="label">PIN</label>
              <input
                className="input"
                type="password"
                value={loginPin}
                onChange={(e) => setLoginPin(e.target.value)}
                placeholder="p.sh. 1234"
              />
            </div>
            {loginError && (
              <p style={{ color: '#f97373', fontSize: 12, marginTop: 4 }}>{loginError}</p>
            )}
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button type="submit" className="btn primary">
                HYR NË ARKË
              </button>
            </div>
          </form>
          <p style={{ fontSize: 11, opacity: 0.7, marginTop: 12 }}>
            DEFAULT: ADMIN PIN <strong>1234</strong> • PUNTOR PIN <strong>1111</strong>
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

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">
            {currentUser.name} ({currentUser.role})
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            BUXHET KOMPANIE:{' '}
            <strong>{Number(companyBudget || 0).toFixed(2)} €</strong>
          </div>
          {todayDay ? (
            <div>
              HAPUR SOT:{' '}
              <strong>{Number(todayDay.openingCash || 0).toFixed(2)} €</strong>
            </div>
          ) : (
            <div style={{ opacity: 0.8 }}>Dita e sotme nuk është hapur ende.</div>
          )}
          <div style={{ marginTop: 4, fontSize: 11 }}>
            SOT ARKA: hyrje{' '}
            <strong>{todayTotals.in.toFixed(2)} €</strong> · dalje{' '}
            <strong>{todayTotals.out.toFixed(2)} €</strong> · neto{' '}
            <strong>{todayTotals.net.toFixed(2)} €</strong> · mbyllje{' '}
            <strong>{todayTotals.closing.toFixed(2)} €</strong>
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
            {isAdmin && (
              <button
                type="button"
                className="btn secondary"
                style={{ padding: '4px 8px', fontSize: 10 }}
                onClick={handleReset}
              >
                RESET
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

      {/* DITA E SOTME */}
      <section className="card">
        <h2 className="card-title">DITA E SOTME ({today})</h2>
        {!todayDay && isAdmin && (
          <div>
            <p style={{ fontSize: 12, opacity: 0.8 }}>
              Hape ditën duke vendosur sa cash ke në arkë në mëngjes.
            </p>
            <div className="row">
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                value={openingAmount}
                onChange={(e) => setOpeningAmount(e.target.value)}
                placeholder="p.sh. 100 €"
              />
              <button type="button" className="btn primary" onClick={openDay}>
                HAP DITËN
              </button>
            </div>
          </div>
        )}

        {todayDay && (
          <div>
            <p style={{ fontSize: 12, opacity: 0.8 }}>
              Dita është hapur nga {todayDay.openedBy} në{' '}
              {new Date(todayDay.tsOpen).toLocaleTimeString('sq-AL', {
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </p>
            <div className="row" style={{ marginTop: 4, gap: 8, flexWrap: 'wrap' }}>
              <div className="tot-line small">
                CASH START: <strong>{todayDay.openingCash.toFixed(2)} €</strong>
              </div>
              <div className="tot-line small">
                NETO SOT (ARKA): <strong>{todayTotals.net.toFixed(2)} €</strong>
              </div>
              <div className="tot-line small">
                CASH NË FUND DITE:{' '}
                <strong>{todayTotals.closing.toFixed(2)} €</strong>
              </div>
            </div>
            {isAdmin && !todayDay.closed && (
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button type="button" className="btn secondary" onClick={closeDay}>
                  MBYLLE DITËN & TRANSFERO NË BUXHET
                </button>
              </div>
            )}
            {todayDay.closed && (
              <p style={{ marginTop: 8, fontSize: 12, color: '#22c55e' }}>
                Dita është mbyllur. CASH i ditës u shtua në buxhetin e kompanisë.
              </p>
            )}
          </div>
        )}
      </section>

      {/* SHPENZIME & AVANSA */}
      {todayDay && (
        <section className="card">
          <h2 className="card-title">SHPENZIME & AVANSA</h2>

          {/* PANELI I RI: PAGUAJ */}
          <div className="field-group" style={{ marginBottom: 12 }}>
            <label className="label">PAGUAJ (puntor ose shpenzim)</label>
            <div className="chip-row" style={{ marginBottom: 6 }}>
              <button
                type="button"
                className={`chip ${payMode === 'WORKER' ? 'chip-active' : ''}`}
                onClick={() => setPayMode('WORKER')}
              >
                PUNTOR
              </button>
              <button
                type="button"
                className={`chip ${payMode === 'EXPENSE' ? 'chip-active' : ''}`}
                onClick={() => setPayMode('EXPENSE')}
              >
                SHPENZIM / BORXH
              </button>
            </div>

            {payMode === 'WORKER' && (
              <>
                <div className="row">
                  <select
                    className="input small"
                    value={payWorkerId}
                    onChange={(e) => setPayWorkerId(e.target.value)}
                  >
                    <option value="">Zgjedh puntorin</option>
                    {workers.map((w) => {
                      const rem = getWorkerRemaining(w.id);
                      return (
                        <option key={w.id} value={w.id}>
                          {w.name} — mbetet {rem.toFixed(2)} €
                        </option>
                      );
                    })}
                  </select>
                  <select
                    className="input small"
                    value={payWorkerSource}
                    onChange={(e) => setPayWorkerSource(e.target.value)}
                  >
                    <option value="ARKA">Nga ARKA</option>
                    <option value="BUXHET">Nga BUXHETI</option>
                  </select>
                </div>
                <div className="row" style={{ marginTop: 4 }}>
                  <input
                    className="input small"
                    type="number"
                    min="0"
                    step="0.1"
                    value={payWorkerAmount}
                    onChange={(e) => setPayWorkerAmount(e.target.value)}
                    placeholder="Shuma € (nëse e le bosh = mbetja)"
                  />
                  <input
                    className="input small"
                    type="text"
                    value={payWorkerNote}
                    onChange={(e) => setPayWorkerNote(e.target.value)}
                    placeholder="Shënim (p.sh. paga mujore)"
                  />
                </div>
              </>
            )}

            {payMode === 'EXPENSE' && (
              <>
                <div className="row">
                  <input
                    className="input small"
                    type="number"
                    min="0"
                    step="0.1"
                    value={payExpAmount}
                    onChange={(e) => setPayExpAmount(e.target.value)}
                    placeholder="Shuma €"
                  />
                  <select
                    className="input small"
                    value={payExpSource}
                    onChange={(e) => setPayExpSource(e.target.value)}
                  >
                    <option value="ARKA">Paguan ARKA</option>
                    <option value="BUXHET">Paguan BUXHETI</option>
                    <option value="EXTERNAL">Paguan dikush tjetër (borxh)</option>
                  </select>
                </div>
                <div className="row" style={{ marginTop: 4 }}>
                  <input
                    className="input small"
                    type="text"
                    value={payExpCategory}
                    onChange={(e) => setPayExpCategory(e.target.value)}
                    placeholder="Kategoria (rrymë, shampo...)"
                  />
                  {payExpSource === 'EXTERNAL' && (
                    <input
                      className="input small"
                      type="text"
                      value={payExpFrom}
                      onChange={(e) => setPayExpFrom(e.target.value)}
                      placeholder="Kush pagoi (p.sh. Arben)"
                    />
                  )}
                </div>
                <input
                  className="input"
                  style={{ marginTop: 4 }}
                  type="text"
                  value={payExpNote}
                  onChange={(e) => setPayExpNote(e.target.value)}
                  placeholder="Shënim opsional (p.sh. borxh për 1 muaj)"
                />
              </>
            )}

            <div className="btn-row" style={{ marginTop: 6 }}>
              <button type="button" className="btn primary" onClick={handleUnifiedPay}>
                💸 EKSEKUTO PAGUAN
              </button>
            </div>
          </div>

          {/* EXPENSE */}
          <div className="field-group">
            <label className="label">Shpenzim i ri</label>
            <div className="row">
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                value={expenseAmount}
                onChange={(e) => setExpenseAmount(e.target.value)}
                placeholder="Shuma €"
              />
              <select
                className="input small"
                value={expenseSource}
                onChange={(e) => setExpenseSource(e.target.value)}
              >
                <option value="ARKA">Nga ARKA</option>
                <option value="BUXHET">Nga BUXHETI</option>
              </select>
            </div>
            <div className="row" style={{ marginTop: 4 }}>
              <input
                className="input small"
                type="text"
                value={expenseCategory}
                onChange={(e) => setExpenseCategory(e.target.value)}
                placeholder="Kategoria (p.sh. naftë, qira...)"
              />
              <input
                className="input small"
                type="text"
                value={expenseNote}
                onChange={(e) => setExpenseNote(e.target.value)}
                placeholder="Shënim opsional"
              />
            </div>
            <div className="btn-row" style={{ marginTop: 4 }}>
              <button type="button" className="btn secondary" onClick={addExpense}>
                SHTO SHPENZIM
              </button>
            </div>
          </div>

          {/* ADVANCE */}
          <div className="field-group" style={{ marginTop: 12 }}>
            <label className="label">Avans për puntor</label>
            <div className="row">
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                value={advanceAmount}
                onChange={(e) => setAdvanceAmount(e.target.value)}
                placeholder="Shuma €"
              />
              <select
                className="input small"
                value={advanceSource}
                onChange={(e) => setAdvanceSource(e.target.value)}
              >
                <option value="ARKA">Nga ARKA</option>
                <option value="BUXHET">Nga BUXHETI</option>
              </select>
            </div>
            <div className="row" style={{ marginTop: 4 }}>
              <select
                className="input small"
                value={advanceWorkerId}
                onChange={(e) => setAdvanceWorkerId(e.target.value)}
              >
                <option value="">Zgjedh puntorin</option>
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <input
                className="input small"
                type="text"
                value={advanceNote}
                onChange={(e) => setAdvanceNote(e.target.value)}
                placeholder="Shënim (p.sh. kafe, buke...)"
              />
            </div>
            <div className="btn-row" style={{ marginTop: 4 }}>
              <button type="button" className="btn secondary" onClick={addAdvance}>
                SHTO AVANS
              </button>
            </div>
          </div>

          {/* TOPUP */}
          <div className="field-group" style={{ marginTop: 12 }}>
            <label className="label">Top-up për kompani (dikush i jep para)</label>
            <div className="row">
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                value={topupAmount}
                onChange={(e) => setTopupAmount(e.target.value)}
                placeholder="Shuma €"
              />
              <input
                className="input small"
                type="text"
                value={topupFrom}
                onChange={(e) => setTopupFrom(e.target.value)}
                placeholder="Kush i dha? (p.sh. Arben)"
              />
            </div>
            <input
              className="input"
              style={{ marginTop: 4 }}
              type="text"
              value={topupNote}
              onChange={(e) => setTopupNote(e.target.value)}
              placeholder="Shënim opsional (p.sh. hua për 1 muaj)"
            />
            <div className="btn-row" style={{ marginTop: 4 }}>
              <button type="button" className="btn secondary" onClick={addTopup}>
                SHTO TOP-UP
              </button>
            </div>
          </div>
        </section>
      )}

      {/* LISTA E REGJISTRIMEVE TË DITËS */}
      <section className="card">
        <h2 className="card-title">Lëvizjet e ditës</h2>
        {todaysRecords.length === 0 && (
          <p style={{ fontSize: 12, opacity: 0.8 }}>Nuk ka ende lëvizje për sot.</p>
        )}
        {todaysRecords.map((r) => (
          <div key={r.id} className="home-btn" style={{ marginBottom: 6 }}>
            <div className="home-btn-main">
              <div>
                <div style={{ fontWeight: 700, fontSize: 12 }}>
                  {RECORD_TYPES[r.type] || r.type}{' '}
                  <span style={{ fontSize: 10, opacity: 0.7 }}>
                    • {SOURCES[r.source] || r.source}
                  </span>
                </div>
                <div style={{ fontSize: 11, opacity: 0.85 }}>
                  {r.type === 'ADVANCE' && r.workerId && (
                    <>
                      Puntor:{' '}
                      {workers.find((w) => w.id === r.workerId)?.name || '??'} •{' '}
                    </>
                  )}
                  {r.orderCode && (
                    <>
                      Kodi: {r.orderCode}{' '}
                      {r.orderName ? `(${r.orderName})` : ''} •{' '}
                    </>
                  )}
                  {r.category && <>[{r.category}] • </>}
                  {r.note}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 12 }}>
                <div
                  style={{
                    fontWeight: 700,
                    color: r.direction === 'IN' ? '#22c55e' : '#f97373',
                  }}
                >
                  {r.direction === 'IN' ? '+' : '-'}
                  {Number(r.amount || 0).toFixed(2)} €
                </div>
                <div style={{ fontSize: 11, opacity: 0.8 }}>
                  {new Date(r.ts).toLocaleTimeString('sq-AL', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* ADMIN PANEL: BUXHET & PUNTORËT */}
      {isAdmin && (
        <section className="card">
          <h2 className="card-title">BUXHET & PUNTORË (ADMIN)</h2>

          {/* BUXHET */}
          <div className="field-group">
            <label className="label">Buxheti total i kompanisë</label>
            <div className="row">
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
              />
              <button type="button" className="btn secondary" onClick={updateBudget}>
                RUAJ BUXHETIN
              </button>
            </div>
          </div>

          {/* PUNTORËT */}
          <div className="field-group" style={{ marginTop: 12 }}>
            <label className="label">Shto puntor</label>
            <div className="row">
              <input
                className="input small"
                type="text"
                value={newWorkerName}
                onChange={(e) => setNewWorkerName(e.target.value)}
                placeholder="Emri"
              />
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                value={newWorkerSalary}
                onChange={(e) => setNewWorkerSalary(e.target.value)}
                placeholder="Paga mujore €"
              />
            </div>
            <div className="btn-row" style={{ marginTop: 4 }}>
              <button type="button" className="btn secondary" onClick={addWorker}>
                SHTO PUNTOR
              </button>
            </div>
          </div>

          {workers.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="tot-line small">
                PAYROLL ({payrollSummary.ym})
              </div>
              {payrollSummary.list.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    padding: '4px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  <div>
                    <strong>{p.name}</strong>
                    <div style={{ opacity: 0.8 }}>
                      Paga: {p.salary.toFixed(2)} € • Avanse:{' '}
                      {p.advances.toFixed(2)} €
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div>MBETET:</div>
                    <strong
                      style={{ color: p.remaining < 0 ? '#f97373' : '#22c55e' }}
                    >
                      {p.remaining.toFixed(2)} €
                    </strong>
                  </div>
                </div>
              ))}
            </div>
          )}
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