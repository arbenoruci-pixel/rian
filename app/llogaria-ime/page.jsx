'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { listWorkerDebtRows } from '@/lib/corporateFinance';

const euro = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});

function n(v) { return Number(v || 0) || 0; }
function fmt(v) { return euro.format(n(v)); }
function safeUpper(v) { return String(v || '').trim().toUpperCase(); }
function surfaceTone(status) {
  const s = safeUpper(status);
  if (['APPROVED', 'ACCEPTED', 'ACCEPTED_BY_DISPATCH', 'IN'].includes(s)) return 'ok';
  if (['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL'].includes(s)) return 'warn';
  if (['REJECTED', 'OWED', 'WORKER_DEBT', 'ADVANCE', 'OUT'].includes(s)) return 'bad';
  return 'neutral';
}
function colorForTone(tone) {
  if (tone === 'ok') return { bg: 'rgba(16,185,129,.14)', bd: 'rgba(16,185,129,.26)', fg: '#6ee7b7' };
  if (tone === 'warn') return { bg: 'rgba(245,158,11,.14)', bd: 'rgba(245,158,11,.26)', fg: '#fcd34d' };
  if (tone === 'bad') return { bg: 'rgba(239,68,68,.14)', bd: 'rgba(239,68,68,.26)', fg: '#fca5a5' };
  return { bg: 'rgba(255,255,255,.06)', bd: 'rgba(255,255,255,.08)', fg: '#d1d5db' };
}
function dateOnlyKey(d) {
  const x = d ? new Date(d) : new Date();
  const year = x.getFullYear();
  const month = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function isToday(v) {
  if (!v) return false;
  try { return dateOnlyKey(new Date(v)) === dateOnlyKey(new Date()); } catch { return false; }
}
function normalizeDate(v) {
  try {
    if (!v) return '—';
    return new Date(v).toLocaleString();
  } catch {
    return '—';
  }
}
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && String(v) !== '') return v;
  return null;
}
function matchesPin(order, pin) {
  const p = String(pin || '').trim();
  if (!p || !order) return false;
  const candidates = [
    order.transport_id,
    order.created_by_pin,
    order.assigned_to,
    order.worker_pin,
    order.driver_pin,
    order?.data?.transport_id,
    order?.data?.transportId,
    order?.data?.created_by_pin,
    order?.data?.createdByPin,
    order?.data?.assigned_to,
    order?.data?.worker_pin,
    order?.data?.driver_pin,
    order?.data?._audit?.created_by_pin,
  ].map((x) => String(x || '').trim()).filter(Boolean);
  return candidates.includes(p);
}
function statusOf(order) {
  return safeUpper(firstDefined(order?.status, order?.data?.status, order?.data?.order_status));
}
function amountOf(row) {
  return n(firstDefined(row?.amount, row?.value, row?.total_amount, row?.sum));
}
function m2Of(row) {
  return n(firstDefined(row?.m2_total, row?.total_m2, row?.m2, row?.data?.m2_total, row?.data?.total_m2, row?.data?.m2, row?.pay?.m2_total, row?.pay?.m2));
}
function buildHistory(payments, handoffs, debtRows) {
  const items = [];
  (payments || []).forEach((row) => {
    items.push({
      id: `pay_${row.id || row.external_id || Math.random()}`,
      date: firstDefined(row.created_at, row.updated_at),
      type: 'PAGESË',
      description: row.note || row.client_name || row.order_code || 'Pagesë cash',
      amount: amountOf(row),
      status: safeUpper(row.status || 'PENDING'),
      tone: surfaceTone(row.status || 'PENDING'),
    });
  });
  (handoffs || []).forEach((row) => {
    items.push({
      id: `handoff_${row.id || Math.random()}`,
      date: firstDefined(row.decided_at, row.submitted_at, row.created_at),
      type: 'DORËZIM',
      description: row.dispatch_note || row.note || 'Dorëzim cash te dispatch',
      amount: amountOf(row),
      status: safeUpper(row.status || 'PENDING'),
      tone: surfaceTone(row.status || 'PENDING'),
    });
  });
  (debtRows || []).forEach((row) => {
    items.push({
      id: `debt_${row.id || row.external_id || Math.random()}`,
      date: firstDefined(row.created_at, row.updated_at),
      type: ['ADVANCE'].includes(safeUpper(row.status)) ? 'AVANS' : 'BORXH',
      description: row.note || row.handoff_note || row.client_name || 'Lëvizje borxhi',
      amount: amountOf(row),
      status: safeUpper(row.status || 'BORXH'),
      tone: surfaceTone(row.status || 'BORXH'),
    });
  });
  return items.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()).slice(0, 20);
}
async function fetchMyUser(pin) {
  const cleanPin = String(pin || '').trim();
  const tables = ['users', 'tepiha_users'];
  let merged = null;
  for (const table of tables) {
    try {
      const { data, error } = await supabase.from(table).select('*').eq('pin', cleanPin).limit(1).maybeSingle();
      if (error) throw error;
      if (data) merged = { ...(merged || {}), ...data };
    } catch {
      // ignore per-table failures and keep best effort merge
    }
  }
  return merged || null;
}

