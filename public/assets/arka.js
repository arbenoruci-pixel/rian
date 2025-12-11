// public/assets/arka.js
(function () {
  const LS_USERS_KEY = 'tepiha_users_v1';
  const LS_ARKA_KEY = 'tepiha_arka_state_v1';
  const SESSION_USER_KEY = 'tepiha_current_user';

  const DEFAULT_ADMIN_PIN = '4563';

  function hashPin(pin) {
    return btoa('tepiha_salt_' + String(pin));
  }

  function formatEuros(cents) {
    return (cents / 100).toFixed(2);
  }

  function todayId() {
    return new Date().toISOString().slice(0, 10);
  }

  function loadUsers() {
    const raw = localStorage.getItem(LS_USERS_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('Users corrupt, resetting', e);
      return [];
    }
  }

  function saveUsers(users) {
    localStorage.setItem(LS_USERS_KEY, JSON.stringify(users));
  }

  function ensureDefaultAdmin() {
    const users = loadUsers();
    const hasAdmin = users.some(u => u.role === 'admin');
    if (!hasAdmin) {
      const id = 'u_' + Date.now();
      users.push({
        id,
        name: 'ADMIN',
        role: 'admin',
        pinHash: hashPin(DEFAULT_ADMIN_PIN),
        active: true
      });
      saveUsers(users);
      console.info('[ARKA] Default ADMIN (PIN 4563) u krijua.');
    }
  }

  function setCurrentUser(user) {
    if (!user) {
      sessionStorage.removeItem(SESSION_USER_KEY);
    } else {
      sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
    }
  }

  function getCurrentUser() {
    const raw = sessionStorage.getItem(SESSION_USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function loginWithPin(pin) {
    const users = loadUsers();
    const h = hashPin(pin);
    const user = users.find(u => u.pinHash === h && u.active !== false);
    if (!user) return null;
    setCurrentUser(user);
    return user;
  }

  function logout() {
    setCurrentUser(null);
  }

  function canSeeCompanyBudget(user) {
    return user && user.role === 'admin';
  }

  function canSeeAllMoves(user) {
    return user && (user.role === 'admin' || user.role === 'dispatch');
  }

  function filterMovesForUser(allMovesObj, user) {
    if (!user) return [];
    const arr = Object.values(allMovesObj || {});
    if (canSeeAllMoves(user)) return arr;
    return arr.filter(m => m.byUserName === user.name);
  }

  function addUser({ name, pin, role }) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
      throw new Error('Vetëm ADMIN mund të shtojë përdorues.');
    }
    const users = loadUsers();
    const id = 'u_' + Date.now();
    users.push({
      id,
      name,
      role,
      pinHash: hashPin(pin),
      active: true
    });
    saveUsers(users);
    return id;
  }

  function listUsers() {
    return loadUsers();
  }

  function deactivateUser(userId) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
      throw new Error('Vetëm ADMIN mund të ç’aktivizojë përdorues.');
    }
    const users = loadUsers();
    const u = users.find(x => x.id === userId);
    if (u) {
      u.active = false;
      saveUsers(users);
    }
  }

  function loadArkaState() {
    const raw = localStorage.getItem(LS_ARKA_KEY);
    if (!raw) {
      return {
        budgetCents: 0,
        currentDay: null,
        days: {},
        moves: {},
        arkaRecords: {}
      };
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('ARKA state corrupt, resetting', e);
      return {
        budgetCents: 0,
        currentDay: null,
        days: {},
        moves: {},
        arkaRecords: {}
      };
    }
  }

  function saveArkaState(state) {
    localStorage.setItem(LS_ARKA_KEY, JSON.stringify(state));
  }

  function openDay(cashStartEuros) {
    const user = getCurrentUser();
    if (!user) throw new Error('Duhet login para hapjes së ditës.');

    const state = loadArkaState();
    if (state.currentDay && !state.currentDay.closed) {
      throw new Error('Dita ekzistuese nuk është mbyllur ende.');
    }

    const id = todayId();
    const cashStartCents = Math.round(Number(cashStartEuros || 0) * 100);

    const day = {
      id,
      cashStartCents,
      cashNowCents: cashStartCents,
      incomeCents: 0,
      arkaExpensesCents: 0,
      arkaAdvancesCents: 0,
      closed: false,
      closedAt: null
    };

    state.currentDay = day;
    state.days[id] = day;
    saveArkaState(state);
    return day;
  }

  function registerMove({ type, source, amountEuros, who, note }) {
    const user = getCurrentUser();
    if (!user) throw new Error('Duhet login për të regjistruar lëvizje.');

    const state = loadArkaState();
    if (!state.currentDay || state.currentDay.closed) {
      throw new Error('Nuk ka ditë të hapur në ARKË.');
    }

    const amountCents = Math.round(Number(amountEuros || 0) * 100);
    const dayId = state.currentDay.id;
    const id =
      'm_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);

    const move = {
      id,
      type,
      source,
      amountCents,
      who: who || null,
      note: note || null,
      byUserName: user.name,
      byUserRole: user.role,
      ts: Date.now(),
      dayId
    };

    state.moves[id] = move;

    if (type === 'expense') {
      if (source === 'arka') {
        state.currentDay.cashNowCents -= amountCents;
        state.currentDay.arkaExpensesCents += amountCents;
      } else if (source === 'budget') {
        state.budgetCents -= amountCents;
      }
    }

    if (type === 'advance') {
      if (source === 'arka') {
        state.currentDay.cashNowCents -= amountCents;
        state.currentDay.arkaAdvancesCents += amountCents;
      } else if (source === 'budget') {
        state.budgetCents -= amountCents;
      }
    }

    if (type === 'topup') {
      if (source === 'external') {
        state.budgetCents += amountCents;
      }
    }

    saveArkaState(state);
    return move;
  }

  function registerClientPayment({ code, name, phone, amountEuros }) {
    const user = getCurrentUser();
    if (!user) throw new Error('Duhet login për të pranuar pagesë.');

    const state = loadArkaState();
    if (!state.currentDay || state.currentDay.closed) {
      throw new Error('Nuk ka ditë të hapur në ARKË.');
    }

    const amountCents = Math.round(Number(amountEuros || 0) * 100);
    const dayId = state.currentDay.id;
    const id =
      'p_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);

    const rec = {
      id,
      ts: Date.now(),
      code,
      name,
      phone,
      paidCents: amountCents,
      byUserName: user.name,
      byUserRole: user.role,
      dayId
    };

    state.arkaRecords[id] = rec;
    state.currentDay.cashNowCents += amountCents;
    state.currentDay.incomeCents += amountCents;

    saveArkaState(state);
    return rec;
  }

  function closeDayAndProposeTransfer() {
    const user = getCurrentUser();
    if (!user) throw new Error('Duhet login.');

    const state = loadArkaState();
    const day = state.currentDay;
    if (!day || day.closed) {
      throw new Error('Nuk ka ditë të hapur për t’u mbyllur.');
    }

    const cashEndCents = day.cashNowCents;

    day.closed = true;
    day.closedAt = Date.now();
    state.days[day.id] = day;
    state.currentDay = null;

    saveArkaState(state);

    return {
      cashEndCents,
      day
    };
  }

  function transferCashEndToBudget(dayId, amountCents) {
    const user = getCurrentUser();
    if (!user || user.role !== 'admin') {
      throw new Error('Vetëm ADMIN mund të transferojë në buxhet.');
    }

    const state = loadArkaState();
    const day = state.days[dayId];
    if (!day) throw new Error('Dita nuk u gjet.');

    state.budgetCents += amountCents;
    saveArkaState(state);
    return state.budgetCents;
  }

  function hardResetSystem(confirmPin) {
    const users = loadUsers();
    const h = hashPin(confirmPin);
    const admin = users.find(u => u.role === 'admin' && u.pinHash === h);
    if (!admin) {
      throw new Error('PIN i gabuar ose nuk je ADMIN.');
    }

    localStorage.removeItem(LS_ARKA_KEY);
    localStorage.removeItem('tepiha_orders_v1');
    localStorage.removeItem('tepiha_photos_v1');
    localStorage.removeItem('tepiha_days_v1');
    localStorage.removeItem('tepiha_arka_records_v1');

    setCurrentUser(null);
  }

  function getArkaSummary() {
    const state = loadArkaState();
    const user = getCurrentUser();
    const day = state.currentDay;
    const moves = filterMovesForUser(state.moves, user);

    return {
      user,
      budgetCents: state.budgetCents,
      canSeeBudget: canSeeCompanyBudget(user),
      currentDay: day,
      moves,
      arkaRecords: state.arkaRecords
    };
  }

  function getAdvancesForWorker(name) {
    const state = loadArkaState();
    const moves = Object.values(state.moves || {});
    return moves.filter(m => m.type === 'advance' && m.who === name);
  }

  function getTotalAdvanceForWorker(name) {
    return getAdvancesForWorker(name).reduce(
      (sum, m) => sum + m.amountCents,
      0
    );
  }

  function init() {
    ensureDefaultAdmin();
  }

  window.TepihaArka = {
    init,
    loginWithPin,
    logout,
    getCurrentUser,
    addUser,
    listUsers,
    deactivateUser,
    loadArkaState,
    getArkaSummary,
    openDay,
    closeDayAndProposeTransfer,
    transferCashEndToBudget,
    registerMove,
    registerClientPayment,
    getAdvancesForWorker,
    getTotalAdvanceForWorker,
    formatEuros,
    hardResetSystem
  };

  init();
})();
