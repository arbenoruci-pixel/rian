'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ensureDefaultAdminIfEmpty,
  listUsers as listUsersDb,
  findUserByPin as findUserByPinDb,
  upsertUser as upsertUserDb,
} from '@/lib/usersDb';

const LS_USERS = 'arka_workers_v1'; // local fallback only
const LS_USER = 'CURRENT_USER_DATA';
const LS_SESSION = 'tepiha_session_v1';
const DEFAULT_ADMIN_PIN = '1234'; // 4 shifra

function defaultAdmin() {
  return {
    id: 'admin-' + Date.now(),
    name: 'ADMIN',
    role: 'ADMIN',
    pin: DEFAULT_ADMIN_PIN,
    active: true,
    createdAt: new Date().toISOString(),
  };
}

function loadUsers() {
  try {
    const raw = localStorage.getItem(LS_USERS);
    const arr = raw ? JSON.parse(raw) : [];
    const users = Array.isArray(arr) ? arr : [];

    // Nëse s’ka asnjë user (ose s’kanë fare PIN), krijojmë ADMIN-in bazë me 1234.
    const hasAnyPin = users.some((u) => String(u?.pin || '').trim().length > 0);
    if (users.length === 0 || !hasAnyPin) {
      const next = users.length === 0 ? [defaultAdmin()] : [defaultAdmin(), ...users];
      localStorage.setItem(LS_USERS, JSON.stringify(next));
      return next;
    }

    return users;
  } catch {
    return [];
  }
}

async function loadUsersCloudFirst() {
  // Supabase-first. If table doesn't exist or fails, fallback to local.
  try {
    // ensure at least one ADMIN exists
    await ensureDefaultAdminIfEmpty({ name: 'ADMIN', role: 'ADMIN', pin: DEFAULT_ADMIN_PIN });
    const res = await listUsersDb();
    if (res.ok) return res.items;
    // fallback when missing table / rls / etc
    return loadUsers();
  } catch {
    return loadUsers();
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [users, setUsers] = useState([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const items = await loadUsersCloudFirst();
      if (alive) setUsers(items || []);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // /login is the only place we ask for PIN.

  // Bootstrap vetëm kur s’ka askënd fare.
  const bootstrapAllowed = useMemo(() => users.length === 0, [users.length]);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');

    const clean = String(pin).replace(/\D+/g, '').slice(0, 4);
    if (!clean || clean.length !== 4) {
      setError('SHKRUAJ PIN');
      return;
    }

    // If no users exist yet, allow bootstrapping an ADMIN (cloud-first, local fallback).
    if (bootstrapAllowed) {
      try {
        const res = await upsertUserDb({ name: 'ADMIN', role: 'ADMIN', pin: clean, is_active: true });
        if (!res?.ok) throw new Error(res?.error?.message || 'DB ERROR');
      } catch {
        // local fallback
        const admin = {
          id: 'admin-' + Date.now(),
          name: 'ADMIN',
          role: 'ADMIN',
          pin: clean,
          active: true,
          createdAt: new Date().toISOString(),
        };
        localStorage.setItem(LS_USERS, JSON.stringify([admin]));
      }
      const u = { id: 'ADMIN', name: 'ADMIN', role: 'ADMIN' };
      localStorage.setItem(LS_SESSION, JSON.stringify({ user: u, expiresAt: Date.now() + 8 * 60 * 60 * 1000 }));
      localStorage.setItem(LS_USER, JSON.stringify(u));
      router.replace('/');
      return;
    }

    // Cloud-first lookup by PIN (falls back to local list).
    let match = null;
    try {
      const res = await findUserByPinDb(clean);
      if (res?.ok) match = res.item;
    } catch {
      // ignore
    }
    if (!match) {
      match = users.find((u) => String(u.pin) === clean && u.active !== false);
    }
    if (!match) {
      setError('PIN I GABUAR');
      return;
    }

    // Store PIN in session so ARKA can do approvals without asking again.
    // (PIN is only entered on /login.)
    const u = {
      id: match.id || match.user_id || match.uid || 'user',
      name: match.name || 'PUNTOR',
      role: match.role || 'PUNTOR',
      pin: clean,
    };

    // Master session (8h)
    localStorage.setItem(LS_SESSION, JSON.stringify({ user: u, expiresAt: Date.now() + 8 * 60 * 60 * 1000 }));

    // Backwards compat
    localStorage.setItem(LS_USER, JSON.stringify(u));

    // Default redirect by role.
    if (u.role === 'TRANSPORT') {
      router.replace('/transport');
    } else {
      router.replace('/');
    }
  }

  // User creation/edit happens in ARKA -> PUNTORET.

  return (
    <div className="min-h-screen bg-black text-gray-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="text-center">
          <div className="text-2xl font-extrabold tracking-widest">TEPIHA</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.25em] text-gray-300">HYRJE ME PIN</div>
        </div>

        <form onSubmit={onSubmit} className="mt-6 space-y-3">
          <input
            value={pin}
            onChange={(e) => setPin(String(e.target.value).replace(/\D+/g, '').slice(0, 4))}
            inputMode="numeric"
            placeholder={bootstrapAllowed ? 'KRIJO PIN ADMIN' : 'SHKRUAJ PIN'}
            className="w-full rounded-xl bg-black/40 border border-white/10 px-4 py-4 text-center text-2xl tracking-widest outline-none"
          />

          {error ? (
            <div className="text-center text-xs text-red-300 uppercase tracking-widest">{error}</div>
          ) : bootstrapAllowed ? (
            <div className="text-center text-[10px] text-gray-400 uppercase tracking-widest">
              S'KA PUNTORË AKOMA — KJO KRIJON ADMININ E PARË
            </div>
          ) : null}

          <button
            type="submit"
            className="w-full rounded-xl bg-white text-black font-extrabold py-3 uppercase tracking-widest"
          >
            HYJ
          </button>

          {/* RESET LOGIN removed — manage users from ARKA */}
        </form>
      </div>
    </div>
  );
}