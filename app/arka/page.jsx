'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { handoffActorPendingCash, listPendingCashForActor, listWorkerOwedPayments } from '@/lib/arkaCashSync';
import { supabase } from '@/lib/supabaseClient';

function HubTile({ href, icon, title, desc, accent = '#0f172a' }) {
  return (
    <Link href={href} className="hubTile" style={{ textDecoration: 'none' }}>
      <div className="hubTileIconWrap" style={{ background: `${accent}12` }}>
        <div className="hubTileIcon" aria-hidden="true">{icon}</div>
      </div>

      <div className="hubTileBody">
        <div className="hubTileTitle">{title}</div>
        <div className="hubTileDesc">{desc}</div>
      </div>

      <div className="hubTileArrow" aria-hidden="true">›</div>
    </Link>
  );
}

function readJson(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeName(v) {
  return String(v || '').trim().toUpperCase();
}

function normalizePin(v) {
  return String(v || '').trim();
}

function money(n) {
  return `€${Number(n || 0).toFixed(2)}`;
}

function matchActorRow(row, actor) {
  const rowPin = normalizePin(row?.created_by_pin || row?.pin || row?.advance_by_pin || row?.rejected_by_pin);
  const actorPin = normalizePin(actor?.pin);
  if (rowPin && actorPin && rowPin === actorPin) return true;

  const rowName = normalizeName(
    row?.created_by_name ||
    row?.name ||
    row?.worker_name ||
    row?.advance_by_name ||
    row?.rejected_by_name
  );
  const actorName = normalizeName(actor?.name);
  return !!rowName && !!actorName && rowName === actorName;
}

function getLocalUsers() {
  const raw = readJson('tepiha_users_v1', []);
  return Array.isArray(raw) ? raw : [];
}

function getLocalPendingRows() {
  const rows = [];
  const seen = new Set();

  const pushRow = (item, orderId = null) => {
    const eid = String(item?.external_id || item?.externalId || '').trim();
    if (!eid || seen.has(eid)) return;
    rows.push({ ...item, external_id: eid, order_id: orderId || item?.order_id || null });
    seen.add(eid);
  };

  const lsPending = readJson('arka_pending_payments_v1', []);
  if (Array.isArray(lsPending)) {
    lsPending.forEach((item) => pushRow(item));
  }

  const localOrders = readJson('tepiha_local_orders_v1', []);
  if (Array.isArray(localOrders)) {
    localOrders.forEach((order) => {
      const pends = order?.data?.pay?.pendingCash || order?.pay?.pendingCash || [];
      if (Array.isArray(pends)) pends.forEach((item) => pushRow(item, order?.id || order?.local_oid || null));
    });
  }

  return rows;
}

async function loadActorProfile(actor) {
  const pin = normalizePin(actor?.pin);
  const current = actor || null;

  if (!pin) {
    return {
      name: current?.name || 'PUNËTORI',
      pin: pin || '—',
      salary: Number(current?.salary || 0) || 0,
      avans_manual: Number(current?.avans_manual || 0) || 0,
      borxh_afatgjat: Number(current?.borxh_afatgjat || 0) || 0,
    };
  }

  try {
    const { data } = await supabase
      .from('users')
      .select('id,name,pin,role,salary,avans_manual,borxh_afatgjat')
      .eq('pin', pin)
      .maybeSingle();

    if (data) {
      return {
        ...data,
        salary: Number(data?.salary || 0) || 0,
        avans_manual: Number(data?.avans_manual || 0) || 0,
        borxh_afatgjat: Number(data?.borxh_afatgjat || 0) || 0,
      };
    }
  } catch {}

  const cached = getLocalUsers().find((u) => normalizePin(u?.pin) === pin) || current || {};
  return {
    ...cached,
    name: cached?.name || current?.name || 'PUNËTORI',
    pin: pin,
    salary: Number(cached?.salary || current?.salary || 0) || 0,
    avans_manual: Number(cached?.avans_manual || current?.avans_manual || 0) || 0,
    borxh_afatgjat: Number(cached?.borxh_afatgjat || current?.borxh_afatgjat || 0) || 0,
  };
}

async function loadAdvanceRows(actor, limit = 200) {
  const items = [];
  const seen = new Set();
  const add = (row) => {
    const eid = String(row?.external_id || row?.externalId || `${row?.created_at || ''}_${row?.amount || ''}`).trim();
    if (!eid || seen.has(eid)) return;
    items.push({ ...row, external_id: eid });
    seen.add(eid);
  };

  try {
    const pin = normalizePin(actor?.pin);
    const name = normalizeName(actor?.name);
    let query = supabase
      .from('arka_pending_payments')
      .select('*')
      .eq('status', 'ADVANCE')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (pin) query = query.eq('created_by_pin', pin);
    const { data } = await query;

    if (Array.isArray(data) && data.length) {
      data.filter((row) => matchActorRow(row, actor) || normalizeName(row?.created_by_name) === name).forEach(add);
      if (items.length) return items;
    }
  } catch {}

  getLocalPendingRows()
    .filter((row) => String(row?.status || '').toUpperCase() === 'ADVANCE')
    .filter((row) => matchActorRow(row, actor))
    .forEach(add);

  return items.slice(0, limit);
}

async function loadDebtRows(actor, limit = 200) {
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    const eid = String(row?.external_id || row?.externalId || `${row?.created_at || ''}_${row?.amount || ''}`).trim();
    if (!eid || seen.has(eid)) return;
    rows.push({ ...row, external_id: eid });
    seen.add(eid);
  };

  try {
    const byName = await listWorkerOwedPayments(actor?.name, limit);
    if (Array.isArray(byName?.rows)) {
      byName.rows.filter((row) => matchActorRow(row, actor)).forEach(add);
    }
  } catch {}

  if (!rows.length) {
    getLocalPendingRows()
      .filter((row) => ['REJECTED', 'OWED', 'WORKER_DEBT'].includes(String(row?.status || row?.type || '').toUpperCase()) || String(row?.type || '').toUpperCase() === 'WORKER_DEBT')
      .filter((row) => matchActorRow(row, actor))
      .forEach(add);
  }

  return rows.slice(0, limit);
}

