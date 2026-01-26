'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
// Importojmë veglat e reja
import { 
  listPendingCashPayments, 
  processPendingPayments, 
  recordCashMove 
} from '@/lib/arkaCashSync';
import { 
  dbGetActiveCycle, 
  dbOpenCycle, 
  dbCloseCycle, 
  dbGetCycleMoves 
} from '@/lib/arkaDb';

export default function ArkaPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState({});
  const [state, setState] = useState({ DAILY_CASH: 0, currentDayOpened: null });
  const [movesToday, setMovesToday] = useState([]);
  const [pendingPayments, setPendingPayments] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);

  // Form states
  const [cashStart, setCashStart] = useState('');
  const [pin, setPin] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [expNote, setExpNote] = useState('');

  // Ngarkimi fillestar i te dhenave nga DB
  async function loadData() {
    const cycle = await dbGetActiveCycle();
    if (cycle) {
      setState({
        id: cycle.id,
        DAILY_CASH: cycle.current_cash || 0,
        currentDayOpened: cycle.opened_at,
        openedBy: cycle.opened_by_name
      });
      // Merr levizjet e ciklit aktual
      const moves = await dbGetCycleMoves(cycle.id);
      setMovesToday(moves || []);
    } else {
      setState({ DAILY_CASH: 0, currentDayOpened: null });
      setMovesToday([]);
    }

    // Merr pagesat qe presin (Pending)
    const pending = await listPendingCashPayments();
    setPendingPayments(pending.items || []);
  }

  useEffect(() => {
    // Kontrollo login (nga localStorage ekzistues)
    const current = JSON.parse(localStorage.getItem('CURRENT_USER_DATA') || '{}');
    if (!current.name) {
      setReady(true);
      return;
    }
    setMe(current);
    loadData().then(() => setReady(true));
  }, []);

  // HAPJA E ARKËS (Me procesim automatik të Pending)
  async function doOpenDay() {
    if (!cashStart) return alert("Shkruaj shumen fillestare");
    const amount = Number(cashStart) || 0;
    
    setIsProcessing(true);
    const res = await dbOpenCycle({
      amount,
      opened_by_pin: me.pin || '',
      opened_by_name: me.name
    });

    if (res.ok) {
      // PROCESIMI AUTOMATIK I PAGESAVE QE PRISNIN
      await processPendingPayments({
        approved_by_name: me.name,
        approved_by_pin: me.pin
      });
      await loadData();
      setCashStart('');
      alert("Arka u hap dhe pagesat PENDING u procesuan!");
    } else {
      alert("Gabim gjatë hapjes: " + res.error);
    }
    setIsProcessing(false);
  }

  // MBYLLJA E ARKËS
  async function doCloseDay() {
    if (!confirm("A jeni i sigurt që dëshironi të mbyllni arkën?")) return;
    
    const res = await dbCloseCycle({
      cycle_id: state.id,
      closed_by_name: me.name
    });

    if (res.ok) {
      alert("Arka u mbyll me sukses!");
      await loadData();
    } else {
      alert("Gabim: " + res.error);
    }
  }

  // REGJISTRIMI I NJE SHPENZIMI
  async function doAddExpense() {
    if (!expAmount) return;
    const res = await recordCashMove({
      amount: Number(expAmount),
      type: 'OUT',
      note: expNote,
      user: me.name,
      source: 'EXPENSE'
    });

    if (res.ok) {
      setExpAmount('');
      setExpNote('');
      await loadData();
    }
  }

  if (!ready) return <div className="p-10 text-white">Duke u ngarkuar...</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto text-white space-y-6">
      <div className="flex justify-between items-center bg-zinc-900 p-6 rounded-2xl border border-white/10">
        <div>
          <h1 className="text-3xl font-black">ARKA DIGJITALE</h1>
          <p className="opacity-60">{me.name ? `${me.name} (${me.role})` : 'S’je i kyçur'}</p>
        </div>
        <div className="text-right">
          <p className="text-sm opacity-50 uppercase">Bilanci Aktual</p>
          <p className="text-2xl font-bold text-green-400">{(state.DAILY_CASH).toFixed(2)} €</p>
        </div>
      </div>

      {!state.currentDayOpened ? (
        <div className="bg-blue-600/20 border border-blue-500/30 p-6 rounded-2xl">
          <h2 className="font-bold mb-4">Hap Ciklin e Ri</h2>
          <div className="flex gap-4">
            <input 
              className="bg-black/40 border border-white/10 p-3 rounded-xl flex-1"
              placeholder="Shuma fillestare €"
              value={cashStart}
              onChange={(e) => setCashStart(e.target.value)}
            />
            <button 
              disabled={isProcessing}
              onClick={doOpenDay}
              className="bg-blue-600 px-6 py-3 rounded-xl font-bold hover:bg-blue-500 transition"
            >
              {isProcessing ? 'Duke u hapur...' : 'HAP ARKËN'}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Format e levizjeve */}
          <div className="bg-zinc-900 p-6 rounded-2xl border border-white/5 space-y-4">
            <h3 className="font-bold opacity-70">Shto Shpenzim</h3>
            <input 
              className="w-full bg-black/40 border border-white/10 p-3 rounded-xl"
              placeholder="Shuma €"
              value={expAmount}
              onChange={(e) => setExpAmount(e.target.value)}
            />
            <input 
              className="w-full bg-black/40 border border-white/10 p-3 rounded-xl"
              placeholder="Shënimi (p.sh. Rrymë, Qira)"
              value={expNote}
              onChange={(e) => setExpNote(e.target.value)}
            />
            <button onClick={doAddExpense} className="w-full bg-white text-black font-bold py-3 rounded-xl">REGJISTRO</button>
            <button onClick={doCloseDay} className="w-full bg-red-600/20 text-red-400 border border-red-600/30 py-3 rounded-xl mt-4">MBYLL ARKËN</button>
          </div>

          {/* Listat e lëvizjeve */}
          <div className="bg-zinc-900 p-6 rounded-2xl border border-white/5 h-[400px] overflow-y-auto">
            <h3 className="font-bold opacity-70 mb-4">Lëvizjet e Fundit</h3>
            {movesToday.map(m => (
              <div key={m.id} className="flex justify-between items-center py-3 border-b border-white/5">
                <div>
                  <p className="font-medium">{m.note || m.source}</p>
                  <p className="text-xs opacity-40">{new Date(m.created_at).toLocaleTimeString()}</p>
                </div>
                <p className={m.type === 'IN' ? 'text-green-400' : 'text-red-400'}>
                  {m.type === 'IN' ? '+' : '-'}{m.amount} €
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pagesat PENDING që presin të dalin në listë */}
      {pendingPayments.length > 0 && (
        <div className="bg-yellow-600/10 border border-yellow-500/20 p-6 rounded-2xl">
          <h3 className="font-bold text-yellow-500 mb-4">Pagesat në pritje ({pendingPayments.length})</h3>
          <div className="space-y-2">
            {pendingPayments.map(p => (
              <div key={p.external_id} className="flex justify-between text-sm opacity-80 bg-black/20 p-3 rounded-lg">
                <span>{p.client_name || p.order_code || 'Pa emër'}</span>
                <span className="font-bold">{p.amount} €</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
