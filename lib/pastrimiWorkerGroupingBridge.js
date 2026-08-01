const TOOLBAR_ID = 'tepiha-pastrimi-worker-toolbar-v1';
const STYLE_ID = 'tepiha-pastrimi-worker-style-v1';
const FILTER_KEY = 'tepiha_pastrimi_worker_filter_v1';

const GROUPS = {
  all: { label: 'TE GJITHA', order: 0 },
  blerim: { label: 'BLERIM', order: 100 },
  tapin: { label: 'TAPIN', order: 200 },
  baza: { label: 'BAZA', order: 300 },
};

let activeFilter = 'all';
let observer = null;
let intervalId = null;
let scheduled = false;
let installed = false;

function isPastrimiPath() {
  try {
    const path = String(window.location?.pathname || '').replace(/\/+$/, '') || '/';
    return path === '/pastrimi';
  } catch {
    return false;
  }
}

function readFilter() {
  try {
    const value = String(window.localStorage?.getItem(FILTER_KEY) || 'all').trim().toLowerCase();
    return GROUPS[value] ? value : 'all';
  } catch {
    return 'all';
  }
}

function saveFilter(value) {
  try { window.localStorage?.setItem(FILTER_KEY, value); } catch {}
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    html.tepiha-pastrimi-worker-toolbar-active #root .wrap {
      padding-top: calc(76px + env(safe-area-inset-top, 0px)) !important;
    }
    #${TOOLBAR_ID} {
      position: fixed;
      z-index: 2147482000;
      top: max(6px, env(safe-area-inset-top, 6px));
      left: 50%;
      transform: translateX(-50%);
      width: min(720px, calc(100vw - 14px));
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      padding: 7px;
      box-sizing: border-box;
      border-radius: 15px;
      border: 1px solid rgba(148,163,184,.28);
      background: rgba(2,6,23,.94);
      box-shadow: 0 12px 38px rgba(0,0,0,.48);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
    }
    #${TOOLBAR_ID} button {
      min-width: 0;
      min-height: 42px;
      border-radius: 10px;
      padding: 5px 3px;
      border: 1px solid rgba(148,163,184,.22);
      background: rgba(15,23,42,.82);
      color: rgba(226,232,240,.82);
      font-size: 10.5px;
      line-height: 1.08;
      font-weight: 1000;
      cursor: pointer;
    }
    #${TOOLBAR_ID} button[data-filter="blerim"] { color: #bae6fd; }
    #${TOOLBAR_ID} button[data-filter="tapin"] { color: #e9d5ff; }
    #${TOOLBAR_ID} button[data-filter="baza"] { color: #bbf7d0; }
    #${TOOLBAR_ID} button[data-active="1"][data-filter="all"] {
      background: rgba(71,85,105,.72); border-color: rgba(203,213,225,.72); color: #fff;
    }
    #${TOOLBAR_ID} button[data-active="1"][data-filter="blerim"] {
      background: rgba(2,132,199,.38); border-color: rgba(56,189,248,.88); color: #fff;
    }
    #${TOOLBAR_ID} button[data-active="1"][data-filter="tapin"] {
      background: rgba(126,34,206,.38); border-color: rgba(192,132,252,.88); color: #fff;
    }
    #${TOOLBAR_ID} button[data-active="1"][data-filter="baza"] {
      background: rgba(22,101,52,.42); border-color: rgba(74,222,128,.88); color: #fff;
    }
    #root .list-item-compact[data-pastrimi-worker-group] {
      position: relative !important;
      box-sizing: border-box !important;
      padding: 27px 7px 8px 9px !important;
      margin-bottom: 7px !important;
      border-radius: 12px !important;
      border-bottom: 1px solid rgba(255,255,255,.10) !important;
      overflow: hidden !important;
    }
    #root .list-item-compact[data-pastrimi-group-first="1"] {
      margin-top: 13px !important;
    }
    #root .list-item-compact[data-pastrimi-worker-group]::before {
      position: absolute;
      top: 5px;
      right: 7px;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 9px;
      line-height: 1.1;
      font-weight: 1000;
      letter-spacing: .06em;
    }
    #root .list-item-compact[data-pastrimi-worker-group="blerim"] {
      border-left: 5px solid #38bdf8 !important;
      background: linear-gradient(90deg, rgba(2,132,199,.22), rgba(15,23,42,.36)) !important;
      box-shadow: inset 0 0 0 1px rgba(56,189,248,.14);
    }
    #root .list-item-compact[data-pastrimi-worker-group="blerim"]::before {
      content: 'BLERIM'; color: #e0f2fe; border: 1px solid rgba(56,189,248,.58); background: rgba(2,132,199,.40);
    }
    #root .list-item-compact[data-pastrimi-worker-group="tapin"] {
      border-left: 5px solid #c084fc !important;
      background: linear-gradient(90deg, rgba(126,34,206,.22), rgba(15,23,42,.36)) !important;
      box-shadow: inset 0 0 0 1px rgba(192,132,252,.14);
    }
    #root .list-item-compact[data-pastrimi-worker-group="tapin"]::before {
      content: 'TAPIN'; color: #f3e8ff; border: 1px solid rgba(192,132,252,.58); background: rgba(126,34,206,.40);
    }
    #root .list-item-compact[data-pastrimi-worker-group="baza"] {
      border-left: 5px solid #4ade80 !important;
      background: linear-gradient(90deg, rgba(22,101,52,.18), rgba(15,23,42,.32)) !important;
      box-shadow: inset 0 0 0 1px rgba(74,222,128,.11);
    }
    #root .list-item-compact[data-pastrimi-worker-group="baza"]::before {
      content: 'BAZA'; color: #dcfce7; border: 1px solid rgba(74,222,128,.52); background: rgba(22,101,52,.42);
    }
    #root .list-item-compact[data-pastrimi-worker-group="blerim"] > div:first-child > div:first-child > div:first-child {
      background: #0284c7 !important;
    }
    #root .list-item-compact[data-pastrimi-worker-group="tapin"] > div:first-child > div:first-child > div:first-child {
      background: #7e22ce !important;
    }
    #root .list-item-compact[data-pastrimi-worker-group="baza"] > div:first-child > div:first-child > div:first-child {
      background: #15803d !important;
    }
  `;
  document.head.appendChild(style);
}

function detectGroup(card) {
  const text = String(card?.innerText || card?.textContent || '').toUpperCase();
  const markerIndex = text.indexOf('E SOLLI:');
  if (markerIndex >= 0) {
    const after = text.slice(markerIndex + 'E SOLLI:'.length);
    const broughtBy = after.split('📍')[0].split('PAKETO')[0].slice(0, 90);
    if (broughtBy.includes('BLERIM') || broughtBy.includes('KOSUMI') || broughtBy.includes('BELI')) return 'blerim';
    if (broughtBy.includes('TAPIN') || broughtBy.includes('LEPAJA')) return 'tapin';
  }
  return 'baza';
}

function getCards() {
  try {
    return Array.from(document.querySelectorAll('#root .list-item-compact'));
  } catch {
    return [];
  }
}

function ensureToolbar(counts) {
  let toolbar = document.getElementById(TOOLBAR_ID);
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Filtro porosite ne pastrim sipas punetorit');
    Object.entries(GROUPS).forEach(([key, cfg]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.filter = key;
      button.addEventListener('click', () => {
        activeFilter = key;
        saveFilter(key);
        scheduleApply();
      });
      const label = document.createElement('span');
      label.dataset.role = 'label';
      label.textContent = cfg.label;
      const count = document.createElement('span');
      count.dataset.role = 'count';
      count.style.display = 'block';
      count.style.marginTop = '3px';
      count.style.fontSize = '9px';
      count.style.opacity = '.82';
      button.append(label, count);
      toolbar.appendChild(button);
    });
    document.body.appendChild(toolbar);
  }

  toolbar.querySelectorAll('button[data-filter]').forEach((button) => {
    const key = String(button.dataset.filter || 'all');
    button.dataset.active = activeFilter === key ? '1' : '0';
    button.setAttribute('aria-pressed', activeFilter === key ? 'true' : 'false');
    const count = button.querySelector('[data-role="count"]');
    if (count) count.textContent = `${Number(counts?.[key] || 0)} POROSI`;
  });
}

function clearPageDecorations() {
  try { document.documentElement.classList.remove('tepiha-pastrimi-worker-toolbar-active'); } catch {}
  try { document.getElementById(TOOLBAR_ID)?.remove(); } catch {}
  getCards().forEach((card) => {
    try {
      card.removeAttribute('data-pastrimi-worker-group');
      card.removeAttribute('data-pastrimi-group-first');
      card.removeAttribute('aria-hidden');
      card.style.removeProperty('order');
      card.style.removeProperty('display');
    } catch {}
  });
}

function applyGrouping() {
  if (!isPastrimiPath()) {
    clearPageDecorations();
    return;
  }

  ensureStyle();
  try { document.documentElement.classList.add('tepiha-pastrimi-worker-toolbar-active'); } catch {}

  const cards = getCards();
  const counts = { all: cards.length, blerim: 0, tapin: 0, baza: 0 };
  const firstSeen = new Set();
  const parents = new Set();

  cards.forEach((card) => {
    const group = detectGroup(card);
    const cfg = GROUPS[group] || GROUPS.baza;
    counts[group] += 1;
    card.dataset.pastrimiWorkerGroup = group;
    card.style.setProperty('order', String(cfg.order), 'important');
    card.setAttribute('aria-hidden', activeFilter !== 'all' && activeFilter !== group ? 'true' : 'false');
    if (activeFilter !== 'all' && activeFilter !== group) card.style.setProperty('display', 'none', 'important');
    else card.style.setProperty('display', 'flex', 'important');

    if (!firstSeen.has(group)) {
      card.dataset.pastrimiGroupFirst = '1';
      firstSeen.add(group);
    } else {
      card.removeAttribute('data-pastrimi-group-first');
    }

    if (card.parentElement) parents.add(card.parentElement);
  });

  parents.forEach((parent) => {
    try {
      parent.style.setProperty('display', 'flex');
      parent.style.setProperty('flex-direction', 'column');
    } catch {}
  });

  ensureToolbar(counts);
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    try { applyGrouping(); } catch {}
  };
  try { window.requestAnimationFrame(run); } catch { window.setTimeout(run, 0); }
}

export function installPastrimiWorkerGroupingBridge() {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  activeFilter = readFilter();
  ensureStyle();

  try {
    observer = new MutationObserver(() => scheduleApply());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    observer = null;
  }

  try { window.addEventListener('popstate', scheduleApply, { passive: true }); } catch {}
  try { window.addEventListener('tepiha:route-ui-alive', scheduleApply, { passive: true }); } catch {}
  try { window.addEventListener('tepiha:first-ui-ready', scheduleApply, { passive: true }); } catch {}
  try { intervalId = window.setInterval(scheduleApply, 900); } catch { intervalId = null; }
  try { window.__TEPIHA_PASTRIMI_WORKER_GROUPING__ = { version: 'v1', scheduleApply }; } catch {}
  scheduleApply();
}
