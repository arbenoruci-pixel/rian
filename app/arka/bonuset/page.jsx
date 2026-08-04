'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { getActor } from '@/lib/actorSession';
import {
  BASE_READY_BONUS_RATE_M2,
  BASE_READY_BONUS_WINDOW_HOURS,
  canManageBaseReadyBonuses,
  getBaseReadyBonusSummary,
  isBaseReadyBonusWorkerRole,
} from '@/lib/baseReadyBonusClient';
import useRouteAlive from '@/lib/routeAlive';

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const M2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

function euro(value) {
  const n = Number(value || 0);
  return `${MONEY.format(Number.isFinite(n) ? n : 0)} €`;
}

function m2(value) {
  const n = Number(value || 0);
  return `${M2.format(Number.isFinite(n) ? n : 0)} m²`;
}

function todayKey() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Belgrade',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDays(key, days) {
  const clean = String(key || todayKey()).slice(0, 10);
  const [y, m, d] = clean.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + Number(days || 0), 12));
  return next.toISOString().slice(0, 10);
}

function dateLabel(key) {
  const [y, m, d] = String(key || '').split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

function stamp(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: 'Europe/Belgrade',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function toneForStatus(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'RETAINED') return 'ok';
  if (value.includes('RESERVED') || value.includes('PARTIAL')) return 'warn';
  if (value === 'EARNED') return 'info';
  if (value === 'VOIDED' || value === 'REVIEW_REQUIRED') return 'bad';
  return 'muted';
}

function statusLabel(status, eligible) {
  const value = String(status || '').toUpperCase();
  if (!eligible || value === 'INELIGIBLE') return 'PA BONUS';
  if (value === 'EARNED') return 'PËR ME MBAJT';
  if (value === 'PARTIAL_RESERVED') return 'PJESËRISHT NË DORËZIM';
  if (value === 'RESERVED') return 'NË DORËZIM';
  if (value === 'PARTIAL_RETAINED') return 'PJESËRISHT E MBAJTUR';
  if (value === 'RETAINED') return 'E MBAJTUR';
  if (value === 'VOIDED') return 'ANULUAR';
  if (value === 'REVIEW_REQUIRED') return 'KËRKON KONTROLL';
  return value || '—';
}

function Stat({ label, value, sub = '', tone = 'neutral' }) {
  return (
    <div className={`bonusStat ${tone}`}>
      <div className="bonusStatLabel">{label}</div>
      <div className="bonusStatValue">{value}</div>
      {sub ? <div className="bonusStatSub">{sub}</div> : null}
    </div>
  );
}

function WorkerCard({ worker, active, onClick }) {
  return (
    <button type="button" className={`bonusWorkerCard ${active ? 'active' : ''}`} onClick={onClick}>
      <div>
        <div className="bonusWorkerName">{String(worker?.name || worker?.pin || 'PUNËTOR').toUpperCase()}</div>
        <div className="bonusSmall">PIN {worker?.pin || '—'} • {worker?.today_orders || 0} POROSI SOT</div>
      </div>
      <div className="bonusWorkerMoney">
        <b>{euro(worker?.today_earned)}</b>
        <span>PËR ME MBAJT {euro(worker?.available_to_keep)}</span>
      </div>
    </button>
  );
}

export default function ArkaBonusetPage() {
  useRouteAlive('arka_base_ready_bonuses_page');
  const [actor, setActor] = useState(null);
  const [dateKey, setDateKey] = useState(() => todayKey());
  const [workerPin, setWorkerPin] = useState('ALL');
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastLiveAt, setLastLiveAt] = useState('');
  const inFlightRef = useRef(false);

  const role = String(actor?.role || '').toUpperCase();
  const canManage = canManageBaseReadyBonuses(role);
  const isWorker = isBaseReadyBonusWorkerRole(role);
  const allowed = !!actor?.pin && (canManage || isWorker);

  useEffect(() => {
    const current = getActor() || null;
    setActor(current);
    if (current?.pin && !canManageBaseReadyBonuses(current?.role)) setWorkerPin(String(current.pin));
  }, []);

  async function load({ quiet = false } = {}) {
    if (!actor?.pin || inFlightRef.current) return;
    inFlightRef.current = true;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const target = canManage ? (workerPin || 'ALL') : String(actor.pin);
      const data = await getBaseReadyBonusSummary({
        actorPin: actor.pin,
        workerPin: target,
        date: dateKey,
        allowCache: true,
      });
      setSummary(data);
      setLastLiveAt(data?.generated_at || new Date().toISOString());
    } catch (e) {
      setError(String(e?.message || e || 'NUK U NGARKUA BONUSI 48H.'));
    } finally {
      inFlightRef.current = false;
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return undefined;
    }
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load({ quiet: true });
    }, 30000);
    const onFocus = () => void load({ quiet: true });
    const onOnline = () => void load({ quiet: true });
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [actor?.pin, role, dateKey, workerPin]);

  const totals = summary?.totals || {};
  const workers = Array.isArray(summary?.workers) ? summary.workers : [];
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const selectedWorker = useMemo(() => workers.find((row) => String(row?.pin) === String(workerPin)) || null, [workers, workerPin]);
  const visibleTotals = selectedWorker || totals;

  if (!actor?.pin) {
    return (
      <div className="bonusPage"><div className="bonusShell"><h1>BONUSI 48H</h1><div className="bonusError">HYR NË APP PËR TA HAPUR KËTË FAQE.</div><Link href="/login" className="bonusBtn">LOGIN</Link></div></div>
    );
  }

  if (!allowed) {
    return (
      <div className="bonusPage"><div className="bonusShell"><h1>BONUSI 48H</h1><div className="bonusError">KJO PAMJE ËSHTË PËR PUNËTORËT E BAZËS DHE DISPATCH.</div><Link href="/arka" className="bonusBtn">KTHEHU NË ARKË</Link></div></div>
    );
  }

  return (
    <div className="bonusPage">
      <div className="bonusShell">
        <header className="bonusHeader">
          <div>
            <div className="bonusEyebrow">ARKA • BAZA</div>
            <h1>BONUSI 48H</h1>
            <p>{BASE_READY_BONUS_RATE_M2.toFixed(2)}€ për m² • porosia BAZA • GATI brenda {BASE_READY_BONUS_WINDOW_HOURS} orëve • bonus në pagesën e plotë</p>
          </div>
          <div className="bonusNav">
            <Link href="/arka" className="bonusBtn ghost">ARKA</Link>
            <Link href="/pastrimi" className="bonusBtn ghost">PASTRIMI</Link>
            <button type="button" className="bonusBtn" onClick={() => load()} disabled={loading}>REFRESH</button>
          </div>
        </header>

        <section className="bonusDateBar">
          <button type="button" onClick={() => setDateKey((value) => addDays(value, -1))}>‹</button>
          <button type="button" className="dateMain" onClick={() => setDateKey(todayKey())}>{dateLabel(dateKey)}{dateKey === todayKey() ? ' • SOT' : ''}</button>
          <button type="button" onClick={() => setDateKey((value) => addDays(value, 1))}>›</button>
          <input type="date" value={dateKey} onChange={(event) => setDateKey(event.target.value || todayKey())} />
        </section>

        {summary?._offlineSnapshot ? <div className="bonusOffline">OFFLINE • SNAPSHOT I FUNDIT{summary?._cachedAt ? ` • ${stamp(summary._cachedAt)}` : ''}</div> : null}
        {lastLiveAt && !summary?._offlineSnapshot ? <div className="bonusLive">LIVE NGA DB • {stamp(lastLiveAt)} • rifreskohet çdo 30 sekonda</div> : null}
        {error ? <div className="bonusError">{error}</div> : null}
        {loading && !summary ? <div className="bonusLoading">DUKE NGARKUAR BONUSIN...</div> : null}

        {summary ? (
          <>
            <section className="bonusStats">
              <Stat label="SOT" value={euro(visibleTotals?.today_earned)} sub={`${visibleTotals?.today_orders || 0} porosi • ${m2(visibleTotals?.today_m2)}`} tone="ok" />
              <Stat label="MUAJI" value={euro(visibleTotals?.month_earned)} sub={`${visibleTotals?.month_orders || 0} porosi • ${m2(visibleTotals?.month_m2)}`} tone="info" />
              <Stat label="MUNDESH ME MBAJT" value={euro(visibleTotals?.available_to_keep)} sub="hiqet automatikisht nga dorëzimi" tone="strong" />
              <Stat label="NË DORËZIM" value={euro(visibleTotals?.reserved)} sub="pret pranimin e Dispatch" tone="warn" />
              <Stat label="E MBAJTUR" value={euro(visibleTotals?.retained_total)} sub="handoff i pranuar" tone="neutral" />
            </section>

            {canManage ? (
              <section className="bonusPanel">
                <div className="bonusPanelHead">
                  <div><h2>PUNËTORËT</h2><p>Zgjedhe një punëtor ose shiko totalin e krejt bazës.</p></div>
                  <button type="button" className={`bonusWorkerAll ${workerPin === 'ALL' ? 'active' : ''}`} onClick={() => setWorkerPin('ALL')}>TË GJITHË</button>
                </div>
                <div className="bonusWorkerList">
                  {workers.map((worker) => <WorkerCard key={worker.pin} worker={worker} active={String(workerPin) === String(worker.pin)} onClick={() => setWorkerPin(String(worker.pin))} />)}
                </div>
              </section>
            ) : null}

            <section className="bonusPanel">
              <div className="bonusPanelHead">
                <div>
                  <h2>{selectedWorker ? String(selectedWorker.name || selectedWorker.pin).toUpperCase() : canManage ? 'POROSITË E DITËS' : String(actor?.name || 'POROSITË E MIA').toUpperCase()}</h2>
                  <p>Bonusi i takon PIN-it që regjistron pagesën që e mbyll porosinë. GATI brenda 48 orëve mbetet kushti i kualifikimit.</p>
                </div>
                <div className="bonusCount">{rows.length} RRESHTA</div>
              </div>

              <div className="bonusRows">
                {rows.length ? rows.map((row) => (
                  <article key={row.id} className="bonusRow">
                    <div className="bonusRowTop">
                      <div>
                        <div className="bonusOrder">#{row.order_code || '—'} — {String(row.client_name || 'KLIENT').toUpperCase()}</div>
                        <div className="bonusSmall">{canManage ? `${String(row.worker_name || row.worker_pin || '').toUpperCase()} • PIN ${row.worker_pin || '—'} • ` : ''}PAGESA ${stamp(row.activated_at || row.ready_at)}</div>
                      </div>
                      <div className={`bonusStatus ${toneForStatus(row.status)}`}>{statusLabel(row.status, row.eligible)}</div>
                    </div>
                    <div className="bonusRowGrid">
                      <div><span>METRA</span><b>{m2(row.m2)}</b></div>
                      <div><span>KOHA</span><b>{Number(row.elapsed_hours || 0).toFixed(1)}h</b></div>
                      <div><span>BONUSI</span><b>{euro(row.amount)}</b></div>
                      <div><span>PËR ME MBAJT</span><b>{euro(row.remaining_amount)}</b></div>
                    </div>
                    {!row.eligible ? <div className="bonusReason">Arsye: {String(row.reason || 'MBI 48 ORË').replaceAll('_', ' ')}</div> : null}
                  </article>
                )) : <div className="bonusEmpty">S’KA POROSI TË PËRFUNDUARA PËR KËTË DATË.</div>}
              </div>
            </section>

            <section className="bonusInfo">
              <b>SI FUNKSIONON</b>
              <span>Vetëm porositë BAZA. Transporti nuk hyn në këtë bonus.</span>
              <span>Një porosi paguhet vetëm një herë. PIN-i që regjistron pagesën e plotë merr 0.10€ për m² kur porosia është bërë GATI brenda 48 orëve.</span>
              <span>Bonusi shfaqet pasi pagesa e mbyll porosinë. Shuma “MUNDESH ME MBAJT” zbritet automatikisht nga cash-i që i dërgohet Dispatch dhe teprica bartet për dorëzimin tjetër.</span>
            </section>
          </>
        ) : null}
      </div>

      <style>{`
        .bonusPage{min-height:100vh;background:#05070d;color:#f8fafc;padding:14px 8px 90px;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.bonusShell{width:min(840px,100%);margin:0 auto}.bonusHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:14px;border:1px solid rgba(96,165,250,.28);border-radius:20px;background:linear-gradient(145deg,rgba(30,64,175,.24),rgba(15,23,42,.92));box-shadow:0 18px 50px rgba(0,0,0,.35)}.bonusEyebrow{font-size:10px;font-weight:1000;letter-spacing:.17em;color:#93c5fd}.bonusHeader h1{margin:5px 0 4px;font-size:30px;line-height:1;font-weight:1000}.bonusHeader p,.bonusPanel p{margin:0;color:#94a3b8;font-size:12px;line-height:1.4;font-weight:750}.bonusNav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px}.bonusBtn,.bonusDateBar button,.bonusWorkerAll{border:1px solid rgba(96,165,250,.4);border-radius:12px;background:#2563eb;color:#fff;text-decoration:none;padding:10px 12px;font-size:11px;font-weight:1000;cursor:pointer}.bonusBtn.ghost{background:rgba(15,23,42,.7);border-color:rgba(148,163,184,.25)}.bonusDateBar{display:grid;grid-template-columns:42px 1fr 42px minmax(130px,180px);gap:6px;margin:10px 0}.bonusDateBar button,.bonusDateBar input{min-height:42px;border-radius:12px;border:1px solid rgba(148,163,184,.24);background:#0f172a;color:#fff;font-weight:900;padding:8px}.bonusDateBar .dateMain{background:rgba(30,64,175,.25)}.bonusOffline,.bonusLive,.bonusError,.bonusLoading{padding:10px 12px;border-radius:12px;margin-bottom:9px;font-size:11px;font-weight:900}.bonusOffline{background:rgba(245,158,11,.13);border:1px solid rgba(245,158,11,.3);color:#fde68a}.bonusLive{background:rgba(34,197,94,.10);border:1px solid rgba(34,197,94,.24);color:#bbf7d0}.bonusError{background:rgba(239,68,68,.13);border:1px solid rgba(239,68,68,.32);color:#fecaca}.bonusLoading{background:rgba(59,130,246,.12);color:#bfdbfe}.bonusStats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;margin-bottom:10px}.bonusStat{padding:11px;border:1px solid rgba(148,163,184,.18);border-radius:15px;background:rgba(15,23,42,.82);min-width:0}.bonusStat.ok{border-color:rgba(34,197,94,.34);background:rgba(22,101,52,.18)}.bonusStat.info{border-color:rgba(59,130,246,.34)}.bonusStat.strong{border-color:rgba(250,204,21,.42);background:rgba(113,63,18,.22)}.bonusStat.warn{border-color:rgba(245,158,11,.34)}.bonusStatLabel{font-size:9px;font-weight:1000;letter-spacing:.08em;color:#94a3b8}.bonusStatValue{margin-top:4px;font-size:22px;line-height:1;font-weight:1000;white-space:nowrap}.bonusStatSub{margin-top:6px;font-size:9px;line-height:1.25;color:#94a3b8;font-weight:750}.bonusPanel{padding:12px;border:1px solid rgba(148,163,184,.18);border-radius:17px;background:rgba(15,23,42,.76);margin-bottom:10px}.bonusPanelHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}.bonusPanel h2{margin:0 0 3px;font-size:15px;font-weight:1000}.bonusWorkerAll{background:rgba(51,65,85,.76)}.bonusWorkerAll.active{background:#2563eb}.bonusWorkerList{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.bonusWorkerCard{display:flex;justify-content:space-between;align-items:center;gap:10px;text-align:left;padding:10px;border-radius:14px;border:1px solid rgba(148,163,184,.18);background:rgba(2,6,23,.55);color:#fff;cursor:pointer}.bonusWorkerCard.active{border-color:#60a5fa;background:rgba(30,64,175,.25)}.bonusWorkerName{font-size:12px;font-weight:1000}.bonusSmall{margin-top:3px;font-size:9.5px;color:#94a3b8;font-weight:800}.bonusWorkerMoney{text-align:right;display:grid;gap:3px}.bonusWorkerMoney b{font-size:16px}.bonusWorkerMoney span{font-size:8px;color:#fde68a;font-weight:900}.bonusCount{padding:5px 8px;border-radius:999px;background:rgba(96,165,250,.15);color:#bfdbfe;font-size:9px;font-weight:1000}.bonusRows{display:grid;gap:7px}.bonusRow{padding:11px;border-radius:14px;border:1px solid rgba(148,163,184,.16);background:rgba(2,6,23,.54)}.bonusRowTop{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.bonusOrder{font-size:13px;font-weight:1000}.bonusStatus{padding:4px 7px;border-radius:999px;font-size:8px;font-weight:1000;white-space:nowrap}.bonusStatus.ok{background:rgba(34,197,94,.17);color:#bbf7d0}.bonusStatus.warn{background:rgba(245,158,11,.17);color:#fde68a}.bonusStatus.info{background:rgba(59,130,246,.17);color:#bfdbfe}.bonusStatus.bad{background:rgba(239,68,68,.17);color:#fecaca}.bonusStatus.muted{background:rgba(100,116,139,.17);color:#cbd5e1}.bonusRowGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:9px}.bonusRowGrid>div{padding:7px;border-radius:10px;background:rgba(15,23,42,.82);display:grid;gap:3px}.bonusRowGrid span{font-size:8px;color:#94a3b8;font-weight:1000}.bonusRowGrid b{font-size:12px}.bonusReason{margin-top:7px;color:#fca5a5;font-size:9px;font-weight:800}.bonusEmpty{padding:20px;text-align:center;color:#94a3b8;font-size:11px;font-weight:900}.bonusInfo{display:grid;gap:5px;padding:12px;border-radius:15px;border:1px solid rgba(250,204,21,.22);background:rgba(113,63,18,.13);font-size:10px;line-height:1.4;color:#fde68a}.bonusInfo b{font-size:11px}.bonusInfo span{color:#d6d3d1}@media(max-width:700px){.bonusHeader{display:grid}.bonusNav{justify-content:flex-start}.bonusStats{grid-template-columns:repeat(2,minmax(0,1fr))}.bonusStat.strong{grid-column:1/-1}.bonusWorkerList{grid-template-columns:1fr}.bonusRowGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:430px){.bonusPage{padding-left:5px;padding-right:5px}.bonusDateBar{grid-template-columns:38px 1fr 38px}.bonusDateBar input{grid-column:1/-1}.bonusHeader h1{font-size:26px}.bonusStatValue{font-size:20px}}
      `}</style>
    </div>
  );
}

// BASE_PAYMENT_48H_BONUS_V2:BONUS_PAGE
