'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import supabase from '@/lib/supabaseClient';
import { getAllOrdersLocal, saveOrderLocal } from '@/lib/offlineStore';
import { recordCashMove } from '@/lib/arkaCashSync';

// 🔥 IMPORTUAR KËRKUESI I PIN-IT
import { requirePaymentPin } from '@/lib/paymentPin';

// --- CONFIG ---
const BUCKET = 'tepiha-photos';
const LOCAL_ORDERS_KEY = 'tepiha_local_orders_v1';
const OFFLINE_QUEUE_KEY = 'tepiha_offline_queue_v1';
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;
const PAY_CHIPS = [5, 10, 20, 30, 50];
const DAILY_CAPACITY_M2 = 400;
const STREAM_MAX_M2 = 450;

// Safari shpesh jep “Load failed” kur request-i varet gjatë.
// Ky helper e këput request-in pas 7 sekondash (si te baseCodes).
function withTimeout(promise, ms = 7000) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('TIMEOUT')), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      try { clearTimeout(t); } catch (e) {}
    }),
    timeout,
  ]);
}

// ---------------- HELPERS ----------------

  // supabase-js v2 / postgrest-js supports abortSignal(signal)
  try {
    if (q && typeof q.abortSignal === "function") {
      q.abortSignal(controller.signal);
    }
  } catch (e) {}

  const run = async () => {
    try {
      return await q;
    } finally {
      clearTimeout(t);
    }
  };

  return run();
}

