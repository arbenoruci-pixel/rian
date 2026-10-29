import React from 'react';

export default function GatiExactOpenNotice({ exactMode, code, state, filteredOut, onRetry, onShowAll }) {
  if (filteredOut) return <div role="status"><p>Porosia është fshehur nga filtri i lajmërimeve.</p><button onClick={onShowAll}>Shfaq porosinë</button></div>;
  if (!exactMode) return <p style={{ textAlign: 'center' }}>Nuk ka porosi GATI.</p>;
  const row = state?.row;
  const status = String(row?.status || '').trim();
  const message = state?.kind === 'offline'
    ? 'Porosia nuk është në listën e ruajtur në telefon. Lidhu me internet dhe provo përsëri.'
    : state?.kind === 'error' || !state
      ? 'Porosia nuk u verifikua në server. Provo përsëri.'
      : state?.blocked && status === 'gati'
        ? 'Kjo pajisje e ka shënuar pagesën ose dorëzimin, por serveri ende e ka porosinë GATI. Kontrollo sinkronizimin para një pagese tjetër.'
        : row && status !== 'gati'
          ? `Porosia tani ka statusin ${status.toUpperCase() || 'E PANJOHUR'} dhe nuk është më në GATI.`
          : 'Porosia nuk u gjet në listën GATI. Rifresko për ta kontrolluar përsëri.';
  const rack = row?.data?.ready_location || row?.data?.ready_note || '';
  return <div role="status" style={{ padding: 12, lineHeight: 1.5 }}>
    <strong>Porosia #{row?.code || code || '—'}{row?.client_name ? ` · ${row.client_name}` : ''}</strong>
    {rack && <div>Rafti: {rack}</div>}
    <p>{message}</p>
    <button type="button" onClick={onRetry}>Kontrollo përsëri</button>
  </div>;
}