async function fetchMyPayments(pin) {
  try {
    const { data, error } = await supabase.from('arka_pending_payments').select('*').eq('created_by_pin', String(pin || '').trim()).order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    return data || [];
  } catch {
    return [];
  }
}
async function fetchMyHandoffs(pin) {
  try {
    const { data, error } = await supabase.from('cash_handoffs').select('*').eq('worker_pin', String(pin || '').trim()).order('submitted_at', { ascending: false }).limit(100);
    if (error) throw error;
    return data || [];
  } catch {
    return [];
  }
}
async function fetchMyOrders(table, pin) {
  try {
    const { data, error } = await supabase.from(table).select('*').order('updated_at', { ascending: false }).limit(300);
    if (error) throw error;
    return (data || []).filter((row) => matchesPin(row, pin));
  } catch {
    return [];
  }
}
function StatCard({ label, value, sub, accent = 'neutral' }) {
  const tone = colorForTone(accent);
  return (
    <div className="statCard surface">
      <div className="statLabel">{label}</div>
      <div className="statValue" style={{ color: tone.fg }}>{value}</div>
      {sub ? <div className="statSub">{sub}</div> : null}
    </div>
  );
}
export default function LlogariaImePage() {
  const router = useRouter();
  const [actor, setActor] = useState(null);
  const [tab, setTab] = useState('PERMBLEDHJE');
  const [loading, setLoading] = useState(true);
  const [userRow, setUserRow] = useState(null);
  const [payments, setPayments] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [debtRows, setDebtRows] = useState([]);
  const [orders, setOrders] = useState([]);
  const [transportOrders, setTransportOrders] = useState([]);

  useEffect(() => {
    const a = getActor();
    if (!a?.pin) {
      router.replace('/');
      return;
    }
    setActor(a);
  }, [router]);

  useEffect(() => {
    if (!actor?.pin) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const [u, pays, hands, debts, ord, tOrd] = await Promise.all([
          fetchMyUser(actor.pin),
          fetchMyPayments(actor.pin),
          fetchMyHandoffs(actor.pin),
          listWorkerDebtRows(actor.pin).catch(() => []),
          fetchMyOrders('orders', actor.pin),
          fetchMyOrders('transport_orders', actor.pin),
        ]);
        if (!alive) return;
        setUserRow(u || null);
        setPayments(Array.isArray(pays) ? pays : []);
        setHandoffs(Array.isArray(hands) ? hands : []);
        setDebtRows(Array.isArray(debts) ? debts : []);
        setOrders(Array.isArray(ord) ? ord : []);
        setTransportOrders(Array.isArray(tOrd) ? tOrd : []);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [actor?.pin]);

  const summary = useMemo(() => {
    const salary = n(userRow?.salary);
    const bonusTransport = n(userRow?.bonus_transport);
    const bonusUshqim = n(userRow?.bonus_ushqim);
    const isHybridTransport = userRow?.is_hybrid_transport === true;
    const commissionRateM2 = n(firstDefined(userRow?.commission_rate_m2, 0.5));
    const manualAdvance = n(userRow?.avans_manual);
    const longDebt = n(userRow?.borxh_afatgjat);
    const advancesOnly = (debtRows || []).filter((x) => safeUpper(x.status) === 'ADVANCE').reduce((s, x) => s + amountOf(x), 0);
    const debtOnly = (debtRows || []).filter((x) => safeUpper(x.status) !== 'ADVANCE').reduce((s, x) => s + amountOf(x), 0);
    const debtRowsTotal = (debtRows || []).reduce((s, row) => s + amountOf(row), 0);
    const advances = Math.max(manualAdvance, advancesOnly || 0, manualAdvance + advancesOnly);
    const debt = Math.max(longDebt, debtOnly || 0, longDebt + debtOnly);
    const deliveredTransportOrders = (transportOrders || []).filter((x) => ['DORZIM', 'DORZUAR'].includes(statusOf(x)));
    const deliveredTransportM2 = deliveredTransportOrders.reduce((s, row) => s + m2Of(row), 0);
    const transportCommission = isHybridTransport ? deliveredTransportM2 * commissionRateM2 : 0;
    const neto = salary + bonusTransport + bonusUshqim + transportCommission - advances - debt;

    const cashToday = (payments || []).filter((x) => isToday(x.created_at)).reduce((s, x) => s + amountOf(x), 0);
    const inHand = (payments || []).filter((x) => ['PENDING', 'COLLECTED'].includes(safeUpper(x.status))).reduce((s, x) => s + amountOf(x), 0);
    const handed = (payments || []).filter((x) => ['ACCEPTED_BY_DISPATCH', 'APPROVED'].includes(safeUpper(x.status))).reduce((s, x) => s + amountOf(x), 0)
      + (handoffs || []).filter((x) => safeUpper(x.status) === 'ACCEPTED').reduce((s, x) => s + amountOf(x), 0);

    const allOrders = [...orders, ...transportOrders];
    const active = allOrders.filter((x) => !['DORZIM', 'DORZUAR'].includes(statusOf(x))).length;
    const gati = allOrders.filter((x) => statusOf(x) === 'GATI').length;
    const deliveredToday = allOrders.filter((x) => {
      const status = statusOf(x);
      const deliveredAt = firstDefined(x.delivered_at, x?.data?.delivered_at, x?.data?.deliveredAt, x.updated_at);
      return ['DORZIM', 'DORZUAR'].includes(status) && isToday(deliveredAt);
    }).length;
    return {
      salary,
      bonusTransport,
      bonusUshqim,
      isHybridTransport,
      commissionRateM2,
      deliveredTransportM2,
      transportCommission,
      advances,
      debt,
      neto,
      debtRowsTotal,
      cashToday,
      inHand,
      handed,
      active,
      gati,
      deliveredToday,
      transportCount: transportOrders.filter((x) => !['DORZIM', 'DORZUAR'].includes(statusOf(x))).length,
    };
  }, [userRow, debtRows, payments, handoffs, orders, transportOrders]);

  const history = useMemo(() => buildHistory(payments, handoffs, debtRows), [payments, handoffs, debtRows]);
  const netTone = summary.neto > 0 ? 'ok' : summary.neto < 0 ? 'bad' : 'neutral';
  const hasTransportBonus = n(summary.bonusTransport) > 0;
  const hasUshqimBonus = n(summary.bonusUshqim) > 0;
  const hasHybridCommission = summary.isHybridTransport === true;
  const hasAnyBonus = hasTransportBonus || hasUshqimBonus || hasHybridCommission;
  if (!actor?.pin) return null;

  return (
    <div className="walletPage">
      <div className="hero">
        <div>
          <div className="eyebrow">PANEL PERSONAL</div>
          <h1>LLOGARIA IME</h1>
          <p>RROGA • AVANSET • BORXHET • CASH</p>
        </div>
        <Link href="/" className="backBtn">← HOME</Link>
      </div>
      <div className="surface userStrip">
        <div>
          <div className="userName">{actor?.name || 'PËRDORUES'}</div>
          <div className="userMeta">PIN {actor?.pin || '—'} • {safeUpper(actor?.role || 'USER')}</div>
        </div>
        <button className="refreshBtn" onClick={() => window.location.reload()}>RIFRESKO</button>
      </div>
      <div className="segmented surface">
        {['PERMBLEDHJE', 'CASH', 'HISTORIA'].map((key) => (
          <button key={key} type="button" className={`segBtn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {key === 'PERMBLEDHJE' ? 'PËRMBLEDHJE' : key === 'CASH' ? 'CASH & POROSI' : 'HISTORIA'}
          </button>
        ))}
      </div>
      {loading ? <div className="surface loadingCard">DUKE NGARKUAR TË DHËNAT...</div> : null}
      {!loading && tab === 'PERMBLEDHJE' ? (
        <div className="stack">
          <div className="grid three summaryTopGrid">
            <StatCard label="RROGA BAZË" value={fmt(summary.salary)} sub="Rroga bazë" accent="neutral" />
            {hasTransportBonus ? <StatCard label="BONUS TRANSPORT" value={fmt(summary.bonusTransport)} sub="Shtesë transporti" accent="ok" /> : null}
            {hasUshqimBonus ? <StatCard label="BONUS USHQIM" value={fmt(summary.bonusUshqim)} sub="P.sh. 3€/ditë" accent="ok" /> : null}
            {hasHybridCommission ? <StatCard label="KOMISIONI TRANSPORTIT" value={fmt(summary.transportCommission)} sub={`${summary.deliveredTransportM2.toFixed(2)} m² × ${fmt(summary.commissionRateM2)}/m²`} accent="ok" /> : null}
            <StatCard label="AVANSET" value={fmt(summary.advances)} sub="Aktive / manuale" accent="warn" />
            <StatCard label="BORXHI" value={fmt(summary.debt)} sub="Borxh aktual" accent="bad" />
            <StatCard label="NETO AKTUALE" value={fmt(summary.neto)} sub={hasAnyBonus ? 'Bazë + bonuse - avanse - borxhe' : 'Rroga - avanse - borxhe'} accent={netTone} />
          </div>
          <div className="surface panel">
            <div className="panelHead"><div><h3>GJENDJA AKTUALE</h3><p>Përmbledhje e saktë e rrogës, bonuseve dhe detyrimeve të tua.</p></div></div>
            <div className="detailRows">
              <div className="detailRow"><span>Rroga bazë</span><strong>{fmt(summary.salary)}</strong></div>
              {hasTransportBonus ? <div className="detailRow"><span>Bonus transport</span><strong>{fmt(summary.bonusTransport)}</strong></div> : null}
              {hasUshqimBonus ? <div className="detailRow"><span>Bonus ushqim</span><strong>{fmt(summary.bonusUshqim)}</strong></div> : null}
              {hasHybridCommission ? <div className="detailRow"><span>Komisioni transportit</span><strong>{fmt(summary.transportCommission)}</strong></div> : null}
              {hasHybridCommission ? <div className="detailRow"><span>Baza komisioni</span><strong>{summary.deliveredTransportM2.toFixed(2)} m² × {fmt(summary.commissionRateM2)}/m²</strong></div> : null}
              <div className="detailRow"><span>Avans manual</span><strong>{fmt(n(userRow?.avans_manual))}</strong></div>
              <div className="detailRow"><span>Borxh afatgjatë</span><strong>{fmt(n(userRow?.borxh_afatgjat))}</strong></div>
              <div className="detailRow"><span>Lëvizje borxhi/avansi</span><strong>{fmt(summary.debtRowsTotal)}</strong></div>
              <div className="detailRow totalRow"><span>{hasAnyBonus ? 'NETO = RROGA + BONUS TRANSPORT + BONUS USHQIM + KOMISION TRANSPORTI - AVANSE - BORXHE' : 'NETO = RROGA - AVANSE - BORXHE'}</span><strong>{fmt(summary.neto)}</strong></div>
            </div>
          </div>
        </div>
      ) : null}
      {!loading && tab === 'CASH' ? (
        <div className="stack">
          <div className="grid three">
            <StatCard label="CASH SOT" value={fmt(summary.cashToday)} sub="I mbledhur sot" accent="ok" />
            <StatCard label="NË DORË" value={fmt(summary.inHand)} sub="PENDING / COLLECTED" accent="warn" />
            <StatCard label="DORËZUAR" value={fmt(summary.handed)} sub="Handoff / approved" accent="ok" />
          </div>
          <div className="grid four">
            <StatCard label="AKTIVE" value={String(summary.active)} sub="Porosi në punë" accent="neutral" />
            <StatCard label="GATI" value={String(summary.gati)} sub="Gati për dalje" accent="ok" />
            <StatCard label="TRANSPORT" value={String(summary.transportCount)} sub="T-kode aktive" accent="warn" />
            <StatCard label="DORËZUAR SOT" value={String(summary.deliveredToday)} sub="Të mbyllura sot" accent="neutral" />
          </div>
          <div className="surface panel">
            <div className="panelHead"><div><h3>POROSITË E MIA</h3><p>Vetëm porositë që lidhen me PIN-in tënd.</p></div></div>
            <div className="orderSummaryGrid">
              {[...orders, ...transportOrders].slice(0, 8).map((row, idx) => {
                const st = statusOf(row) || '—';
                const tone = colorForTone(surfaceTone(st));
                const code = firstDefined(row.code, row.client_tcode, row?.data?.code, row?.data?.client_tcode, row?.id, `#${idx + 1}`);
                return (
                  <div key={String(row.id || idx)} className="orderChip" style={{ borderColor: tone.bd, background: tone.bg }}>
                    <div className="orderCode">{String(code)}</div>
                    <div className="orderStatus" style={{ color: tone.fg }}>{st}</div>
                  </div>
                );
              })}
              {![...orders, ...transportOrders].length ? <div className="emptyText">Nuk u gjet asnjë porosi e lidhur me PIN-in tënd.</div> : null}
            </div>
          </div>
        </div>
      ) : null}
      {!loading && tab === 'HISTORIA' ? (
        <div className="surface panel">
          <div className="panelHead"><div><h3>HISTORIA E LËVIZJEVE</h3><p>20 rekordet e fundit të lidhura me PIN-in tënd.</p></div></div>
          <div className="historyList">
            {history.map((item) => {
              const tone = colorForTone(item.tone);
              return (
                <div key={item.id} className="historyRow">
                  <div className="historyLeft">
                    <div className="historyType">{item.type}</div>
                    <div className="historyDesc">{item.description || '—'}</div>
                    <div className="historyDate">{normalizeDate(item.date)}</div>
                  </div>
                  <div className="historyRight">
                    <div className="historyAmount">{fmt(item.amount)}</div>
                    <div className="statusPill" style={{ background: tone.bg, borderColor: tone.bd, color: tone.fg }}>{item.status}</div>
                  </div>
                </div>
              );
            })}
            {!history.length ? <div className="emptyText">Nuk ka lëvizje për të shfaqur.</div> : null}
          </div>
        </div>
      ) : null}
      <style jsx>{`
        .walletPage { min-height: 100vh; background: #000; color: #fff; padding: 18px 14px 36px; }
        .surface { background: #151518; border-radius: 22px; box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 10px 28px rgba(0,0,0,.28); }
        .hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
        .eyebrow { font-size: 11px; letter-spacing: 1.4px; opacity: .6; font-weight: 800; margin-bottom: 6px; }
        h1 { margin: 0; font-size: 32px; line-height: 1; font-weight: 1000; letter-spacing: -.03em; }
        .hero p { margin: 8px 0 0; color: rgba(255,255,255,.58); font-size: 12px; font-weight: 700; letter-spacing: .8px; }
        .backBtn, .refreshBtn { text-decoration: none; border: 1px solid rgba(255,255,255,.1); color: #fff; background: rgba(255,255,255,.04); border-radius: 14px; padding: 12px 14px; font-weight: 800; font-size: 12px; }
        .refreshBtn { cursor: pointer; }
        .userStrip { padding: 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
        .userName { font-size: 18px; font-weight: 900; }
        .userMeta { font-size: 12px; color: rgba(255,255,255,.58); font-weight: 700; margin-top: 4px; }
        .segmented { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 6px; margin-bottom: 14px; }
        .segBtn { border: 0; background: transparent; color: rgba(255,255,255,.58); font-size: 12px; font-weight: 900; border-radius: 14px; padding: 12px 10px; }
        .segBtn.active { color: #fff; background: linear-gradient(180deg, rgba(99,102,241,.28), rgba(59,130,246,.18)); box-shadow: inset 0 1px 0 rgba(255,255,255,.06); }
        .loadingCard, .panel { padding: 16px; }
        .stack { display: flex; flex-direction: column; gap: 12px; }
        .grid { display: grid; gap: 12px; }
        .grid.four { grid-template-columns: repeat(2, 1fr); }
        .grid.three { grid-template-columns: repeat(3, 1fr); }
        .statCard { padding: 16px; min-height: 112px; display: flex; flex-direction: column; justify-content: space-between; }
        .statLabel { font-size: 11px; font-weight: 900; letter-spacing: 1px; color: rgba(255,255,255,.58); }
        .statValue { font-size: 26px; line-height: 1.05; font-weight: 1000; letter-spacing: -.03em; margin-top: 12px; word-break: break-word; }
        .statSub { font-size: 11px; color: rgba(255,255,255,.5); font-weight: 700; margin-top: 10px; }
        .panelHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
        .panelHead h3 { margin: 0; font-size: 18px; font-weight: 900; }
        .panelHead p { margin: 6px 0 0; font-size: 12px; color: rgba(255,255,255,.56); font-weight: 700; }
        .detailRows { display: flex; flex-direction: column; gap: 10px; }
        .detailRow { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid rgba(255,255,255,.06); }
        .detailRow:first-child { border-top: 0; padding-top: 0; }
        .detailRow span { color: rgba(255,255,255,.62); font-size: 13px; font-weight: 700; }
        .detailRow strong { font-size: 15px; }
        .orderSummaryGrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
        .orderChip { border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 12px; }
        .orderCode { font-size: 16px; font-weight: 900; }
        .orderStatus { margin-top: 6px; font-size: 12px; font-weight: 800; }
        .historyList { display: flex; flex-direction: column; gap: 10px; }
        .historyRow { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 0; border-top: 1px solid rgba(255,255,255,.06); }
        .historyRow:first-child { border-top: 0; padding-top: 0; }
        .historyType { font-size: 11px; font-weight: 900; letter-spacing: 1px; color: rgba(255,255,255,.5); }
        .historyDesc { margin-top: 4px; font-size: 14px; font-weight: 800; }
        .historyDate { margin-top: 6px; font-size: 11px; color: rgba(255,255,255,.48); font-weight: 700; }
        .historyRight { text-align: right; min-width: 116px; }
        .historyAmount { font-size: 16px; font-weight: 900; }
        .statusPill { margin-top: 8px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,.08); border-radius: 999px; padding: 6px 10px; font-size: 10px; font-weight: 900; letter-spacing: .8px; }
        .emptyText { color: rgba(255,255,255,.52); font-size: 13px; font-weight: 700; padding: 10px 4px; }
.totalRow { border-top-color: rgba(99,102,241,.28); margin-top: 4px; padding-top: 14px; }
        .totalRow span, .totalRow strong { color: #e5e7eb; }
        .summaryTopGrid :global(.statCard) { min-height: 118px; }
        @media (max-width: 760px) { .grid.three { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
