'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ArkaPage() {
  const router = useRouter();

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
      APPROVALS: 'ARKA_APPROVALS',
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
  // GATI payments (local) helpers
  // -----------------------------
  function loadArkaPaymentsLocal() {
    const raw = lsGetRaw('arka_list_v1');
    if (!raw) return [];
    const arr = safeParseJSON(raw, []);
    return Array.isArray(arr) ? arr : [];
  }

  function euroToCent(v) {
    const s = String(v ?? '').trim().replace(',', '.');
    const num = Number(s);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100);
  }

  // ✅ Sync local ARKA records (arka_list_v1) into DAILY_CASH once per record.
  function syncArkaListIntoDailyCash() {
    if (!isBrowser) return { added: 0, count: 0 };
    try {
      const state = getData(LS_KEYS.STATE, null);
      if (!state?.currentDayOpened) return { added: 0, count: 0 };

      const day = String(state.currentDayOpened);
      const start = new Date(day + 'T00:00:00').getTime();
      const end = new Date(day + 'T23:59:59').getTime();

      const list = loadArkaPaymentsLocal();
      const seen = getData(LS_KEYS.RECORDS, []) || [];
      const seenSet = new Set(Array.isArray(seen) ? seen : []);

      let addedCent = 0;
      let addedCount = 0;

      for (const r of Array.isArray(list) ? list : []) {
        const id = String(r?.id || '');
        const ts = Number(r?.ts || 0);
        if (!id || !Number.isFinite(ts)) continue;
        if (ts < start || ts > end) continue;
        if (seenSet.has(id)) continue;

        const paidCent = euroToCent(r?.paid || 0);
        if (paidCent <= 0) {
          seenSet.add(id);
          continue;
        }

        addedCent += paidCent;
        addedCount += 1;
        seenSet.add(id);
      }

      if (addedCent > 0) {
        state.DAILY_CASH = (Number(state.DAILY_CASH) || 0) + addedCent;
        lsSet(LS_KEYS.STATE, state);
      }

      // persist seen ids (cap to avoid bloat)
      const nextSeen = Array.from(seenSet).slice(-2000);
      lsSet(LS_KEYS.RECORDS, nextSeen);

      return { added: addedCent, count: addedCount };
    } catch {
      return { added: 0, count: 0 };
    }
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
          hourlyRate: 0,
          active: true,
          mustChangePin: false,
        },
      ];
      lsSet(LS_KEYS.USERS, users);
    }

    // migrate user fields (active, mustChangePin, hourlyRate)
    try {
      const u0 = getData(LS_KEYS.USERS, []) || [];
      if (Array.isArray(u0)) {
        const u1 = u0.map((u) => ({
          ...u,
          hourlyRate: Number(u?.hourlyRate ?? 0) || 0,
          active: u?.active === false ? false : true,
          mustChangePin: !!u?.mustChangePin,
        }));
        lsSet(LS_KEYS.USERS, u1);
      }
    } catch {}

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
    if (!Array.isArray(getData(LS_KEYS.APPROVALS, []))) lsSet(LS_KEYS.APPROVALS, []);

    // api
    apiRef.current = {
      ROLES,

      getCurrentUser: () => getData(LS_KEYS.CURRENT_USER, {}) || {},

      handleLogin: (pin) => {
        const hashed = hashPin(pin);
        const u = (getData(LS_KEYS.USERS, []) || []).find((x) => x?.hashedPin === hashed);
        if (!u) return { success: false, message: 'PIN i gabuar' };
        if (u?.active === false) return { success: false, message: 'Përdoruesi është INAKTIV' };
        const session = { id: u.id, name: u.name, role: u.role, mustChangePin: !!u.mustChangePin };
        lsSet(LS_KEYS.CURRENT_USER, session);
        return { success: true, user: session };
      },

      logout: () => {
        lsRemove(LS_KEYS.CURRENT_USER);
        return { success: true };
      },

      listUsers: () => getData(LS_KEYS.USERS, []) || [],

      // approvals (expense > 10€ etc.)
      requestApproval: ({ type, source, amountCent, note }) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (!me?.name) return { success: false, message: 'Duhet login' };
        const t = String(type || '').trim();
        const s = String(source || '').trim();
        const amt = Math.max(0, Number(amountCent) || 0);
        if (!['expense', 'advance'].includes(t)) return { success: false, message: 'Type i pavlefshëm' };
        if (!['arka'].includes(s)) return { success: false, message: 'Lejohet vetëm ARKA' };
        if (amt <= 0) return { success: false, message: 'Shuma mungon' };

        const approvals = getData(LS_KEYS.APPROVALS, []) || [];
        const req = {
          id: `a${Date.now()}`,
          ts: Date.now(),
          status: 'PENDING',
          type: t,
          source: s,
          amount: amt,
          note: String(note || '').trim() || null,
          requestedBy: { id: me.id, name: me.name, role: me.role },
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
        };
        approvals.push(req);
        lsSet(LS_KEYS.APPROVALS, approvals);
        return { success: true, request: req };
      },

      listApprovals: () => (getData(LS_KEYS.APPROVALS, []) || []).slice(-200).reverse(),

      decideApproval: ({ id, approve, decisionNote }) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (!me?.name) return { success: false, message: 'Duhet login' };
        if (!['ADMIN', 'DISPATCH'].includes(String(me.role || '').toUpperCase())) {
          return { success: false, message: 'Vetëm ADMIN/DISPATCH' };
        }
        const approvals = getData(LS_KEYS.APPROVALS, []) || [];
        const idx = approvals.findIndex((x) => x?.id === id);
        if (idx < 0) return { success: false, message: 'S’u gjet kërkesa' };
        const cur = approvals[idx];
        if (cur?.status !== 'PENDING') return { success: false, message: 'Kërkesa s’është PENDING' };

        approvals[idx] = {
          ...cur,
          status: approve ? 'APPROVED' : 'REJECTED',
          decidedBy: { id: me.id, name: me.name, role: me.role },
          decidedAt: Date.now(),
          decisionNote: String(decisionNote || '').trim() || null,
        };
        lsSet(LS_KEYS.APPROVALS, approvals);

        if (approve) {
          // apply as a normal move
          const res = apiRef.current?.recordMove?.({
            type: approvals[idx].type,
            source: approvals[idx].source,
            amountCent: approvals[idx].amount,
            who: approvals[idx].requestedBy?.name || null,
            note: approvals[idx].note || null,
          });
          if (!res?.success) return { success: false, message: res?.message || 'S’u aplikua' };
        }

        return { success: true, request: approvals[idx] };
      },

      manageUsers: (action, data) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (me.role !== 'ADMIN') return { success: false, message: 'Nuk je ADMIN' };

        let users2 = getData(LS_KEYS.USERS, []) || [];
        if (!Array.isArray(users2)) users2 = [];

        if (action === 'ADD') {
          const name = String(data?.name || '').trim();
          const pin = String(data?.pin || '').trim();
          const role = String(data?.role || '').trim().toUpperCase();
          const hourlyRate = Number(data?.hourlyRate ?? 0) || 0;

          if (!name || !pin) return { success: false, message: 'Emri/PIN mungon' };
          if (!ROLES.includes(role)) return { success: false, message: 'Roli i pavlefshëm' };

          const newUser = {
            id: `u${Date.now()}`,
            name,
            role,
            hashedPin: hashPin(pin),
            hourlyRate,
            active: true,
            mustChangePin: true,
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

        if (action === 'UPDATE_RATE') {
          const id = String(data?.id || '');
          const hourlyRate = Number(data?.hourlyRate ?? 0) || 0;
          if (!id) return { success: false, message: 'ID mungon' };
          users2 = users2.map((u) => (u?.id === id ? { ...u, hourlyRate } : u));
          lsSet(LS_KEYS.USERS, users2);
          return { success: true, users: users2 };
        }

        if (action === 'RESET_PIN') {
          const id = String(data?.id || '');
          const pin = String(data?.pin || '').trim();
          if (!id || !pin) return { success: false, message: 'ID/PIN mungon' };
          users2 = users2.map((u) => (u?.id === id ? { ...u, hashedPin: hashPin(pin), mustChangePin: true } : u));
          lsSet(LS_KEYS.USERS, users2);
          return { success: true, users: users2 };
        }

        if (action === 'UPDATE_ROLE') {
          const id = String(data?.id || '');
          const role = String(data?.role || '').trim().toUpperCase();
          if (!id) return { success: false, message: 'ID mungon' };
          if (!ROLES.includes(role)) return { success: false, message: 'Roli i pavlefshëm' };
          users2 = users2.map((u) => (u?.id === id ? { ...u, role } : u));
          lsSet(LS_KEYS.USERS, users2);
          if (id === me.id) lsSet(LS_KEYS.CURRENT_USER, { ...me, role });
          return { success: true, users: users2 };
        }

        if (action === 'TOGGLE_ACTIVE') {
          const id = String(data?.id || '');
          if (!id) return { success: false, message: 'ID mungon' };
          if (id === me.id) return { success: false, message: 'S’mund ta çaktivizosh vetën' };
          users2 = users2.map((u) => (u?.id === id ? { ...u, active: u?.active === false ? true : false } : u));
          lsSet(LS_KEYS.USERS, users2);
          return { success: true, users: users2 };
        }

        return { success: false, message: 'Action i panjohur' };
      },

      changeMyPin: (currentPin, newPin) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (!me?.id) return { success: false, message: 'S’je i kyçur' };
        const cur = String(currentPin || '').trim();
        const np = String(newPin || '').trim();
        if (!cur || !np) return { success: false, message: 'PIN mungon' };
        if (np.length < 3) return { success: false, message: 'PIN shumë i shkurtër' };

        let users2 = getData(LS_KEYS.USERS, []) || [];
        if (!Array.isArray(users2)) users2 = [];
        const u = users2.find((x) => x?.id === me.id);
        if (!u) return { success: false, message: 'User s’u gjet' };

        if (u.hashedPin !== hashPin(cur)) return { success: false, message: 'PIN aktual gabim' };

        users2 = users2.map((x) => (x?.id === me.id ? { ...x, hashedPin: hashPin(np), mustChangePin: false } : x));
        lsSet(LS_KEYS.USERS, users2);
        lsSet(LS_KEYS.CURRENT_USER, { ...me, mustChangePin: false });
        return { success: true };
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

        // ✅ before closing, pull in any uncounted cash records from today
        const syncRes = syncArkaListIntoDailyCash();
        const state2 = getData(LS_KEYS.STATE, null) || state;

        const profit = (Number(state2.DAILY_CASH) || 0) - (Number(state2.CASH_START_TODAY) || 0);
        state2.COMPANY_BUDGET = (Number(state2.COMPANY_BUDGET) || 0) + profit;

        // reset day
        state2.currentDayOpened = null;
        state2.openedBy = null;
        state2.openedByRole = null;
        state2.openedAt = null;
        state2.DAILY_CASH = 0;
        state2.CASH_START_TODAY = 0;

        lsSet(LS_KEYS.STATE, state2);
        return {
          success: true,
          profit,
          state: state2,
          syncedAdded: syncRes?.added || 0,
          syncedCount: syncRes?.count || 0,
        };
      },

      // -----------------
      // APPROVAL FLOW
      // -----------------
      requestApproval: ({ type, source, amountCent, who, note }) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (!me?.name) return { success: false, message: 'Duhet login' };

        const t = String(type || '').trim();
        const s = String(source || '').trim();
        const amt = Math.max(0, Number(amountCent) || 0);
        if (!['expense', 'advance'].includes(t)) return { success: false, message: 'Type i pavlefshëm' };
        if (!['arka'].includes(s)) return { success: false, message: 'Vetëm ARKA' };
        if (amt <= 0) return { success: false, message: 'Shuma mungon' };

        let approvals = getData(LS_KEYS.APPROVALS, []) || [];
        if (!Array.isArray(approvals)) approvals = [];
        const req = {
          id: `a${Date.now()}`,
          ts: Date.now(),
          status: 'PENDING', // PENDING | APPROVED | REJECTED
          type: t,
          source: s,
          amount: amt,
          who: String(who || '').trim() || null,
          note: String(note || '').trim() || null,
          requestedBy: me.name,
          requestedRole: me.role,
          decidedBy: null,
          decidedRole: null,
          decidedAt: null,
          decisionNote: null,
        };
        approvals.push(req);
        lsSet(LS_KEYS.APPROVALS, approvals);
        return { success: true, req };
      },

      listApprovals: () => {
        const approvals = getData(LS_KEYS.APPROVALS, []) || [];
        return Array.isArray(approvals) ? approvals.slice(-200).reverse() : [];
      },

      decideApproval: (id, decision, decisionNote) => {
        const me = getData(LS_KEYS.CURRENT_USER, {}) || {};
        if (!me?.name) return { success: false, message: 'Duhet login' };
        if (!['ADMIN', 'DISPATCH'].includes(String(me?.role || '').toUpperCase())) {
          return { success: false, message: 'Vetëm ADMIN/DISPATCH' };
        }

        let approvals = getData(LS_KEYS.APPROVALS, []) || [];
        if (!Array.isArray(approvals)) approvals = [];
        const idx = approvals.findIndex((x) => x?.id === id);
        if (idx < 0) return { success: false, message: 'Kërkesa s’u gjet' };

        const a = approvals[idx];
        if (a?.status !== 'PENDING') return { success: false, message: 'Kjo është vendosur' };

        const dec = String(decision || '').toUpperCase();
        if (!['APPROVE', 'REJECT'].includes(dec)) return { success: false, message: 'Vendim i pavlefshëm' };

        if (dec === 'REJECT') {
          approvals[idx] = {
            ...a,
            status: 'REJECTED',
            decidedBy: me.name,
            decidedRole: me.role,
            decidedAt: Date.now(),
            decisionNote: String(decisionNote || '').trim() || null,
          };
          lsSet(LS_KEYS.APPROVALS, approvals);
          return { success: true, req: approvals[idx] };
        }

        // APPROVE -> record as real move
        const res = apiRef.current?.recordMove?.({
          type: a.type,
          source: a.source,
          amountCent: a.amount,
          who: a.who,
          note: a.note,
        });

        if (!res?.success) return { success: false, message: res?.message || 'S’u aprovua' };

        approvals[idx] = {
          ...a,
          status: 'APPROVED',
          decidedBy: me.name,
          decidedRole: me.role,
          decidedAt: Date.now(),
          decisionNote: String(decisionNote || '').trim() || null,
          moveId: res?.move?.id || null,
        };
        lsSet(LS_KEYS.APPROVALS, approvals);
        return { success: true, req: approvals[idx], move: res?.move };
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

        // PUNTOR rules:
        // - can't touch COMPANY_BUDGET
        // - can add small expense from ARKA up to 10€ directly
        // - above 10€ must go through approval (requestApproval)
        if (me.role !== 'ADMIN' && t === 'expense') {
          if (s !== 'arka') return { success: false, message: 'Puntori s’mund nga BUXHETI' };
          if (amt > 1000) return { success: false, message: 'Kërkon aprovimin e DISPATCH (>10€)' };
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

  const [tab, setTab] = useState('SOT');

  // ADMIN create user form
  const [newName, setNewName] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newRole, setNewRole] = useState('PUNTOR');
  const [newHourlyRate, setNewHourlyRate] = useState(0);

  // CHANGE MY PIN
  const [myPinCur, setMyPinCur] = useState('');
  const [myPinNew, setMyPinNew] = useState('');
  const [myPinNew2, setMyPinNew2] = useState('');

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

  // GATI payments
  const [arkaPays, setArkaPays] = useState([]);

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
    if (me?.role === 'ADMIN') return apiRef.current?.listMovesForToday?.() || [];
    return apiRef.current?.listMovesForMe?.() || [];
  }, [ready, me?.role, refreshTick]);

  const approvals = useMemo(() => {
    if (!ready) return [];
    const role = String(me?.role || '').toUpperCase();
    if (role !== 'ADMIN' && role !== 'DISPATCH') return [];
    return apiRef.current?.listApprovals?.() || [];
  }, [ready, me?.role, refreshTick]);

  // init
  useEffect(() => {
    if (!isBrowser) return;
    initSystemOnce();
    const current = getData(LS_KEYS.CURRENT_USER, {}) || {};
    setMe(current);
    setReady(true);

    // ✅ If day is open, auto-sync any new arka_list_v1 cash into DAILY_CASH
    try {
      syncArkaListIntoDailyCash();
    } catch {}

    // pagesat nga GATI (local)
    try {
      setArkaPays(loadArkaPaymentsLocal());
    } catch {
      setArkaPays([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // role redirect (TRANSPORT should use its own ARKA)
  useEffect(() => {
    if (!ready) return;
    if (me?.role === 'TRANSPORT') {
      router.replace('/transport/arka');
    }
  }, [ready, me?.role, router]);

  function hardRefresh() {
    // ✅ keep DAILY_CASH in sync with cash records
    try {
      syncArkaListIntoDailyCash();
    } catch {}

    setRefreshTick((x) => x + 1);
    const current = getData(LS_KEYS.CURRENT_USER, {}) || {};
    setMe(current);

    try {
      setArkaPays(loadArkaPaymentsLocal());
    } catch {
      setArkaPays([]);
    }
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

    // ✅ pas login: dërgo automatikisht te paneli i rolit
    try {
      const u = getData(LS_KEYS.CURRENT_USER, null);
      const role = String(u?.role || '').toUpperCase();
      if (role === 'DISPATCH') router.push('/dispatch');
      else if (role === 'TRANSPORT') router.push('/transport');
      else if (role === 'PUNTOR' || role === 'WORKER') router.push('/worker');
    } catch {}
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
      hourlyRate: Number(newHourlyRate) || 0,
    });
    if (!res?.success) {
      alert('❌ Nuk u shtua: ' + (res?.message || ''));
      return;
    }
    setNewName('');
    setNewPin('');
    setNewRole('PUNTOR');
    setNewHourlyRate(0);
    hardRefresh();
    alert('✅ Puntori u shtua');
  }

  function doUpdateRate(id, hourlyRate) {
    const res = apiRef.current?.manageUsers?.('UPDATE_RATE', { id, hourlyRate: Number(hourlyRate) || 0 });
    if (!res?.success) {
      alert('❌ S’u ruajt rroga: ' + (res?.message || ''));
      return;
    }
    hardRefresh();
    alert('✅ U ruajt rroga/orë');
  }

  function doResetPinAdmin(id, pin) {
    const p = String(pin || '').trim();
    if (!p) return alert('Shkruaj PIN-in e ri');
    const res = apiRef.current?.manageUsers?.('RESET_PIN', { id, pin: p });
    if (!res?.success) {
      alert('❌ S’u ndërrua PIN: ' + (res?.message || ''));
      return;
    }
    hardRefresh();
    alert('✅ PIN u ndërrua');
  }

  function doChangeMyPin() {
    if (!myPinCur || !myPinNew) return alert('Shkruaj PIN aktual + PIN të ri');
    if (myPinNew !== myPinNew2) return alert('PIN i ri s’përputhet');
    const res = apiRef.current?.changeMyPin?.(myPinCur, myPinNew);
    if (!res?.success) {
      alert('❌ ' + (res?.message || 'S’u ndërrua PIN'));
      return;
    }
    setMyPinCur('');
    setMyPinNew('');
    setMyPinNew2('');
    alert('✅ PIN u ndërrua');
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
      const amtCent = toCentFromEuroInput(expAmount);

      // PUNTOR: auto-expense <=10€; above that -> approval request
      if (me?.role && me.role !== 'ADMIN' && amtCent > 1000) {
        const req = apiRef.current?.requestApproval?.({
          type: 'expense',
          source: 'arka',
          amountCent: amtCent,
          who: null,
          note: expNote,
        });
        if (!req?.success) return alert('❌ ' + (req?.message || 'Gabim'));
        setExpAmount('');
        setExpNote('');
        hardRefresh();
        return alert('✅ U dërgua për aprovimin e DISPATCH (>' + '10€)');
      }

      const res = apiRef.current?.recordMove?.({
        type: 'expense',
        source: me?.role === 'ADMIN' ? expSource : 'arka',
        amountCent: amtCent,
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
          {isAdmin || me?.role === 'DISPATCH' ? (
            <div style={{ opacity: 0.75 }}>SOT: {formatEuro(state?.DAILY_CASH || 0)}</div>
          ) : (
            <div style={{ opacity: 0.55 }}>SOT: (FSHEHUR)</div>
          )}
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

      {me?.name ? (
        <div style={{ ...box, marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>NDRYSHO PIN (VET)</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              style={input}
              inputMode="numeric"
              placeholder="PIN AKTUAL"
              value={myPinCur}
              onChange={(e) => setMyPinCur(e.target.value)}
            />
            <input
              style={input}
              inputMode="numeric"
              placeholder="PIN I RI"
              value={myPinNew}
              onChange={(e) => setMyPinNew(e.target.value)}
            />
            <input
              style={input}
              inputMode="numeric"
              placeholder="PERSERIT"
              value={myPinNew2}
              onChange={(e) => setMyPinNew2(e.target.value)}
            />
            <button style={btnPrimary} onClick={doChangeMyPin}>
              RUAJ
            </button>
          </div>
          <div style={{ opacity: 0.7, fontSize: 12, marginTop: 6 }}>
            Kjo punon për PUNTOR, TRANSPORT edhe ADMIN.
          </div>
        </div>
      ) : null}

      {/* NAV */}
      {me?.name && !me?.mustChangePin ? (
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <button style={tab === 'SOT' ? btnPrimary : btn} onClick={() => setTab('SOT')}>
            SOT
          </button>
          <button style={tab === 'LEVIZJE' ? btnPrimary : btn} onClick={() => setTab('LEVIZJE')}>
            LËVIZJE
          </button>
          <button style={tab === 'PUNTOR' ? btnPrimary : btn} onClick={() => setTab('PUNTOR')}>
            PUNTORËT
          </button>
          {(me?.role === 'ADMIN' || me?.role === 'DISPATCH') ? (
            <button style={tab === 'APROVIM' ? btnPrimary : btn} onClick={() => setTab('APROVIM')}>
              APROVIM
            </button>
          ) : null}
          <button style={btn} onClick={hardRefresh}>
            RIFRESKO
          </button>
          {isAdmin ? (
            <button style={{ ...btn, borderColor: 'rgba(255,100,100,0.5)' }} onClick={doFactoryReset}>
              RESET
            </button>
          ) : null}
        </div>
      ) : null}

      {me?.mustChangePin ? (
        <div style={{ ...box, marginTop: 12, borderColor: 'rgba(255,200,0,0.35)' }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>DUHET ME NDRRUE PININ</div>
          <div style={{ opacity: 0.9 }}>Ky është kyçja e parë — ndrysho PIN-in para se me vazhdu.</div>
        </div>
      ) : null}

      {/* USERS (ADMIN) */}
      {!me?.mustChangePin && tab === 'PUNTOR' && (
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
              <input
                style={input}
                type="number"
                step="0.5"
                placeholder="RROGA/ORË"
                value={String(newHourlyRate)}
                onChange={(e) => setNewHourlyRate(e.target.value)}
              />
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
                  <div style={{ opacity: 0.75 }}>
                    {u.role}
                    {u.active === false ? ' • INAKTIV' : ''}
                  </div>

                  {me.role === 'ADMIN' ? (
                    <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        style={{ ...input, width: 120 }}
                        type="number"
                        step="0.5"
                        placeholder="RROGA/ORË"
                        defaultValue={u.hourlyRate ?? 0}
                        onBlur={(e) => doUpdateRate(u.id, e.target.value)}
                      />
                      <input
                        style={{ ...input, width: 110 }}
                        inputMode="numeric"
                        placeholder="PIN RI"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') doResetPinAdmin(u.id, e.currentTarget.value);
                        }}
                      />
                      <div style={{ opacity: 0.7, fontSize: 12 }}>Enter = Ndërro PIN</div>
                      <select
                        style={{ ...input, width: 150 }}
                        value={u.role}
                        onChange={(e) => apiRef.current.manageUsers('UPDATE_ROLE', { id: u.id, role: e.target.value })}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button
                        style={{
                          ...btn,
                          borderColor:
                            u.active === false ? 'rgba(255,120,120,0.6)' : 'rgba(120,255,120,0.35)',
                        }}
                        onClick={() => apiRef.current.manageUsers('TOGGLE_ACTIVE', { id: u.id })}
                      >
                        {u.active === false ? 'INAKTIV' : 'AKTIV'}
                      </button>
                    </div>
                  ) : null}
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

      {/* APROVIMET (ADMIN/DISPATCH) */}
      {!me?.mustChangePin && tab === 'APROVIM' && (me?.role === 'ADMIN' || me?.role === 'DISPATCH') && (
        <div style={box}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>KËRKESAT PËR APROVIM</div>
          {approvals.length === 0 ? (
            <div style={{ opacity: 0.7 }}>S’ka kërkesa.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {approvals.map((a) => (
                <div key={a.id} style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontWeight: 900 }}>{String(a.type || '').toUpperCase()} · {String(a.source || '').toUpperCase()}</div>
                    <div style={{ fontWeight: 900 }}>{formatEuro(Number(a.amount) || 0)}</div>
                  </div>
                  <div style={{ opacity: 0.75, marginTop: 4 }}>
                    {a.byUserName} ({a.byUserRole}) · {a.note ? a.note : '—'}
                  </div>
                  <div style={{ opacity: 0.55, fontSize: 12, marginTop: 4 }}>{new Date(a.ts).toLocaleString()}</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                      style={btnPrimary}
                      onClick={() => {
                        const res = apiRef.current?.decideApproval?.(a.id, 'APPROVE');
                        if (!res?.success) return alert('❌ ' + (res?.message || 'Gabim'));
                        hardRefresh();
                      }}
                    >
                      ✅ APROVO
                    </button>
                    <button
                      style={{ ...btn, borderColor: 'rgba(255,100,100,0.45)' }}
                      onClick={() => {
                        const res = apiRef.current?.decideApproval?.(a.id, 'REJECT');
                        if (!res?.success) return alert('❌ ' + (res?.message || 'Gabim'));
                        hardRefresh();
                      }}
                    >
                      ❌ REFUZO
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ opacity: 0.6, fontSize: 12, marginTop: 10 }}>
            Rregull: PUNTOR mund të shtojë shpenzim direkt deri 10€; mbi 10€ shkon në APROVIM.
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
            <input style={input} placeholder="Emri i puntorit" value={advWho} onChange={(e) => setAdvWho(e.target.value)} />
            <input style={input} placeholder="Shuma €" value={advAmount} onChange={(e) => setAdvAmount(e.target.value)} />
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
            <input style={input} placeholder="Shuma €" value={expAmount} onChange={(e) => setExpAmount(e.target.value)} />
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
          <div style={{ marginTop: 18, fontWeight: 800, opacity: 0.9 }}>TOP-UP PËR KOMPANI (DIKUSH I JEP PARA)</div>
          {isAdmin ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                <input style={input} placeholder="Shuma €" value={topAmount} onChange={(e) => setTopAmount(e.target.value)} />
                <input style={input} placeholder="Kush i dha?" value={topWho} onChange={(e) => setTopWho(e.target.value)} />
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
          <div style={{ fontWeight: 900, marginBottom: 8 }}>LËVIZJET ({me?.role === 'ADMIN' ? 'SOT' : 'VETËM TË MIAT'})</div>
          {movesToday.length === 0 ? (
            <div style={{ opacity: 0.7 }}>Ende nuk ka lëvizje.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {movesToday.map((m) => (
                <div key={m.id} style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
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

      {/* PAGESAT NGA GATI */}
      {me?.name && (
        <div style={box}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>PAGESAT NGA GATI</div>

          {arkaPays.length === 0 ? (
            <div style={{ opacity: 0.7 }}>Ende s’ka pagesa të regjistruara.</div>
          ) : (
            <>
              <div style={{ opacity: 0.75, marginBottom: 10 }}>
                TOTAL (pagesa): <b>{formatEuro(arkaPays.reduce((sum, r) => sum + euroToCent(r?.paid || 0), 0))}</b>
              </div>

              <div style={{ display: 'grid', gap: 8 }}>
                {arkaPays.slice(0, 80).map((r) => (
                  <div key={r.id} style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 900 }}>
                        KODI {String(r.code || '—')}
                        {r.name ? ` · ${r.name}` : ''}
                      </div>
                      <div style={{ fontWeight: 900 }}>{formatEuro(euroToCent(r.paid || 0))}</div>
                    </div>

                    <div style={{ opacity: 0.6, marginTop: 4, fontSize: 12 }}>{new Date(r.ts || Date.now()).toLocaleString()}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 10, opacity: 0.6, fontSize: 12 }}>
                (Këto vijnë nga localStorage “arka_list_v1” që e shkruan GATI kur konfirmon pagesën.)
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ height: 40 }} />
    </div>
  );
}
