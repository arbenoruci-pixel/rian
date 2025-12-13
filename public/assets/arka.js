/* =================================================================
   ARKA ENGINE (SAFE for Next.js SSR)
   Runs ONLY in browser (guards window/localStorage)
   ================================================================= */

(function () {
  if (typeof window === 'undefined') return;
  if (typeof localStorage === 'undefined') return;

  const LS_KEYS = {
    USERS: 'ARKA_USERS',
    STATE: 'ARKA_STATE',
    MOVES: 'ARKA_MOVES',
    RECORDS: 'ARKA_RECORDS',
    CURRENT_USER: 'CURRENT_USER_DATA'
  };

  const MASTER_PIN = '4563';
  const MASTER_PIN_HASH = '1e37bd2a0753';
  const ROLES = ['ADMIN', 'PUNTOR', 'TRANSPORT', 'DISPATCH'];

  function hashPin(pin) {
    if (pin === MASTER_PIN) return MASTER_PIN_HASH;
    return `hash_${pin}`;
  }

  function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  function getData(key) {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return safeJsonParse(raw, null);
  }

  function setData(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
  }

  function ensureArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function formatEuro(cent) {
    const n = Number(cent || 0);
    return (n / 100).toFixed(2) + '€';
  }

  function getCurrentUser() {
    return safeJsonParse(localStorage.getItem(LS_KEYS.CURRENT_USER) || '{}', {});
  }

  function getFinancialState() {
    const state = getData(LS_KEYS.STATE);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { COMPANY_BUDGET: 0, DAILY_CASH: 0, CASH_START_TODAY: 0, currentDayOpened: null };
    }
    return {
      COMPANY_BUDGET: Number(state.COMPANY_BUDGET || 0),
      DAILY_CASH: Number(state.DAILY_CASH || 0),
      CASH_START_TODAY: Number(state.CASH_START_TODAY || 0),
      currentDayOpened: state.currentDayOpened || null
    };
  }

  function initializeSystem() {
    let users = ensureArray(getData(LS_KEYS.USERS));
    if (users.length === 0) {
      users = [{
        id: 'u1',
        name: 'Admini Kryesor',
        role: 'ADMIN',
        hashedPin: MASTER_PIN_HASH
      }];
      setData(LS_KEYS.USERS, users);

      setData(LS_KEYS.STATE, {
        COMPANY_BUDGET: 0,
        DAILY_CASH: 0,
        CASH_START_TODAY: 0,
        currentDayOpened: null
      });

      console.log('✅ ARKA init OK (ADMIN PIN 4563).');
    } else {
      const st = getData(LS_KEYS.STATE);
      if (!st || typeof st !== 'object' || Array.isArray(st)) {
        setData(LS_KEYS.STATE, {
          COMPANY_BUDGET: 0,
          DAILY_CASH: 0,
          CASH_START_TODAY: 0,
          currentDayOpened: null
        });
      }
    }
  }
  initializeSystem();

  function handleLogin(pin) {
    const hashedPin = hashPin(String(pin || '').trim());
    const users = ensureArray(getData(LS_KEYS.USERS));
    const user = users.find(u => u && u.hashedPin === hashedPin);

    if (user) {
      setData(LS_KEYS.CURRENT_USER, { name: user.name, role: user.role, id: user.id });
      return { success: true, role: user.role, user: { name: user.name, role: user.role, id: user.id } };
    }
    return { success: false, message: 'PIN i gabuar!' };
  }

  function manageUsers(action, data) {
    const cur = getCurrentUser();
    if (cur.role !== 'ADMIN') return { success: false, message: 'Nuk jeni ADMIN!' };

    let users = ensureArray(getData(LS_KEYS.USERS));

    if (action === 'ADD') {
      const name = String(data?.name || '').trim();
      const pin = String(data?.pin || '').trim();
      const role = String(data?.role || '').trim().toUpperCase();

      if (!name) return { success: false, message: 'Emri mungon.' };
      if (!pin) return { success: false, message: 'PIN mungon.' };
      if (!ROLES.includes(role)) return { success: false, message: 'Roli i pavlefshëm.' };

      const newUser = { id: `u${Date.now()}`, name, role, hashedPin: hashPin(pin) };
      users.push(newUser);
      setData(LS_KEYS.USERS, users);
      return { success: true, users };
    }

    if (action === 'DELETE') {
      const id = String(data?.id || '');
      if (!id) return { success: false, message: 'ID mungon.' };
      if (id === cur.id) return { success: false, message: 'S’mundesh me fshi veten.' };

      users = users.filter(u => u && u.id !== id);
      setData(LS_KEYS.USERS, users);
      return { success: true, users };
    }

    return { success: false, message: 'Action e panjohur.' };
  }

  function recordMove(type, amountCent, source, who, note, durationType = null, installmentAmountCent = null) {
    const user = getCurrentUser();
    if (!user?.name) return { success: false, message: 'Duhet login.' };

    type = String(type || '').toLowerCase();
    source = String(source || '').toLowerCase();

    const amt = Number(amountCent || 0);
    if (!(amt > 0)) return { success: false, message: 'Shuma jo valide.' };

    const state = getFinancialState();

    if (type === 'topup' && user.role !== 'ADMIN') {
      return { success: false, message: 'Vetëm ADMIN mund TOP-UP.' };
    }

    if (type === 'expense' || type === 'advance') {
      if (source === 'arka') {
        if (state.DAILY_CASH < amt) return { success: false, message: 'Nuk ka cash në arkë.' };
        state.DAILY_CASH -= amt;
      } else if (source === 'budget') {
        state.COMPANY_BUDGET -= amt;
      } else {
        return { success: false, message: 'Burimi jo valid.' };
      }
    } else if (type === 'topup' || type === 'repayment') {
      state.COMPANY_BUDGET += amt;
    } else {
      return { success: false, message: 'Tipi jo valid.' };
    }

    const moves = ensureArray(getData(LS_KEYS.MOVES));
    const newMove = {
      id: `m${Date.now()}`,
      ts: Date.now(),
      type,
      source,
      amount: amt,
      who: who || '',
      note: note || '',
      byUserName: user.name,
      byUserRole: user.role,
      durationType,
      installmentAmount: installmentAmountCent
    };
    moves.push(newMove);

    setData(LS_KEYS.MOVES, moves);
    setData(LS_KEYS.STATE, state);

    return { success: true, move: newMove, state };
  }

  function recordClientPayment(amountCent, orderDetails) {
    const user = getCurrentUser();
    if (!user?.name) return { success: false, message: 'Duhet login.' };

    const amt = Number(amountCent || 0);
    if (!(amt > 0)) return { success: false, message: 'Shuma jo valide.' };

    const state = getFinancialState();
    state.DAILY_CASH += amt;
    setData(LS_KEYS.STATE, state);

    const records = ensureArray(getData(LS_KEYS.RECORDS));
    const newRecord = {
      id: `r${Date.now()}`,
      ts: Date.now(),
      paid: amt,
      byUserName: user.name,
      byUserRole: user.role,
      ...(orderDetails || {})
    };
    records.push(newRecord);
    setData(LS_KEYS.RECORDS, records);

    return { success: true, record: newRecord, state };
  }

  function initializeDay(startCashCent) {
    const state = getFinancialState();
    const today = new Date().toISOString().split('T')[0];

    if (state.currentDayOpened === today) return { success: false, message: 'Dita e hapur.' };

    const start = Number(startCashCent || 0);
    state.DAILY_CASH = start;
    state.CASH_START_TODAY = start;
    state.currentDayOpened = today;
    setData(LS_KEYS.STATE, state);

    return { success: true, state };
  }

  function closeDay() {
    const state = getFinancialState();
    if (!state.currentDayOpened) return { success: false, message: 'Dita s’është hapur.' };

    const dailyProfit = Number(state.DAILY_CASH || 0) - Number(state.CASH_START_TODAY || 0);
    state.COMPANY_BUDGET += dailyProfit;
    state.currentDayOpened = null;
    setData(LS_KEYS.STATE, state);

    return { success: true, dailyProfit, state };
  }

  function resetSystem(adminPin) {
    const user = getCurrentUser();
    if (user.role !== 'ADMIN') return { success: false, message: 'Vetëm ADMIN.' };

    const users = ensureArray(getData(LS_KEYS.USERS));
    const actualAdmin = users.find(u => u && u.id === user.id);
    if (!actualAdmin) return { success: false, message: 'Admin missing.' };

    if (hashPin(String(adminPin || '').trim()) !== actualAdmin.hashedPin) {
      return { success: false, message: 'PIN gabim.' };
    }

    localStorage.removeItem(LS_KEYS.MOVES);
    localStorage.removeItem(LS_KEYS.RECORDS);

    setData(LS_KEYS.STATE, {
      COMPANY_BUDGET: 0,
      DAILY_CASH: 0,
      CASH_START_TODAY: 0,
      currentDayOpened: null
    });

    return { success: true };
  }

  function generateReport(days) {
    const d = Number(days || 0);
    const endTime = Date.now();
    const startTime = endTime - (d * 24 * 60 * 60 * 1000);

    const moves = ensureArray(getData(LS_KEYS.MOVES)).filter(m => m && m.ts >= startTime);
    const records = ensureArray(getData(LS_KEYS.RECORDS)).filter(r => r && r.ts >= startTime);

    let totalIncomeClients = 0;
    let totalIncomeTopup = 0;
    let totalExpense = 0;
    let totalAdvance = 0;

    records.forEach(r => totalIncomeClients += Number(r.paid || 0));
    moves.forEach(m => {
      if (m.type === 'expense') totalExpense += Number(m.amount || 0);
      if (m.type === 'advance') totalAdvance += Number(m.amount || 0);
      if (m.type === 'topup') totalIncomeTopup += Number(m.amount || 0);
    });

    const totalIncome = totalIncomeClients + totalIncomeTopup;
    const totalOutgoing = totalExpense + totalAdvance;
    const netProfit = totalIncome - totalOutgoing;

    return { totalIncome, totalOutgoing, netProfit };
  }

  function generateAdvanceReport() {
    const moves = ensureArray(getData(LS_KEYS.MOVES));
    const advancesMap = {};

    moves.forEach(m => {
      if (!m) return;
      if (m.type === 'advance' || m.type === 'repayment') {
        const key = String(m.who || '').trim() || 'PA_EMER';
        if (!advancesMap[key]) advancesMap[key] = { given: 0, repaid: 0 };
        if (m.type === 'advance') advancesMap[key].given += Number(m.amount || 0);
        if (m.type === 'repayment') advancesMap[key].repaid += Number(m.amount || 0);
      }
    });

    return advancesMap;
  }

  window.TepihaArka = {
    ROLES,
    formatEuro,
    getCurrentUser,

    handleLogin,
    loginWithPin: handleLogin,
    manageUsers,
    listUsers: () => ensureArray(getData(LS_KEYS.USERS)),

    getFinancialState: () => getFinancialState(),
    recordMove,
    recordClientPayment,
    initializeDay,
    closeDay,
    resetSystem,
    generateReport,
    generateAdvanceReport
  };
})();
