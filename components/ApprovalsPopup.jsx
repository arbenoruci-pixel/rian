'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { listPendingRequestsForApprover, approveRequest, rejectRequest } from '@/lib/arkaRequestsDb';
import { isAdmin, isDispatch } from '@/lib/roles';

const euro = (n) =>
  `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })}`;

function readUser() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Tiny global notifier for expense/advance approvals.
// - Workers create requests in /arka/shpenzime
// - Admin/Dispatch will see a popup and can Approve/Reject without re-entering PIN
export default function ApprovalsPopup() {
  const [user, setUser] = useState(null);
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pollRef = useRef(null);

  const canApprove = useMemo(() => {
    const role = user?.role;
    return !!user?.pin && (isAdmin(role) || isDispatch(role));
  }, [user?.pin, user?.role]);

  async function loadOnce(u = user) {
    if (!u?.pin || !canApprove) return;
    try {
      const rows = await listPendingRequestsForApprover(u.pin, 50);
      const next = rows || [];
      setItems(next);
      setErr('');
      if (next.length > 0) setOpen(true);
    } catch (e) {
      // non-blocking
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    // attach user
    const u = readUser();
    setUser(u);
  }, []);

  useEffect(() => {
    if (!canApprove) return;

    loadOnce();

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      loadOnce();
    }, 10000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canApprove]);

  const top = items?.[0] || null;
  if (!canApprove || !top) return null;

  async function onApprove() {
    if (!top?.id) return;
    setBusy(true);
    setErr('');
    try {
      await approveRequest({
        request_id: top.id,
        approver_pin: user.pin,
        approver_name: user.name,
        approver_role: user.role,
      });
      await loadOnce(user);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    if (!top?.id) return;
    setBusy(true);
    setErr('');
    try {
      await rejectRequest({
        request_id: top.id,
        approver_pin: user.pin,
        approver_name: user.name,
        approver_role: user.role,
      });
      await loadOnce(user);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Small bell */}
      <button
        onClick={() => setOpen(true)}
        title="KËRKESA PËR APROVIM"
        style={{
          position: 'fixed',
          top: 10,
          right: 10,
          zIndex: 9998,
          borderRadius: 999,
          padding: '8px 10px',
          border: '1px solid rgba(255,255,255,.16)',
          background: 'rgba(0,0,0,.55)',
          color: 'rgba(255,255,255,.92)',
          fontWeight: 900,
          letterSpacing: 2,
          textTransform: 'uppercase',
          transform: 'scale(.85)',
          transformOrigin: 'top right',
        }}
      >
        APROVIM ({items.length})
      </button>

      {/* Modal */}
      {open ? (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0,0,0,.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 14,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(520px, 100%)',
              borderRadius: 18,
              border: '1px solid rgba(255,255,255,.14)',
              background: 'rgba(10,10,10,.96)',
              padding: 14,
              textTransform: 'uppercase',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
              <div style={{ fontWeight: 950, letterSpacing: 3 }}>KËRKESË PËR APROVIM</div>
              <button
                onClick={() => setOpen(false)}
                style={{
                  borderRadius: 12,
                  padding: '10px 12px',
                  border: '1px solid rgba(255,255,255,.14)',
                  background: 'rgba(255,255,255,.06)',
                  fontWeight: 900,
                  letterSpacing: 2,
                }}
              >
                MBYLL
              </button>
            </div>

            <div style={{ marginTop: 10, borderRadius: 14, border: '1px solid rgba(255,255,255,.10)', padding: 12, background: 'rgba(0,0,0,.35)' }}>
              <div style={{ fontWeight: 950, letterSpacing: 2 }}>
                {euro(top.amount)} • {String(top.req_type || '').toUpperCase()} • {String(top.source || '').toUpperCase()}
              </div>
              <div style={{ opacity: 0.8, fontWeight: 900, letterSpacing: 1, marginTop: 6 }}>
                KËRKOI: {String(top.requested_by_name || 'PUNTOR').toUpperCase()} • PIN {String(top.requested_by_pin || '')}
              </div>
              {top.reason ? (
                <div style={{ opacity: 0.8, fontWeight: 900, letterSpacing: 1, marginTop: 6 }}>
                  ARSYE: {String(top.reason)}
                </div>
              ) : null}
            </div>

            {err ? (
              <div style={{ marginTop: 10, borderRadius: 12, border: '2px solid rgba(255,80,80,.35)', background: 'rgba(255,0,0,.08)', padding: 10, fontWeight: 950, letterSpacing: 2 }}>
                {err}
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button
                disabled={busy}
                onClick={onReject}
                style={{
                  flex: 1,
                  borderRadius: 14,
                  padding: 12,
                  border: '1px solid rgba(255,80,80,.35)',
                  background: 'rgba(255,80,80,.10)',
                  fontWeight: 950,
                  letterSpacing: 2,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                REFUZO
              </button>
              <button
                disabled={busy}
                onClick={onApprove}
                style={{
                  flex: 1,
                  borderRadius: 14,
                  padding: 12,
                  border: '1px solid rgba(0,255,170,.30)',
                  background: 'rgba(0,255,170,.10)',
                  fontWeight: 950,
                  letterSpacing: 2,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                APROVO
              </button>
            </div>

            <div style={{ marginTop: 10, opacity: 0.7, fontSize: 10, letterSpacing: 2, fontWeight: 900 }}>
              ({items.length} NË PRITJE) • VETËM DISPATCH/ADMIN
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
