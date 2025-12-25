'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

const LS_KEY = 'ARKA_USERS';
const ROLES = ['OWNER', 'ADMIN', 'DISPATCH', 'PUNTOR', 'TRANSPORT'];

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch (e) {
    return fallback;
  }
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function Badge({ children }) {
  return (
    <span className="inline-flex items-center px-3 py-1 rounded-full border border-white/15 bg-white/5 text-[11px] font-black tracking-widest">
      {children}
    </span>
  );
}

export default function ArkaStaffPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState('checking'); // db | local
  const [items, setItems] = useState([]);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', role: 'PUNTOR', is_admin: false, is_active: true });

  // BUILD TAG (for debugging deployments): remove later
  const BUILD_TAG = 'CARD-MODE-V2';

  const canManage = useMemo(() => user?.role === 'OWNER' || user?.role === 'ADMIN', [user]);

  useEffect(() => {
    const u = jparse(localStorage.getItem('CURRENT_USER_DATA'), null);
    if (!u) {
      router.push('/login');
      return;
    }
    setUser(u);

    (async () => {
      // Try DB first; if table missing -> local
      const { error } = await supabase.from('arka_staff').select('id').limit(1);
      if (!error) {
        setMode('db');
        await reloadDb();
      } else {
        setMode('local');
        setItems(jparse(localStorage.getItem(LS_KEY), []));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function reloadDb() {
    const { data, error } = await supabase
      .from('arka_staff')
      .select('id,name,role,is_admin,is_active,created_at')
      .order('created_at', { ascending: false });
    if (!error) setItems(data || []);
  }

  function openCreate() {
    if (!canManage) return;
    setEditing(null);
    setForm({ name: '', role: 'PUNTOR', is_admin: false, is_active: true });
    setOpen(true);
  }

  function openEdit(row) {
    if (!canManage) return;
    setEditing(row);
    setForm({
      name: row.name || '',
      role: row.role || 'PUNTOR',
      is_admin: !!row.is_admin,
      is_active: row.is_active !== false,
    });
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setEditing(null);
    setForm({ name: '', role: 'PUNTOR', is_admin: false, is_active: true });
  }

  async function save() {
    if (!canManage) return;
    if (!form.name.trim()) return alert('SHKRUAJ EMRIN');

    if (mode === 'db') {
      if (editing?.id) {
        const { error } = await supabase
          .from('arka_staff')
          .update({
            name: form.name.trim(),
            role: form.role,
            is_admin: !!form.is_admin,
            is_active: !!form.is_active,
          })
          .eq('id', editing.id);
        if (error) return alert(error.message);
      } else {
        const { error } = await supabase
          .from('arka_staff')
          .insert([{ name: form.name.trim(), role: form.role, is_admin: !!form.is_admin, is_active: !!form.is_active }]);
        if (error) return alert(error.message);
      }
      await reloadDb();
      close();
      return;
    }

    // local mode
    const next = [...items];
    if (editing?.id) {
      const ix = next.findIndex((x) => x.id === editing.id);
      if (ix >= 0) next[ix] = { ...next[ix], ...form, name: form.name.trim() };
    } else {
      next.unshift({ id: uid(), name: form.name.trim(), role: form.role, is_admin: !!form.is_admin, is_active: !!form.is_active, created_at: new Date().toISOString() });
    }
    setItems(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    close();
  }

  async function remove(row) {
    if (!canManage) return;
    if (!confirm('ME FSHI?')) return;

    if (mode === 'db') {
      const { error } = await supabase.from('arka_staff').delete().eq('id', row.id);
      if (error) return alert(error.message);
      await reloadDb();
      return;
    }

    const next = items.filter((x) => x.id !== row.id);
    setItems(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  }

  return (
    <div className="min-h-screen bg-black text-white px-4 pt-6 pb-24">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl md:text-5xl font-black tracking-widest">ARKA • PUNTORËT</h1>
            <div className="mt-2 flex flex-wrap gap-2 opacity-90">
              <Badge>DESIGN A • {BUILD_TAG}</Badge>
              <Badge>{user?.name || '—'} • {user?.role || '—'}</Badge>
              <Badge>{mode === 'db' ? 'SUPABASE' : mode === 'local' ? 'LOCAL' : '...'}</Badge>
            </div>
          </div>
          <Link href="/arka" className="px-4 py-2 rounded-xl border border-white/15 bg-white/5 font-black tracking-widest">KTHEHU</Link>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <div className="text-sm text-white/70 font-black tracking-widest">{items.length} RRESHTA</div>
          {canManage ? (
            <button onClick={openCreate} className="px-4 py-3 rounded-2xl bg-white text-black font-black tracking-widest">
              + SHTO PUNTOR
            </button>
          ) : (
            <div className="text-xs text-white/50 font-black tracking-widest">VETËM ADMIN/OWNER MUND ME NDRYSHU</div>
          )}
        </div>

        <div className="mt-4 grid gap-3">
          {items.map((row) => (
            <div key={row.id} className="rounded-2xl border border-white/12 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xl font-black tracking-widest">{(row.name || '').toUpperCase()}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge>{String(row.role || 'PUNTOR').toUpperCase()}</Badge>
                    {row.is_admin ? <Badge>ADMIN</Badge> : null}
                    {row.is_active === false ? <Badge>OFF</Badge> : <Badge>AKTIV</Badge>}
                  </div>
                </div>
                {canManage ? (
                  <div className="flex gap-2">
                    <button onClick={() => openEdit(row)} className="px-4 py-2 rounded-xl border border-white/15 bg-white/5 font-black tracking-widest">
                      EDIT
                    </button>
                    <button onClick={() => remove(row)} className="px-4 py-2 rounded-xl bg-red-600 text-white font-black tracking-widest">
                      FSHI
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {items.length === 0 ? (
            <div className="mt-6 text-white/60 font-black tracking-widest">NUK KA PUNTORË</div>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end md:items-center justify-center p-3">
          <div className="w-full max-w-lg rounded-3xl border border-white/15 bg-black p-4">
            <div className="flex items-center justify-between">
              <div className="text-lg font-black tracking-widest">{editing ? 'EDIT' : 'SHTO'}</div>
              <button onClick={close} className="px-4 py-2 rounded-xl border border-white/15 bg-white/5 font-black tracking-widest">MBYLLE</button>
            </div>

            <div className="mt-4 grid gap-3">
              <div>
                <div className="text-xs text-white/60 font-black tracking-widest">EMRI</div>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="mt-1 w-full px-4 py-3 rounded-2xl bg-white text-black font-black tracking-widest"
                  placeholder="SHKRUJ EMRIN"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-white/60 font-black tracking-widest">ROLI</div>
                  <select
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                    className="mt-1 w-full px-3 py-3 rounded-2xl bg-white text-black font-black tracking-widest"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-end gap-3">
                  <label className="flex items-center gap-2 text-sm font-black tracking-widest">
                    <input
                      type="checkbox"
                      checked={!!form.is_admin}
                      onChange={(e) => setForm((f) => ({ ...f, is_admin: e.target.checked }))}
                    />
                    ADMIN
                  </label>
                  <label className="flex items-center gap-2 text-sm font-black tracking-widest">
                    <input
                      type="checkbox"
                      checked={!!form.is_active}
                      onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                    />
                    AKTIV
                  </label>
                </div>
              </div>

              <button onClick={save} className="mt-2 w-full px-4 py-4 rounded-2xl bg-white text-black font-black tracking-widest">
                RUAJ
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
