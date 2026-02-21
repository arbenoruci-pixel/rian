'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { acceptTask, completeTask, listMyOpenTasks, rejectTask } from '@/lib/tasksDb';

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

const NOT_READY_REASONS = ["N'PASTRIM", "N'THARJE", 'PROBLEM'];

export default function TaskInbox() {
  const [actor, setActor] = useState(null);
  const [task, setTask] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stage, setStage] = useState('VIEW'); // VIEW | OUTCOME | REJECT
  const [rejectReason, setRejectReason] = useState('');
  const [notReadyReason, setNotReadyReason] = useState('');
  const pollRef = useRef(null);

  useEffect(() => {
    setActor(jparse(localStorage.getItem('CURRENT_USER_DATA'), null));
  }, []);

  async function pollOnce() {
    try {
      if (!actor?.id) return;
      const res = await listMyOpenTasks(actor.id, 5);
      if (!res.ok) return;

      const items = res.items || [];
      const first = items.find((t) => t.status === 'SENT') || items[0] || null;

      if (first && (!task || task.id !== first.id)) {
        setTask(first);
        setStage('VIEW');
        setErr('');
        setRejectReason('');
        setNotReadyReason('');
      }
    } catch {}
  }

  useEffect(() => {
    if (!actor?.id) return;
    pollOnce();
    pollRef.current = setInterval(pollOnce, 5000);
    return () => pollRef.current && clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor?.id]);

  const header = useMemo(() => {
    if (!task) return null;
    const code = task.order_code ? `#${task.order_code}` : '';
    return `${task.title || 'TASK'} ${code}`.trim();
  }, [task]);

  if (!task) return null;

  async function onAccept() {
    setBusy(true);
    setErr('');
    try {
      const r = await acceptTask(task.id);
      if (!r.ok) throw r.error;
      setTask({ ...task, status: 'ACCEPTED' });
      setStage('OUTCOME');
    } catch {
      setErr('Nuk u pranua task-u.');
    } finally {
      setBusy(false);
    }
  }

  function onRejectStart() {
    setStage('REJECT');
    setRejectReason('');
    setErr('');
  }

  async function onRejectSend() {
    const reason = String(rejectReason || '').trim();
    if (!reason) {
      setErr('Shkruaj arsyen.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await rejectTask(task.id, reason);
      if (!r.ok) throw r.error;
      setTask(null);
    } catch {
      setErr('S’u dërgua REJECT.');
    } finally {
      setBusy(false);
    }
  }

  async function onDoneReady() {
    setBusy(true);
    setErr('');
    try {
      const r = await completeTask(task, 'READY', null);
      if (!r.ok) throw r.error;
      setTask(null);
    } catch {
      setErr('S’u krye task-u.');
    } finally {
      setBusy(false);
    }
  }

  async function onDoneNotReady() {
    const reason = String(notReadyReason || '').trim();
    if (!reason) {
      setErr('Zgjedh arsyen.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await completeTask(task, 'NOT_READY', reason);
      if (!r.ok) throw r.error;
      setTask(null);
    } catch {
      setErr('S’u krye task-u.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 9999,
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 520,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: 14,
        }}
      >
        <div style={{ fontWeight: 900, marginBottom: 8 }}>{header}</div>

        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginBottom: 10 }}>
          {task.body || '—'}
        </div>

        {err && <div style={{ marginBottom: 10, fontSize: 12, color: '#fca5a5', fontWeight: 800 }}>{err}</div>}

        {stage === 'VIEW' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={onAccept}>
              PRANO
            </button>
            <button className="btn secondary" style={{ flex: 1 }} disabled={busy} onClick={onRejectStart}>
              REJECT
            </button>
          </div>
        )}

        {stage === 'REJECT' && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6 }}>ARSYE (E DETYRUESHME)</div>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              style={{ width: '100%', marginBottom: 10 }}
              placeholder="Shkruaj shkurt arsyen..."
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn secondary" style={{ flex: 1 }} disabled={busy} onClick={() => setStage('VIEW')}>
                KTHEHU
              </button>
              <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={onRejectSend}>
                DËRGO
              </button>
            </div>
          </div>
        )}

        {stage === 'OUTCOME' && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 8 }}>REZULTATI</div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={onDoneReady}>
                DONE — GATI
              </button>
            </div>

            <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6 }}>NËSE S’ËSHTË GATI</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {NOT_READY_REASONS.map((lab) => (
                <button
                  key={lab}
                  className="btn secondary"
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    borderColor: notReadyReason === lab ? 'rgba(255,255,255,0.8)' : undefined,
                  }}
                  onClick={() => {
                    setNotReadyReason(lab);
                    setErr('');
                  }}
                >
                  {lab}
                </button>
              ))}
            </div>

            <button className="btn secondary" style={{ width: '100%' }} disabled={busy} onClick={onDoneNotReady}>
              DONE — NOT READY
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
