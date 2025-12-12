 =================================================================
// MODULI ARKA (Kodi i Plotë i Integruar)
// Version i sigurt për Next.js (me guard për window & export në window.TepihaArka)
// =================================================================

(function () {
  // 🚫 MOS ekzekuto në server (Next.js SSR / build)
  if (typeof window === "undefined") return;

  // -----------------------------------------------------
  // 1. KONFIGURIMI & FUNKSIONET NDIHMËSË (HELPERS)
  // -----------------------------------------------------

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

  function getData(key) {
    const data = localStorage.getItem(key);
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : (data ? parsed : []);
    } catch (e) {
      return data || [];
    }
  }

  function setData(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
  }

  function formatEuro(cent) {
    return (cent / 100).toFixed(2) + '€';
  }

  function getCurrentUser() {
    return JSON.parse(localStorage.getItem(LS_KEYS.CURRENT_USER) || '{}');
  }

  function initializeSystem() {
    let users = getData(LS_KEYS.USERS);
    if (!Array.isArray(users) || users.length === 0) {
      users = [{
        id: 'u1',
        name: 'Admini Kryesor',
        role: 'ADMIN',
        hashedPin: MASTER_PIN_HASH
      }];
      setData(LS_KEYS.USERS, users);

      const initialState = {
        COMPANY_BUDGET: 0,
        DAILY_CASH: 0,
        CASH_START_TODAY: 0,
        currentDayOpened: null
      };
      setData(LS_KEYS.STATE, initialState);
      console.log('✅ Sistemi u inicializua me ADMIN-in (PIN: 4563).');
    }
  }
  initializeSystem();

  // -----------------------------------------------------
  // 2. LOGJIKA E HYRJES DHE MENAXHIMI I PËRDORUESVE
  // -----------------------------------------------------

  function handleLogin(pin) {
    const hashedPin = hashPin(pin);
    const users = getData(LS_KEYS.USERS);

    const user = users.find(u => u.hashedPin === hashedPin);

    if (user) {
      setData(LS_KEYS.CURRENT_USER, { name: user.name, role: user.role, id: user.id });
      console.log(`✨ Mirësevjen, ${user.name} (${user.role})!`);
      return { success: true, role: user.role };
    } else {
      console.error('❌ PIN i gabuar!');
      return { success: false, message: 'PIN i gabuar!' };
    }
  }

  function manageUsers(action, data) {
    if (getCurrentUser().role !== 'ADMIN') {
      return { success: false, message: 'Nuk jeni ADMIN!' };
    }

    let users = getData(LS_KEYS.USERS);

    if (action === 'ADD') {
      const newUser = {
        id: `u${Date.now()}`,
        name: data.name,
        role: data.role,
        hashedPin: hashPin(data.pin)
      };
      users.push(newUser);
      console.log(`✅ Përdoruesi ${data.name} u shtua.`);

    } else if (action === 'DELETE' && data.id !== getCurrentUser().id) {
      users = users.filter(u => u.id !== data.id);
      console.log(`✅ Përdoruesi u fshi.`);
    }
    setData(LS_KEYS.USERS, users);
    return { success: true, users };
  }

  // -----------------------------------------------------
  // 3. LOGJIKA E BUXHETIT DHE LËVIZJEVE (MOVES)
  // -----------------------------------------------------

  function getFinancialState() {
    const state = getData(LS_KEYS.STATE);
    console.log(`\n--- GJENDJA FINANCIARE AKTUALE ---`);
    console.log(`💰 BUXHETI KOMPANISË (Total): ${formatEuro(state.COMPANY_BUDGET)}`);
    console.log(`💵 CASH DITOR (Arka): ${formatEuro(state.DAILY_CASH)} (Fillimi: ${formatEuro(state.CASH_START_TODAY)})`);
    console.log('-----------------------------------');
    return state;
  }

  function recordMove(type, amountCent, source, who, note, durationType = null, installmentAmountCent = null) {
    const user = getCurrentUser();
    if (!user.name) return { success: false, message: 'Duhet të jeni i kyçur.' };

    const state = getData(LS_KEYS.STATE);

    if (type === 'topup' && user.role !== 'ADMIN') {
      console.error('❌ Vetëm ADMIN mund të regjistrojë TOP-UP.');
      return { success: false };
    }

    // KONTROLLI I FONDEVE & LLOGARITJA
    if (type === 'expense' || type === 'advance') {
      if (source === 'arka') {
        if (state.DAILY_CASH < amountCent) {
          console.error('❌ Nuk ka KESH në arkë.');
          return { success: false };
        }
        state.DAILY_CASH -= amountCent;
      } else if (source === 'budget') {
        state.COMPANY_BUDGET -= amountCent;
      }
    } else if (type === 'topup') {
      state.COMPANY_BUDGET += amountCent;
    } else if (type === 'repayment') {
      state.COMPANY_BUDGET += amountCent;
    }

    // REGJISTRIMI I LËVIZJES
    const moves = getData(LS_KEYS.MOVES);
    const newMove = {
      id: `m${Date.now()}`,
      ts: Date.now(),
      type,
      source,
      amount: amountCent,
      who,
      note,
      byUserName: user.name,
      byUserRole: user.role,
      durationType,
      installmentAmount: installmentAmountCent
    };
    moves.push(newMove);
    setData(LS_KEYS.MOVES, moves);
    setData(LS_KEYS.STATE, state);

    console.log(`✅ Lëvizje e re (${type}) prej ${formatEuro(amountCent)} u regjistrua.`);
    return { success: true, move: newMove };
  }

  function recordClientPayment(amountCent, orderDetails) {
    const user = getCurrentUser();
    if (!user.name) return { success: false, message: 'Duhet të jeni i kyçur.' };

    const state = getData(LS_KEYS.STATE);
    state.DAILY_CASH += amountCent;
    setData(LS_KEYS.STATE, state);

    const records = getData(LS_KEYS.RECORDS);
    const newRecord = {
      id: `r${Date.now()}`,
      ts: Date.now(),
      paid: amountCent,
      byUserName: user.name,
      byUserRole: user.role,
      ...orderDetails
    };
    records.push(newRecord);
    setData(LS_KEYS.RECORDS, records);

    console.log(`✅ Pagesa e klientit (${orderDetails.code}) prej ${formatEuro(amountCent)} u regjistrua.`);
    return { success: true };
  }

  // -----------------------------------------------------
  // 4. LOGJIKA E DITËS DHE FACTORY RESET
  // -----------------------------------------------------

  function initializeDay(startCashCent) {
    const state = getData(LS_KEYS.STATE);
    const today = new Date().toISOString().split('T')[0];

    if (state.currentDayOpened === today) {
      console.warn('⚠️ Dita tashmë është hapur.');
      return { success: false };
    }

    state.DAILY_CASH = startCashCent;
    state.CASH_START_TODAY = startCashCent;
    state.currentDayOpened = today;
    setData(LS_KEYS.STATE, state);

    console.log(`\n☀️ Dita e re u hap: CASH START ${formatEuro(startCashCent)}.`);
    return { success: true };
  }

  function closeDay() {
    const state = getData(LS_KEYS.STATE);

    if (!state.currentDayOpened) {
      console.error('❌ Dita nuk është hapur.');
      return { success: false };
    }

    const cashStart = state.CASH_START_TODAY;
    const cashEnd = state.DAILY_CASH;
    const dailyProfit = cashEnd - cashStart;

    state.COMPANY_BUDGET += dailyProfit;
    state.currentDayOpened = null;

    setData(LS_KEYS.STATE, state);

    console.log('\n🌙 Dita u mbyll me sukses.');
    console.log(`   Fitimi Ditor: ${formatEuro(dailyProfit)}`);
    console.log(`   Buxheti i Ri Total: ${formatEuro(state.COMPANY_BUDGET)}`);
    return { success: true };
  }

  function resetSystem(adminPin) {
    const user = getCurrentUser();

    if (user.role !== 'ADMIN') {
      console.error('❌ Vetëm ADMIN mund të bëjë Factory Reset.');
      return { success: false };
    }

    const actualAdmin = getData(LS_KEYS.USERS).find(u => u.id === user.id);
    if (hashPin(adminPin) !== actualAdmin.hashedPin) {
      console.error('❌ PIN-i i ADMIN-it është i gabuar. Reset i anuluar.');
      return { success: false };
    }

    const state = getData(LS_KEYS.STATE);

    localStorage.removeItem(LS_KEYS.MOVES);
    localStorage.removeItem(LS_KEYS.RECORDS);

    state.COMPANY_BUDGET = 0;
    state.DAILY_CASH = 0;
    state.CASH_START_TODAY = 0;
    state.currentDayOpened = null;
    setData(LS_KEYS.STATE, state);

    console.log('\n💣 FACTORY RESET TOTAL u krye me sukses!');
    return { success: true };
  }

  // -----------------------------------------------------
  // 5. LOGJIKA E RAPORTIMIT
  // -----------------------------------------------------

  function generateReport(days) {
    const endTime = Date.now();
    const startTime = endTime - (days * 24 * 60 * 60 * 1000);

    const moves = getData(LS_KEYS.MOVES).filter(m => m.ts >= startTime);
    const records = getData(LS_KEYS.RECORDS).filter(r => r.ts >= startTime);

    let totalIncomeClients = 0;
    let totalIncomeTopup = 0;
    let totalExpense = 0;
    let totalAdvance = 0;

    records.forEach(r => totalIncomeClients += r.paid);
    moves.forEach(m => {
      if (m.type === 'expense') totalExpense += m.amount;
      if (m.type === 'advance') totalAdvance += m.amount;
      if (m.type === 'topup') totalIncomeTopup += m.amount;
    });

    const totalIncome = totalIncomeClients + totalIncomeTopup;
    const totalOutgoing = totalExpense + totalAdvance;
    const netProfit = totalIncome - totalOutgoing;

    console.log('\n==========================================');
    console.log(`📊 RAPORTI I ${days} DITËVE TË FUNDIT`);
    console.log('==========================================');
    console.log(`💰 TË ARDHURAT TOTALE: ${formatEuro(totalIncome)}`);
    console.log(`   - Nga Klientët: ${formatEuro(totalIncomeClients)}`);
    console.log(`   - Nga Top-Up:   ${formatEuro(totalIncomeTopup)}`);
    console.log('------------------------------------------');
    console.log(`💸 SHPENZIMET DHE AVANSET: ${formatEuro(totalOutgoing)}`);
    console.log(`   - Shpenzime (Operative): ${formatEuro(totalExpense)}`);
    console.log(`   - Avansa (Borxh):       ${formatEuro(totalAdvance)}`);
    console.log('------------------------------------------');
    console.log(`📈 FITIMI NETO I PERIUDHËS: ${formatEuro(netProfit)}`);
    console.log('==========================================');
    return { totalIncome, totalOutgoing, netProfit };
  }

  function generateAdvanceReport() {
    const moves = getData(LS_KEYS.MOVES);
    const advancesMap = {};

    moves.forEach(m => {
      if (m.type === 'advance' || m.type === 'repayment') {
        if (!advancesMap[m.who]) {
          advancesMap[m.who] = { given: 0, repaid: 0 };
        }

        if (m.type === 'advance') {
          advancesMap[m.who].given += m.amount;
        } else if (m.type === 'repayment') {
          advancesMap[m.who].repaid += m.amount;
        }
      }
    });

    console.log('\n==========================================');
    console.log('📋 RAPORTI I AVANSAVE DHE BORXHEVE');
    console.log('==========================================');

    Object.keys(advancesMap).forEach(who => {
      const data = advancesMap[who];
      const balance = data.given - data.repaid;

      console.log(`👤 ${who}:`);
      console.log(`   - Avans i Dhënë Total: ${formatEuro(data.given)}`);
      console.log(`   - Borxh i Kthyer:      ${formatEuro(data.repaid)}`);
      console.log(`   - BORXHI I MBETUR:     ${formatEuro(balance)}`);
      console.log('------------------------------------------');
    });
    return advancesMap;
  }

  // -----------------------------------------------------
  // 6. EXPORT NË window.TepihaArka
  // -----------------------------------------------------

  window.TepihaArka = {
    ROLES,
    formatEuro,
    getCurrentUser,

    handleLogin,
    loginWithPin: handleLogin,
    manageUsers,
    listUsers: () => getData(LS_KEYS.USERS),

    getFinancialState,
    recordMove,
    recordClientPayment,
    initializeDay,
    closeDay,
    resetSystem,
    generateReport,
    generateAdvanceReport
  };

})();