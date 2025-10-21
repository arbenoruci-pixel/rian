// /assets/pranimi.loadByCode.js — open an existing order by id/code (hard-lock edit mode)
// - Keeps the SAME code (no regeneration during edit)
// - Hydrates name, phone, €/m², pieces, and **PHOTOS** from orders.snap_items
// - Works with: /pranimi/?id=<order_id>  (preferred) or /pranimi/?code=<num>

(function () {
  /* ---------- tiny utils ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function qs(name) {
    var m = (location.search || '').match(new RegExp('[?&]' + name + '=([^&]+)'));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }
  async function waitReady() {
    const until = Date.now() + 8000;
    while (!(window.select && window.update && window.insert)) {
      if (Date.now() > until) break;
      await new Promise(r => setTimeout(r, 40));
    }
  }

  /* ---------- UI helpers for photo thumbs ---------- */
  function ensureRowThumb(row) {
    var btn = row && row.querySelector && row.querySelector('.cam-btn');
    if (!btn) return null;
    var img = btn.querySelector('.thumb');
    if (!img) {
      img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      img.style.position = 'absolute';
      img.style.inset = '0';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      img.style.borderRadius = '10px';
      img.style.display = 'none';
      img.style.zIndex = '2';
      btn.style.position = 'relative';
      btn.appendChild(img);
    }
    return img;
  }
  function setRowPhoto(row, url) {
    if (!url) return;
    var img = ensureRowThumb(row);
    if (img) { img.src = url; img.style.display = 'block'; }
  }

  /* ---------- normalize kinds ---------- */
  function normKind(k) {
    k = String(k || '').toLowerCase();
    if (/staz/.test(k)) return 'staza';
    if (/shk|stair/.test(k)) return 'shkallore';
    return 'tepiha';
  }

  /* ---------- add one piece to UI (with photo) ---------- */
  function addPiece(kind, m2, photo) {
    if (typeof window.addRow === 'function') window.addRow(kind, (m2 == null ? '' : m2));
    var listEl = $('#list-' + kind);
    var row = listEl && listEl.lastElementChild;
    if (!row) return;
    var inp = row.querySelector('.m2');
    if (inp) inp.value = (m2 == null ? '' : String(m2));
    if (photo) setRowPhoto(row, photo);
  }

  /* ---------- main ---------- */
  (async function init() {
    var qId = qs('id');
    var qCode = digits(qs('code') || '');
    if (!qId && !qCode) return;

    await waitReady();

    // fetch order (prefer by id; else by code -> the latest non-'gati')
    async function fetchOrder() {
      if (qId) {
        var byId = await window.select('orders', { id: 'eq.' + qId, limit: '1' });
        if (Array.isArray(byId) && byId.length) return byId[0];
      }
      if (qCode) {
        var rows = await window.select('orders', { code: 'eq.' + qCode, order: 'created_at.desc' });
        rows = Array.isArray(rows) ? rows : [];
        for (var i = 0; i < rows.length; i++) {
          if (String(rows[i].status || '').toLowerCase() !== 'gati') return rows[i];
        }
        return rows[0] || null;
      }
      return null;
    }

    var order = null;
    try { order = await fetchOrder(); } catch (_) { order = null; }
    if (!order) return;

    /* ----- HARD-LOCK EDIT MODE & CODE ----- */
    window.pranimiMode = 'edit';
    window.currentOrderId = order.id;
    window.assignedCode = String(order.code || '');
    // ensureCode() must NEVER regenerate while editing
    window.ensureCode = function () { return Promise.resolve(window.assignedCode); };

    // badge
    try {
      var b = $('#ticketCode') || document.querySelector('.badge.kodi');
      if (b && window.assignedCode) { b.dataset.code = window.assignedCode; b.textContent = 'KODI: ' + window.assignedCode; }
    } catch (_) {}

    /* ----- basics ----- */
    try {
      if ($('#name')) $('#name').value = order.name || '';
      if ($('#phone')) $('#phone').value = order.phone || '';
      var ppm2 = Number(order.price_per_m2 || 0);
      if (isFinite(ppm2) && ppm2 > 0) try { localStorage.setItem('price_per_m2', String(ppm2)); } catch (_) {}
    } catch (_) {}

    /* ----- items (m2) ----- */
    var items = [];
    try {
      var it = await window.select('order_items', { order_id: 'eq.' + (order.id || ''), order: 'created_at.asc' });
      if (Array.isArray(it) && it.length) {
        items = it.map(function (x) { return { kind: normKind(x.kind), m2: Number(x.m2 || 0), photo: null }; });
      }
    } catch (_) {}

    /* ----- photos from orders.snap_items (and remember them for save fallback) ----- */
    var snap = order.snap_items || order.items_json || order.pieces_json || null;
    try { if (typeof snap === 'string') snap = JSON.parse(snap); } catch (_) {}
    window.prevSnap = Array.isArray(snap) ? snap.slice() : [];

    if (Array.isArray(snap) && snap.length) {
      if (items.length) {
        // merge photos into existing item rows (best-effort by kind order)
        var used = { tepiha: 0, staza: 0, shkallore: 0 };
        for (var i = 0; i < items.length; i++) {
          var k = items[i].kind;
          // find the next photo of same kind
          var count = 0, found = null;
          for (var j = 0; j < snap.length; j++) {
            if (normKind(snap[j].kind) === k) {
              if (count === used[k]) { found = snap[j]; break; }
              count++;
            }
          }
          if (found && (found.photo || found.photo_url)) {
            items[i].photo = found.photo || found.photo_url;
            used[k] = used[k] + 1;
          }
        }
      } else {
        // no order_items (e.g., old orders) — render directly from snap
        items = snap.map(function (x) {
          return { kind: normKind(x.kind), m2: Number(x.m2 || 0), photo: (x.photo || x.photo_url || null) };
        });
      }
    }

    /* ----- render (with photos!) ----- */
    if (items && items.length) {
      items.forEach(function (p) { addPiece(p.kind, p.m2, p.photo || null); }); // ← photos pushed into UI
      if (typeof window.recalcTotals === 'function') window.recalcTotals();
    }
  })();
})();