'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { applyReset, audit, getResetPin, setResetPin } from '@/lib/resetEngine';

const LS_SESSION = 'tepiha_session_v1';

function getSessionUser() {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    const s = raw ? JSON.parse(raw) : null;
    if (!s?.user) return null;
    if (s?.expiresAt && Date.now() > Number(s.expiresAt)) return null;
    return s.user;
  } catch {
    return null;
  }
}

export default function ResetModePage() {
  const router = useRouter();
  const [user, setUser] = useState(null);

  const [resetPin, setResetPinInput] = useState('');
  const [newResetPin, setNewResetPin] = useState('');

  const [optPins, setOptPins] = useState(false);
  const [optArka, setOptArka] = useState(false);
  const [optVis, setOptVis] = useState(false);
  const [optFull, setOptFull] = useState(false);

  const [confirmText, setConfirmText] = useState('');
  const confirmOk = useMemo(() => String(confirmText).trim().toUpperCase() === 'RESET', [confirmText]);

  useEffect(() => {
    const u = getSessionUser();
    setUser(u);
    if (!u) router.replace('/login');
    else if (u.role !== 'ADMIN') router.replace('/'); // vetëm ADMIN
  }, [router]);

  function verifyResetPin() {
    const saved = getResetPin();
    if (!saved) return { ok: false, msg: "RESET PIN s'është vendos. Vendose poshtë." };
    if (String(resetPin).trim() !== saved) return { ok: false, msg: "RESET PIN gabim." };
    return { ok: true };
  }

  function onApply() {
    const v = verifyResetPin();
    if (!v.ok) return alert(v.msg);

    if (!(optPins || optArka || optVis || optFull)) {
      alert('Zgjidh të paktën 1 opsion.');
      return;
    }
    if (!confirmOk) {
      alert('Shkruaj "RESET" për konfirmim.');
      return;
    }
    if (!confirm('A je 100% i sigurt?')) return;

    audit('RESET_REQUEST', { by: user?.name || 'ADMIN', opts: { optPins, optArka, optVis, optFull } });

    applyReset({ resetPins: optPins, resetArka: optArka, resetVisibility: optVis, fullReset: optFull });

    alert('RESET u aplikua.');
    // Nëse full reset/pins reset: sesioni mund të fshihet → kthe në login
    router.replace('/login');
  }

  function onSetNewResetPin() {
    const clean = String(newResetPin).replace(/\D+/g, '').slice(0, 8);
    if (!clean || clean.length < 4) return alert('Shkruaj min 4 shifra.');
    setResetPin(clean);
    setNewResetPin('');
    alert('RESET PIN u ruajt.');
  }

  return (
    <div className="min-h-screen bg-black text-gray-100 p-6">
      <div className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="text-center">
          <div className="text-2xl font-extrabold tracking-widest">RESET MODE</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.25em] text-gray-300">ARKA + PIN SYSTEM</div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="text-[10px] uppercase tracking-[0.25em] text-gray-400">VERIFIKO RESET PIN</div>
          <input
            value={resetPin}
            onChange={(e) => setResetPinInput(String(e.target.value).replace(/\D+/g, '').slice(0, 8))}
            inputMode="numeric"
            placeholder="RESET PIN"
            className="w-full rounded-xl bg-black/40 border border-white/10 px-4 py-3 text-center text-xl tracking-widest outline-none"
          />

          <div className="mt-4 text-[10px] uppercase tracking-[0.25em] text-gray-400">OPSIONET</div>

          <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
            <input type="checkbox" checked={optPins} onChange={(e)=>setOptPins(e.target.checked)} />
            <div className="font-extrabold tracking-widest uppercase text-sm">RESET PIN SYSTEM</div>
          </label>

          <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
            <input type="checkbox" checked={optArka} onChange={(e)=>setOptArka(e.target.checked)} />
            <div className="font-extrabold tracking-widest uppercase text-sm">RESET ARKA</div>
          </label>

          <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
            <input type="checkbox" checked={optVis} onChange={(e)=>setOptVis(e.target.checked)} />
            <div className="font-extrabold tracking-widest uppercase text-sm">RESET ROLE VISIBILITY</div>
          </label>

          <label className="flex items-center gap-3 rounded-xl border border-red-400/30 bg-red-500/10 p-3">
            <input type="checkbox" checked={optFull} onChange={(e)=>setOptFull(e.target.checked)} />
            <div className="font-extrabold tracking-widest uppercase text-sm">FULL RESET (OPERATIVE)</div>
          </label>

          <div className="mt-4 text-[10px] uppercase tracking-[0.25em] text-gray-400">KONFIRMIM</div>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder='shkruaj "RESET"'
            className="w-full rounded-xl bg-black/40 border border-white/10 px-4 py-3 text-center tracking-widest outline-none"
          />

          <button
            onClick={onApply}
            disabled={!confirmOk}
            className="w-full rounded-xl bg-red-400 text-black font-extrabold py-3 uppercase tracking-widest disabled:opacity-40"
          >
            APLIKO RESET
          </button>

          <div className="mt-6 h-px bg-white/10" />

          <div className="text-[10px] uppercase tracking-[0.25em] text-gray-400">VENDOS / NDRYSHO RESET PIN</div>
          <input
            value={newResetPin}
            onChange={(e) => setNewResetPin(String(e.target.value).replace(/\D+/g, '').slice(0, 8))}
            inputMode="numeric"
            placeholder="PIN I RI (min 4 shifra)"
            className="w-full rounded-xl bg-black/40 border border-white/10 px-4 py-3 text-center tracking-widest outline-none"
          />
          <button
            onClick={onSetNewResetPin}
            className="w-full rounded-xl bg-white text-black font-extrabold py-3 uppercase tracking-widest"
          >
            RUAJ RESET PIN
          </button>

          <button
            onClick={() => router.replace('/arka')}
            className="w-full rounded-xl bg-white/10 border border-white/10 text-white font-extrabold py-3 uppercase tracking-widest"
          >
            KTHEHU TE ARKA
          </button>
        </div>
      </div>
    </div>
  );
}