function RowList({ rows, emptyText, tone = 'light' }) {
  if (!rows.length) return <div className={`emptyBox ${tone}`}>{emptyText}</div>;
  return (
    <div className="miniList">
      {rows.map((row) => (
        <div key={row.external_id || row.id} className={`miniRow ${tone}`}>
          <div>
            <div className="miniRowTitle">{row.client_name || row.order_code || row.note || 'VEPRIM'}</div>
            <div className="miniRowSub">
              {row.order_code ? `KODI ${row.order_code}` : (row.note || 'Pa shënim')}
              {row.created_at ? ` • ${new Date(row.created_at).toLocaleDateString('sq-AL')}` : ''}
            </div>
          </div>
          <div className="miniRowAmt">{money(row.amount || 0)}</div>
        </div>
      ))}
    </div>
  );
}

export default function ArkaPage() {
  const [actor, setActor] = useState(null);
  const [mine, setMine] = useState([]);
  const [profile, setProfile] = useState(null);
  const [advanceRows, setAdvanceRows] = useState([]);
  const [debtRows, setDebtRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const liveActor = actor || getActor();
  const isAdmin = String(liveActor?.role || '').toLowerCase() === 'admin';

  async function refreshMine(a = null) {
    const act = a || getActor();
    setActor(act || null);
    const pin = normalizePin(act?.pin);
    if (!pin) {
      setMine([]);
      return;
    }

    const res = await listPendingCashForActor(pin, 200);
    const base = Array.isArray(res?.items)
      ? res.items.filter((x) => ['PENDING', 'COLLECTED'].includes(String(x?.status || '').toUpperCase()))
      : [];

    const extra = getLocalPendingRows().filter((row) => {
      const st = String(row?.status || '').toUpperCase();
      return ['PENDING', 'COLLECTED'].includes(st) && matchActorRow(row, act);
    });

    const seen = new Set();
    const merged = [];
    [...base, ...extra].forEach((item) => {
      const eid = String(item?.external_id || item?.externalId || '').trim();
      if (!eid || seen.has(eid)) return;
      merged.push(item);
      seen.add(eid);
    });

    setMine(merged);
  }

  async function refreshAll() {
    const act = getActor();
    setActor(act || null);
    setLoading(true);
    try {
      await refreshMine(act);
      if (act && String(act?.role || '').toLowerCase() !== 'admin') {
        const [nextProfile, nextAdvanceRows, nextDebtRows] = await Promise.all([
          loadActorProfile(act),
          loadAdvanceRows(act),
          loadDebtRows(act),
        ]);
        setProfile(nextProfile || null);
        setAdvanceRows(Array.isArray(nextAdvanceRows) ? nextAdvanceRows : []);
        setDebtRows(Array.isArray(nextDebtRows) ? nextDebtRows : []);
      } else {
        setProfile(null);
        setAdvanceRows([]);
        setDebtRows([]);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refreshAll(); }, []);

  const myTotal = useMemo(() => mine.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0), [mine]);
  const advancesTotal = useMemo(() => advanceRows.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0), [advanceRows]);
  const debtsTotal = useMemo(() => {
    const dynamic = debtRows.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0);
    return dynamic + (Number(profile?.borxh_afatgjat || 0) || 0);
  }, [debtRows, profile]);

  async function onHandoff() {
    if (!actor?.pin) return alert('Mungon PIN-i i punëtorit.');
    if (myTotal <= 0) return alert('Arka jote është 0€.');
    const ok = window.confirm(`A don me i dorëzu ${myTotal.toFixed(2)}€ te bosi?`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await handoffActorPendingCash({ actor });
      if (!res?.ok) throw new Error(res?.error || 'Dështoi dorëzimi');
      await refreshAll();
      alert(`U dorëzuan ${Number(res.total || 0).toFixed(2)}€.`);
    } catch (e) {
      alert(e?.message || 'Gabim gjatë dorëzimit.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="arkaHubPage">
      <div className="arkaHubShell">
        <div className="arkaHubTop">
          <div>
            <div className="arkaEyebrow">ARKA / HUB</div>
            <h1 className="arkaTitle">{isAdmin ? 'Menu Kryesore e Arkës' : 'Dashboard Personal i Arkës'}</h1>
            <p className="arkaSubtitle">
              {isAdmin
                ? 'Zgjidh sektorin që dëshiron të menaxhosh. Faqe e pastër, e lehtë dhe pa lëmsh listash.'
                : 'Këtu shfaqen vetëm të dhënat e tua personale. Totale globale, shpenzime të kompanisë dhe rrogat e të tjerëve janë të fshehura.'}
            </p>
          </div>

          <Link href="/" className="homeBtn">
            ← HOME
          </Link>
        </div>

        <div className="myArkaCard">
          <div className="myArkaHead">
            <div>
              <div className="myArkaEyebrow">ARKA IME</div>
              <div className="myArkaName">{actor?.name || 'PUNËTORI'}</div>
              <div className="myArkaMeta">PIN: {actor?.pin || '—'}</div>
            </div>
            <div className="myArkaAmount">€{Number(myTotal || 0).toFixed(2)}</div>
          </div>
          <button className="handoffBtn" disabled={busy || myTotal <= 0} onClick={onHandoff}>DORËZO PARET TE BOSI</button>
          <div className="myArkaList">
            {mine.length ? mine.slice(0, 6).map((x) => (
              <div key={x.external_id || x.id} className="myArkaRow">
                <div>
                  <div className="myArkaRowTitle">{x.client_name || x.order_code || 'PAGESË CASH'}</div>
                  <div className="myArkaRowSub">{x.order_code ? `KODI ${x.order_code}` : (x.note || 'Pa shënim')}</div>
                </div>
                <div className="myArkaRowAmt">€{Number(x.amount || 0).toFixed(2)}</div>
              </div>
            )) : <div className="myArkaEmpty">S’ke pagesa cash të padorëzuara.</div>}
          </div>
        </div>

        {isAdmin ? (
          <>
            <div className="heroCard">
              <div className="heroBadge">LIGHT UI</div>
              <div className="heroHeading">Hub i ri për Stafin, Payroll-in dhe Shpenzimet</div>
              <div className="heroText">
                Kjo faqe tani shërben vetëm si menu kryesore. Nuk shfaq më lista punëtorësh, rroga apo llogaritje.
              </div>
            </div>

            <div className="hubGrid">
              <HubTile
                href="/arka/stafi"
                icon="👥"
                title="MENAXHIMI I STAFIT"
                desc="Pajisjet në pritje, krijimi/editimi i stafit, rolet, PIN-et dhe statusi aktiv/joaktiv."
                accent="#0f766e"
              />

              <HubTile
                href="/arka/payroll"
                icon="💸"
                title="PAYROLL & RROGAT"
                desc="Rroga bazë, dita e rrogës, avanset, borxhet afatgjata dhe Smart Payroll."
                accent="#2563eb"
              />

              <HubTile
                href="/arka/shpenzime"
                icon="🧾"
                title="SHPENZIMET"
                desc="Daljet cash, regjistrimi i shpenzimeve dhe historiku i lëvizjeve të shpenzimeve."
                accent="#c2410c"
              />
            </div>
          </>
        ) : (
          <>
            <div className="heroCard">
              <div className="heroBadge">READ ONLY</div>
              <div className="heroHeading">Dashboard Personal</div>
              <div className="heroText">
                Punëtori sheh vetëm arkat e veta, rrogën e vet dhe listën e avanseve/borxheve. Logjika offline vazhdon të përdorë fallback nga localStorage dhe backup-et te orders.data kur databaza nuk kthehet.
              </div>
            </div>

            <div className="personalGrid">
              <div className="personalCard">
                <div className="cardEyebrow">RROGA IME</div>
                <div className="metricAmount">{money(profile?.salary || 0)}</div>
                <div className="metricSub">Vlera aktuale e rrogës tënde.</div>
              </div>

              <div className="personalCard">
                <div className="cardEyebrow">AVANSET E MIA</div>
                <div className="metricAmount amber">{money((profile?.avans_manual || 0) + advancesTotal)}</div>
                <div className="metricSub">Avanse manuale + avanse të regjistruara në histori.</div>
                <RowList rows={advanceRows.slice(0, 6)} emptyText="S’ka avanse të regjistruara për ty." tone="warm" />
              </div>

              <div className="personalCard">
                <div className="cardEyebrow">BORXHET E MIA</div>
                <div className="metricAmount red">{money(debtsTotal)}</div>
                <div className="metricSub">Përfshin borxhin afatgjatë dhe borxhet aktive nga arkëtimi.</div>
                {Number(profile?.borxh_afatgjat || 0) > 0 ? (
                  <div className="longDebtBox">BORXH AFATGJATË: {money(profile?.borxh_afatgjat || 0)}</div>
                ) : null}
                <RowList rows={debtRows.slice(0, 6)} emptyText="S’ka borxhe aktive për ty." tone="danger" />
              </div>
            </div>
          </>
        )}
      </div>

      <style jsx>{`
        .arkaHubPage {
          min-height: 100vh;
          background:
            radial-gradient(circle at top left, rgba(191, 219, 254, 0.35), transparent 28%),
            radial-gradient(circle at top right, rgba(167, 243, 208, 0.22), transparent 24%),
            #f8fafc;
          color: #0f172a;
          padding: 28px 16px 40px;
          font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }

        .arkaHubShell {
          max-width: 1120px;
          margin: 0 auto;
        }

        .arkaHubTop {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
          flex-wrap: wrap;
          margin-bottom: 18px;
        }

        .arkaEyebrow {
          font-size: 12px;
          line-height: 1;
          font-weight: 900;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #64748b;
          margin-bottom: 10px;
        }

        .arkaTitle {
          margin: 0;
          font-size: clamp(30px, 4vw, 46px);
          line-height: 0.98;
          letter-spacing: -0.05em;
          font-weight: 900;
          color: #0f172a;
        }

        .arkaSubtitle {
          margin: 12px 0 0;
          max-width: 760px;
          color: #475569;
          font-size: 15px;
          line-height: 1.55;
        }

        .homeBtn {
          text-decoration: none;
          background: rgba(255, 255, 255, 0.95);
          color: #0f172a;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 13px 18px;
          font-weight: 800;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
          transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
        }

        .homeBtn:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 22px rgba(15, 23, 42, 0.08);
          border-color: #cbd5e1;
        }

        .myArkaCard {
          background: #0f172a;
          color: #fff;
          border-radius: 28px;
          padding: 22px;
          border: 1px solid rgba(255,255,255,0.08);
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
          margin-bottom: 20px;
        }
        .myArkaHead { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap; }
        .myArkaEyebrow { font-size: 11px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.55); }
        .myArkaName { margin-top: 8px; font-size: 24px; font-weight: 900; line-height: 1; }
        .myArkaMeta { margin-top: 6px; font-size: 13px; color: rgba(255,255,255,0.62); }
        .myArkaAmount { font-size: clamp(28px, 4vw, 42px); font-weight: 900; letter-spacing: -0.04em; }
        .handoffBtn { margin-top: 16px; width: 100%; border: none; border-radius: 18px; padding: 16px 18px; background: linear-gradient(180deg, #22c55e, #16a34a); color: #fff; font-size: 16px; font-weight: 900; cursor: pointer; }
        .handoffBtn:disabled { opacity: 0.45; cursor: not-allowed; }
        .myArkaList { margin-top: 14px; display: grid; gap: 10px; }
        .myArkaRow { display:flex; justify-content:space-between; gap:12px; align-items:center; padding: 11px 12px; border-radius: 16px; background: rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.06); }
        .myArkaRowTitle { font-size: 14px; font-weight: 800; }
        .myArkaRowSub { margin-top: 3px; font-size: 12px; color: rgba(255,255,255,0.58); }
        .myArkaRowAmt { font-size: 16px; font-weight: 900; white-space: nowrap; }
        .myArkaEmpty { padding: 12px; border-radius: 14px; background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.72); font-size: 13px; }

        .heroCard {
          background: rgba(255, 255, 255, 0.94);
          border: 1px solid rgba(226, 232, 240, 0.95);
          border-radius: 28px;
          padding: 24px;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
          margin-bottom: 20px;
        }

        .heroBadge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 30px;
          padding: 0 12px;
          border-radius: 999px;
          background: #eff6ff;
          color: #1d4ed8;
          border: 1px solid #bfdbfe;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }

        .heroHeading {
          margin-top: 14px;
          font-size: clamp(22px, 2.8vw, 34px);
          line-height: 1.02;
          letter-spacing: -0.04em;
          font-weight: 900;
          color: #0f172a;
        }

        .heroText {
          margin-top: 10px;
          color: #64748b;
          font-size: 15px;
          line-height: 1.6;
          max-width: 720px;
        }

        .hubGrid,
        .personalGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 18px;
        }

        .hubTile,
        .personalCard {
          min-height: 160px;
          padding: 22px;
          border-radius: 28px;
          background: rgba(255, 255, 255, 0.96);
          border: 1px solid #e2e8f0;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
        }

        .hubTile {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 16px;
          align-items: center;
          transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
        }

        .hubTile:hover {
          transform: translateY(-2px);
          box-shadow: 0 18px 34px rgba(15, 23, 42, 0.08);
          border-color: #cbd5e1;
        }

        .hubTileIconWrap {
          width: 74px;
          height: 74px;
          border-radius: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }

        .hubTileIcon {
          font-size: 34px;
          line-height: 1;
        }

        .hubTileBody {
          min-width: 0;
        }

        .hubTileTitle {
          font-size: 22px;
          line-height: 1.05;
          letter-spacing: -0.035em;
          font-weight: 900;
          color: #0f172a;
        }

        .hubTileDesc {
          margin-top: 10px;
          color: #64748b;
          font-size: 14px;
          line-height: 1.6;
        }

        .hubTileArrow {
          font-size: 34px;
          line-height: 1;
          color: #94a3b8;
          font-weight: 500;
        }

        .cardEyebrow {
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #64748b;
          margin-bottom: 10px;
        }

        .metricAmount {
          font-size: clamp(28px, 3vw, 38px);
          line-height: 1;
          font-weight: 900;
          letter-spacing: -0.04em;
          color: #0f172a;
        }

        .metricAmount.amber { color: #b45309; }
        .metricAmount.red { color: #b91c1c; }

        .metricSub {
          margin-top: 8px;
          color: #64748b;
          font-size: 14px;
          line-height: 1.55;
        }

        .miniList {
          margin-top: 14px;
          display: grid;
          gap: 10px;
        }

        .miniRow {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          padding: 12px;
          border-radius: 16px;
          border: 1px solid #e2e8f0;
        }

        .miniRow.light { background: #f8fafc; }
        .miniRow.warm { background: #fffbeb; border-color: #fde68a; }
        .miniRow.danger { background: #fef2f2; border-color: #fecaca; }

        .miniRowTitle { font-size: 14px; font-weight: 800; color: #0f172a; }
        .miniRowSub { margin-top: 3px; font-size: 12px; color: #64748b; }
        .miniRowAmt { white-space: nowrap; font-size: 15px; font-weight: 900; color: #0f172a; }

        .emptyBox {
          margin-top: 14px;
          padding: 12px;
          border-radius: 16px;
          font-size: 13px;
          color: #64748b;
          background: #f8fafc;
          border: 1px dashed #cbd5e1;
        }

        .emptyBox.warm { background: #fffbeb; border-color: #fde68a; }
        .emptyBox.danger { background: #fef2f2; border-color: #fecaca; }

        .longDebtBox {
          margin-top: 14px;
          padding: 11px 12px;
          border-radius: 14px;
          background: #fff7ed;
          border: 1px solid #fdba74;
          color: #9a3412;
          font-size: 13px;
          font-weight: 800;
        }

        @media (max-width: 980px) {
          .hubGrid,
          .personalGrid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 640px) {
          .arkaHubPage {
            padding: 18px 12px 30px;
          }

          .heroCard,
          .hubTile,
          .personalCard {
            border-radius: 22px;
          }

          .hubTile {
            grid-template-columns: 1fr;
            align-items: flex-start;
          }

          .hubTileArrow {
            display: none;
          }

          .hubTileIconWrap {
            width: 64px;
            height: 64px;
            border-radius: 18px;
          }

          .homeBtn {
            width: 100%;
            text-align: center;
          }

          .arkaHubTop {
            gap: 14px;
          }
        }
      `}</style>
    </div>
  );
}