export default function PastrimiPage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);

  // prevent multiple parallel loads / race updates
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!supabase || typeof supabase.channel !== 'function') return;
    const ch1 = supabase.channel('pastrim-live-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },
        async (payload) => {
          try {
            const row = payload?.new || payload?.old;
            if (row?.id) {
              await saveOrderLocal({
                id: row.id, status: normalizeStatus(row.status), data: row.data ?? null,
                updated_at: row.updated_at || row.ready_at || new Date().toISOString(), _synced: true, _table: 'orders',
              });
            }
          } catch {}
          refreshOrders();
        }
      ).subscribe();

    const ch2 = supabase.channel('pastrim-live-transport')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transport_orders' },
        async (payload) => {
          try {
            const row = payload?.new || payload?.old;
            if (row?.id) {
              await saveOrderLocal({
                id: row.id, status: normalizeStatus(row.status), data: row.data ?? null,
                updated_at: row.updated_at || row.ready_at || new Date().toISOString(), _synced: true, _table: 'transport_orders',
              });
            }
          } catch {}
          refreshOrders();
        }
      ).subscribe();

    const onFocus = () => refreshOrders();
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);

      try {
        if (!supabase || typeof supabase.from !== "function") {
          throw new Error("SUPABASE CLIENT MUNGON / IMPORT I GABUAR");
        }

      const { data: normalData, error: normalError } = await withTimeout(
        supabase
          .from('orders').select('id,status,created_at,data,code')
          .in('status', ['pastrim','pastrimi']).order('created_at', { ascending: false }).limit(300)
      );
      
      const { data: transportData, error: transError } = await withTimeout(
        supabase
          .from('transport_orders').select('id,status,created_at,data,code_str')
          .in('status', ['pastrim','pastrimi']).order('created_at', { ascending: false }).limit(300)
      );

        if (error) throw error;

      if (typeof window !== 'undefined') {
        setTimeout(async () => {
          for (const row of (normalData || [])) {
            await saveOrderLocal({ ...row, _synced: true, _local: false, _table: 'orders' });
          }
          for (const row of (transportData || [])) {
            await saveOrderLocal({ ...row, _synced: true, _local: false, _table: 'transport_orders' });
          }
        }, 500);
      }

      (normalData || []).forEach(row => {
        const order = unwrapOrderData(row.data);
        if (!Array.isArray(order.tepiha) && Array.isArray(order.tepihaRows)) order.tepiha = order.tepihaRows.map(r => ({ m2: Number(r?.m2)||0, qty: Number(r?.qty||r?.pieces)||0, photoUrl: r?.photoUrl||'' }));
        if (!Array.isArray(order.staza) && Array.isArray(order.stazaRows)) order.staza = order.stazaRows.map(r => ({ m2: Number(r?.m2)||0, qty: Number(r?.qty||r?.pieces)||0, photoUrl: r?.photoUrl||'' }));

        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const cope = (order.tepiha?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + (order.staza?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + (Number(order.shkallore?.qty)>0?1:0);

        allOrders.push({
          id: row.id, source: 'orders', ts: Number(order.ts || Date.parse(row.created_at) || 0) || 0,
          name: order.client?.name || order.client_name || '', phone: order.client?.phone || order.client_phone || '',
          code: normalizeCode(order.client?.code || order.code || row.code), m2: computeM2(order),
          cope, total, paid, isPaid: paid >= total && total > 0, isReturn: !!order?.returnInfo?.active, fullOrder: order
        });
      });

      (transportData || []).forEach(row => {
        const order = unwrapOrderData(row.data);
        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const cope = (order.tepiha?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + (order.staza?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + (Number(order.shkallore?.qty)>0?1:0);

        allOrders.push({
          id: row.id, source: 'transport_orders', ts: Number(order.created_at ? Date.parse(order.created_at) : (Date.parse(row.created_at) || 0)),
          name: order.client?.name || '', phone: order.client?.phone || '',
          code: normalizeCode(row.code_str || order.client?.code), m2: computeM2(order),
          cope, total, paid, isPaid: paid >= total && total > 0, isReturn: false, fullOrder: order
        });
      });

      allOrders.sort((a, b) => b.ts - a.ts);
      
      try {
        const locals = await readLocalOrdersByStatus('pastrim');
        const blacklist = getGhostBlacklist(); 
        
        for (const x of locals) {
          if (blacklist.includes(String(x.id))) continue; 
          
          const order = unwrapOrderData(x.fullOrder);
          const id = x.id;
          const codeKey = normalizeCode(order.client?.code || order.code || '');
          if (allOrders.some((o) => String(o.code) === String(codeKey))) continue;
          
          const total = Number(order.pay?.euro || 0);
          const paid = Number(order.pay?.paid || 0);
          const cope = (order.tepiha?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + (order.staza?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + (Number(order.shkallore?.qty)>0?1:0);
          allOrders.unshift({
            id, source: 'LOCAL', ts: Number(order.ts || x.ts || Date.now()),
            name: order.client?.name || '', phone: order.client?.phone || '', code: codeKey,
            m2: computeM2(order), cope, total, paid, isPaid: paid >= total && total > 0,
            isReturn: !!order?.returnInfo?.active, fullOrder: order, localOnly: true,
          });
        }
      } catch {}
      
      const cleanOrders = allOrders.filter(o => o.cope > 0 || o.m2 > 0 || (o.name && o.name.trim() !== ''));

      setOrders(cleanOrders);
      setDebugInfo({ source: 'DB', dbCount: (normalData||[]).length + (transportData||[]).length, localCount: cleanOrders.filter(o=>o.source==='LOCAL').length, online: true, lastError: null, ts: Date.now() });

      const streamTotal = cleanOrders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
      setStreamPastrimM2(Number(streamTotal.toFixed(2)));

      const today = dayKey(Date.now());
      const todayLoad = cleanOrders.filter(o => dayKey(o.ts) === today).reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
      setTodayPastrimM2(Number(todayLoad.toFixed(2)));

    } finally {
      setLoading(false);
    }
  }

  async function openEdit(item) {
    try {
      let ord = item.fullOrder;
      if (!ord) {
        if (item.source === 'orders' && item.raw_data) {
          ord = item.raw_data;
        } else {
          const { data, error } = await withTimeout(
            supabase.from(item.source).select('data').eq('id', item.id).single()
          );
          if (error || !data) throw new Error('Not found');
          ord = data.data;
          if (typeof ord === 'string') ord = JSON.parse(ord);
        }
      } catch (e) {
        // Abort in Safari often looks like generic fetch failure
        const msg =
          (e && (e.message || e.toString && e.toString())) ||
          "GABIM I PANJOHUR";
        if (aliveRef.current) setErr(msg);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    };
  }, []);

      setOid(String(item.id));
      setOrderSource(item.source);
      setOrigTs(ord.ts || Date.now());
      setCodeRaw(normalizeCode(item.code));

      setName(ord.client?.name || '');
      const p = String(ord.client?.phone || '');
      setPhone(p.startsWith(phonePrefix) ? p.slice(phonePrefix.length) : p.replace(/\D+/g, ''));
      setClientPhotoUrl(ord.client?.photoUrl || ord.client?.photo || '');

      setTepihaRows(ord.tepiha?.length ? ord.tepiha.map((x,i)=>({id:`t${i+1}`, m2:String(x.m2||''), qty:String(x.qty||''), photoUrl:x.photoUrl||''})) : [{id:'t1', m2:'', qty:'', photoUrl:''}]);
      setStazaRows(ord.staza?.length ? ord.staza.map((x,i)=>({id:`s${i+1}`, m2:String(x.m2||''), qty:String(x.qty||''), photoUrl:x.photoUrl||''})) : [{id:'s1', m2:'', qty:'', photoUrl:''}]);

      setStairsQty(Number(ord.shkallore?.qty)||0);
      setStairsPer(Number(ord.shkallore?.per)||SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl(ord.shkallore?.photoUrl||'');

      setPricePerM2(Number(ord.pay?.rate ?? ord.pay?.price ?? PRICE_DEFAULT));
      const paid = Number(ord.pay?.paid ?? 0);
      const method = ord.pay?.method || 'CASH';
      setClientPaid(paid);
      setPaidUpfront(!!ord.pay?.paidUpfront);
      setPayMethod(method);
      setArkaRecordedPaid(Number(ord.pay?.arkaRecordedPaid ?? (method==='CASH'?paid:0)));
      
      setNotes(ord.notes || '');

      const ri = ord?.returnInfo;
      setReturnActive(!!ri?.active);
      setReturnAt(Number(ri?.at || 0));
      setReturnReason(String(ri?.reason || ''));
      setReturnNote(String(ri?.note || ''));
      setReturnPhoto(String(ri?.photoUrl || ''));

      setPayAdd(0);
      setShowPaySheet(false);
      setShowStairsSheet(false);
      setEditMode(true);

    } catch (e) {
      alert('❌ Gabim gjatë hapjes!');
    }
  }

  function startLongPress(item) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => openEdit(item), 600);
  }
  function cancelLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const currentPaidAmount = Number((Number(clientPaid) || 0).toFixed(2));
      let finalArka = Number(arkaRecordedPaid) || 0;

      const order = {
        id: oid, ts: origTs, status: 'pastrim',
        client: { name: name.trim(), phone: phonePrefix + (phone || ''), code: normalizeCode(codeRaw), photoUrl: clientPhotoUrl || '' },
        tepiha: tepihaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: { m2: totalM2, rate: Number(pricePerM2) || PRICE_DEFAULT, euro: totalEuro, paid: currentPaidAmount, debt: currentDebt, paidUpfront: paidUpfront, method: payMethod, arkaRecordedPaid: finalArka },
        notes: notes || '',
        returnInfo: returnActive ? { active: true, at: returnAt, reason: returnReason, note: returnNote, photoUrl: returnPhoto } : undefined
      };

      const { error: dbErr } = await supabase.from(orderSource).update({ status: 'pastrim', data: order, updated_at: new Date().toISOString() }).eq('id', oid);
      if (dbErr) throw dbErr;

      setEditMode(false);
      await refreshOrders();
    } catch (e) {
      alert('❌ Gabim ruajtja: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  // 🔥 SHTUAR MESAZHI I RI KËTU
  async function handleMarkReady(o) {
    const btnId = `btn-${o.id}`;
    const btn = document.getElementById(btnId);
    if(btn) { btn.disabled = true; btn.innerText = "⏳..."; }

    try {
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const now = new Date().toISOString();

      setOrders(prev => prev.filter(x => x.id !== o.id));

      if (isOffline || o.source === 'LOCAL') {
        const { updateOrderStatus } = await import('@/lib/ordersDb');
        await updateOrderStatus(o.id, 'gati');
      } else {
        const table = o.source;
        const { data: currentRow, error: fetchErr } = await withTimeout(
          supabase.from(table).select('data').eq('id', o.id).single()
        );
        if (fetchErr) throw fetchErr;

        const updatedJson = { ...(currentRow.data || {}), status: 'gati', ready_at: now };

        if (table === 'transport_orders') {
          await supabase.from('transport_orders').update({ status: 'gati', data: updatedJson, updated_at: now, ready_at: now }).eq('id', o.id);
          alert(`✅ U bë GATI!\nShoferi u njoftua në listën e tij.`);
        } else {
          await supabase.from('orders').update({ status: 'gati', ready_at: now, data: updatedJson }).eq('id', o.id);
        }
      }

  // Realtime subscription (inside useEffect + guard)
  useEffect(() => {
    if (!supabase || typeof supabase.channel !== "function") return;

    const ch = supabase
      .channel("pastrim-live-orders")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        () => {
          // reload on any change
          loadOrders();
        }
      )
      .subscribe();

    return () => {
      try {
        supabase.removeChannel(ch);
      } catch (e) {}
    };
  }, [loadOrders]);

  return (
    <div className="page">
      <div className="header">
        <div className="title">PASTRIMI</div>
        <button className="btn" onClick={loadOrders} disabled={loading}>
          {loading ? "DUKE NGARKUAR…" : "REFRESH"}
        </button>
      </div>

      {err ? (
        <div className="error">
          <div className="errorTitle">GABIM</div>
          <div className="errorMsg">{String(err)}</div>
        </div>
      ) : null}

      <div className="list">
        {rows.length === 0 && !loading ? (
          <div className="empty">S’KA POROSI NË PASTRIM.</div>
        ) : null}

        {rows.map((r) => {
          const code = r?.code ?? r?.code_n ?? "—";
          const pieces = r?.pieces ?? r?.cope ?? r?.qty ?? "—";
          const total = r?.total ?? r?.shuma ?? r?.amount ?? "—";
          const name = r?.client_name ?? r?.name ?? r?.emri ?? "";

          return (
            <div key={r.id || `${code}-${Math.random()}`} className="row">
              <div className="left">
                <span className="code">{code}</span>
                <span className="name">{String(name || "").toUpperCase()}</span>
              </div>
              <div className="right">
                <span className="meta">{pieces} COPË</span>
                <span className="meta">€{total}</span>
              </div>
            </div>
          );
        })}
      </div>

      <style jsx>{`
        .page {
          padding: 14px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 12px;
        }
        .title {
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .btn {
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.06);
        }
        .btn:disabled {
          opacity: 0.6;
        }
        .error {
          padding: 12px;
          border-radius: 12px;
          border: 1px solid rgba(255, 80, 80, 0.35);
          background: rgba(255, 80, 80, 0.12);
          margin-bottom: 12px;
        }
        .errorTitle {
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 6px;
        }
        .errorMsg {
          opacity: 0.9;
          word-break: break-word;
        }
        .list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.05);
        }
        .left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .code {
          font-weight: 900;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          opacity: 0.95;
          white-space: nowrap;
        }
        .name {
          font-weight: 800;
          opacity: 0.9;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 56vw;
        }
        .right {
          display: flex;
          align-items: center;
          gap: 10px;
          white-space: nowrap;
        }
        .meta {
          font-weight: 800;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          opacity: 0.85;
        }
        .empty {
          padding: 14px;
          opacity: 0.7;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
      `}</style>
    </div>
  );
}