// /assets/pranimi_drafts.only.js
// Shows only incomplete PRANIMI orders from Supabase and links back to continue editing

async function loadDrafts() {
  const list = document.getElementById('drafts_list');
  const stats = document.getElementById('drafts_stats');
  list.innerHTML = '<div style="padding:20px;opacity:.6">Duke lexuar...</div>';

  try {
    // read from Supabase (status pranim or null, and missing pieces/total/m2)
    const rows = await select('orders', {
      select: '*',
      order: 'created_at.desc'
    });

    // filter only incomplete (still in pranim, or total 0)
    const drafts = rows.filter(r =>
      !r.status || r.status === 'pranim' ||
      r.m2 === 0 || r.pieces === 0 || r.total === 0
    );

    if (!drafts.length) {
      list.innerHTML = '<div style="padding:20px;opacity:.6">Nuk ka pranime të paplotësuara.</div>';
      stats.textContent = '';
      return;
    }

    stats.innerHTML = `<div style="padding:8px 12px;opacity:.8">
      ${drafts.length} klientë të paplotësuar
    </div>`;

    list.innerHTML = drafts.map(r => `
      <div class="card">
        <div style="font-size:1.2rem;font-weight:900;margin-bottom:4px">
          ${r.code ? '#'+r.code : ''} ${r.name || ''}
        </div>
        <div style="font-size:.95rem;opacity:.85">
          ${r.phone || ''} &nbsp; | &nbsp;
          ${Number(r.m2||0).toFixed(2)} m² · ${r.pieces||0} copë
        </div>
        <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center">
          <div style="font-weight:900;color:#1e60ff">${Number(r.total||0).toFixed(2)} €</div>
          <a href="../pranimi/?id=${r.id}" class="btn">▶ VAZHDO NË PRANIMI</a>
        </div>
      </div>
    `).join('');

  } catch (err) {
    list.innerHTML = `<div style="color:#ffb3b3;padding:20px